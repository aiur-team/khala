import {
  type AgentBindingAuthority,
  type HarnessCapabilities,
  type ListeningModeCommand,
  type ListeningModeControl,
  type ListeningModeResult,
  type ListeningModeView,
  type ModeSupportMap,
  type OwnerAuthority,
  type OwnerRouteGrantCommand,
  type RouteGrant,
  type SessionBinding,
  initialListeningMode,
  routeGrantMatches,
  unknownModeSupportMap,
} from '@khala/contracts/delivery/index';

export type ListeningModeStoreKey = Pick<ListeningModeControl, 'bindingId' | 'generation'>;

export type ListeningModeStoreRead =
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'record'; control: ListeningModeControl }>
  | Readonly<{ kind: 'unavailable' }>;

export type ListeningModeStoreNext = Pick<
  ListeningModeControl,
  'requested' | 'experimentalGrants' | 'hardCancelGrants'
>;

export type ListeningModeStoreWrite = Readonly<{
  key: ListeningModeStoreKey;
  expectedVersion: number | null;
  operationId: string;
  /** Stable identity of the caller command; identical retries keep this exact value. */
  operationFingerprint: string;
  next: ListeningModeStoreNext;
}>;

export type ListeningModeWriteResult =
  | Readonly<{ kind: 'applied'; control: ListeningModeControl }>
  | Readonly<{ kind: 'conflict'; current: ListeningModeControl | null }>
  | Readonly<{ kind: 'idempotency_conflict' }>
  | Readonly<{ kind: 'unavailable' }>;

export type ListeningModeSettledWriteResult = Extract<
  ListeningModeWriteResult,
  Readonly<{ kind: 'applied' | 'conflict' }>
>;

/** Settled operation retained so retries return their original result. */
export type ListeningModeOperationEntry = Readonly<{
  operationFingerprint: string;
  result: ListeningModeSettledWriteResult;
}>;

/** One exact-key CAS port implemented by hosted TrustState and local SQLite. */
export interface ListeningModeStore {
  read(key: ListeningModeStoreKey): Promise<ListeningModeStoreRead>;
  compareAndSet(write: ListeningModeStoreWrite): Promise<ListeningModeWriteResult>;
}

export type ListeningModeBindingContext = Readonly<{
  binding: SessionBinding;
  status: 'active' | 'revoked';
}>;

export type ListeningModeReadResult =
  | Readonly<{ ok: true; view: ListeningModeView }>
  | Readonly<{ ok: false; code: 'forbidden' | 'binding_mismatch' | 'stale_binding' | 'binding_revoked' | 'unavailable' }>;

export type ListeningModeGrantResult =
  | Readonly<{ outcome: 'applied' | 'conflict'; view: ListeningModeView; reason: string | null }>
  | Readonly<{ outcome: 'refused'; reason: string }>;

export type ListeningModeAuthority = OwnerAuthority | AgentBindingAuthority;

const unavailableModes = () => unknownModeSupportMap(
  'capabilities-unavailable',
  'Current harness capabilities are unavailable.',
);

function keyFor(binding: SessionBinding): ListeningModeStoreKey {
  return { bindingId: binding.bindingId, generation: binding.generation };
}

function nextOf(control: ListeningModeControl): ListeningModeStoreNext {
  return {
    requested: control.requested,
    experimentalGrants: control.experimentalGrants,
    hardCancelGrants: control.hardCancelGrants,
  };
}

function modesOf(capabilities: HarnessCapabilities | null): ModeSupportMap {
  return capabilities?.modes ?? unavailableModes();
}

export function initialListeningModeControl(
  binding: Pick<SessionBinding, 'bindingId' | 'generation'>,
  capabilities: HarnessCapabilities | null,
): ListeningModeControl {
  return {
    bindingId: binding.bindingId,
    generation: binding.generation,
    requested: initialListeningMode(modesOf(capabilities)).requested,
    version: 1,
    experimentalGrants: [],
    hardCancelGrants: [],
  };
}

export function listeningModeView(
  control: ListeningModeControl,
  capabilities: HarnessCapabilities | null,
): ListeningModeView {
  const support = modesOf(capabilities);
  if (capabilities === null) {
    return { ...control, effective: null, effectiveReason: 'capabilities_unavailable', support };
  }

  const selected = support[control.requested];
  if (selected.status !== 'proven' && selected.status !== 'experimental') {
    return { ...control, effective: null, effectiveReason: `support_${selected.status}`, support };
  }
  if (control.requested === 'async' && capabilities.acknowledgement !== 'batch_token_next_call') {
    return { ...control, effective: null, effectiveReason: 'acknowledgement_unavailable', support };
  }
  if (selected.status === 'experimental') {
    const granted = control.experimentalGrants.some(grant => routeGrantMatches(grant, {
      bindingId: control.bindingId,
      generation: control.generation,
      grantRevision: grant.grantRevision,
      mode: control.requested,
      expectedKind: 'experimental_route',
      support: selected,
    }));
    if (!granted) return { ...control, effective: null, effectiveReason: 'experimental_grant_required', support };
  }
  return { ...control, effective: control.requested, effectiveReason: null, support };
}

function isAgentAuthority(authority: ListeningModeAuthority): authority is AgentBindingAuthority {
  return (authority as Partial<AgentBindingAuthority>).kind === 'agent_binding';
}

function authorize(
  authority: ListeningModeAuthority,
  context: ListeningModeBindingContext,
): Exclude<ListeningModeReadResult, { ok: true }> | null {
  if (context.status !== 'active') return { ok: false, code: 'binding_revoked' };
  if (isAgentAuthority(authority)) {
    if (authority.bindingId !== context.binding.bindingId) return { ok: false, code: 'binding_mismatch' };
    if (authority.generation !== context.binding.generation) return { ok: false, code: 'stale_binding' };
    return null;
  }
  if (typeof authority.ownerId !== 'string' || authority.ownerId !== context.binding.ownerId) {
    return { ok: false, code: 'forbidden' };
  }
  return null;
}

function authorizeOwner(
  authority: OwnerAuthority,
  context: ListeningModeBindingContext,
): string | null {
  if ((authority as Partial<AgentBindingAuthority>).kind === 'agent_binding') return 'forbidden';
  if (context.status !== 'active') return 'binding_revoked';
  if (typeof authority.ownerId !== 'string' || authority.ownerId !== context.binding.ownerId) return 'forbidden';
  return null;
}

async function ensureControl(
  store: ListeningModeStore,
  binding: SessionBinding,
  capabilities: HarnessCapabilities | null,
): Promise<ListeningModeStoreRead> {
  const key = keyFor(binding);
  const existing = await store.read(key);
  if (existing.kind !== 'absent') return existing;
  const initial = initialListeningModeControl(binding, capabilities);
  const created = await store.compareAndSet({
    key,
    expectedVersion: null,
    operationId: `listening-mode:init:${binding.bindingId}:${binding.generation}`,
    operationFingerprint: JSON.stringify([key, initial.requested]),
    next: nextOf(initial),
  });
  if (created.kind === 'applied') return { kind: 'record', control: created.control };
  if (created.kind === 'unavailable' || created.kind === 'idempotency_conflict') return { kind: 'unavailable' };
  if (created.current) return { kind: 'record', control: created.current };
  return store.read(key);
}

export function refusedListeningModeResult(command: ListeningModeCommand, reason: string): ListeningModeResult {
  return {
    v: 1,
    commandId: command.commandId,
    bindingId: command.bindingId,
    generation: command.expectedBindingGeneration,
    outcome: 'refused',
    version: command.expectedVersion,
    requested: command.requested,
    effective: null,
    reason,
  };
}

function listeningModeCommandFingerprint(command: ListeningModeCommand): string {
  return JSON.stringify([
    command.v,
    command.commandId,
    command.bindingId,
    command.expectedBindingGeneration,
    command.expectedVersion,
    command.requested,
    command.issuedAt,
  ]);
}

function routeGrantCommandFingerprint(command: OwnerRouteGrantCommand): string {
  return JSON.stringify([
    command.v,
    command.kind,
    command.commandId,
    command.bindingId,
    command.expectedBindingGeneration,
    command.expectedVersion,
    command.mode,
    command.route,
    command.harnessVersion,
    command.evidenceRevision,
    command.issuedAt,
  ]);
}

function commandResult(
  command: ListeningModeCommand,
  outcome: 'applied' | 'conflict',
  view: ListeningModeView,
): ListeningModeResult {
  return {
    v: 1,
    commandId: command.commandId,
    bindingId: view.bindingId,
    generation: view.generation,
    outcome,
    version: view.version,
    requested: view.requested,
    effective: view.effective,
    reason: view.effectiveReason,
  };
}

function sameGrantIdentity(a: RouteGrant, b: Omit<RouteGrant, 'v' | 'grantRevision'>): boolean {
  return a.kind === b.kind
    && a.bindingId === b.bindingId
    && a.generation === b.generation
    && a.mode === b.mode
    && a.route === b.route
    && a.harnessVersion === b.harnessVersion
    && a.evidenceRevision === b.evidenceRevision;
}

function matchesExperimentalGrantCapability(
  capabilities: HarnessCapabilities | null,
  command: OwnerRouteGrantCommand,
): boolean {
  if (capabilities === null) return false;
  const support = capabilities.modes[command.mode];
  return support.status === 'experimental'
    && support.route === command.route
    && support.testedVersion === command.harnessVersion
    && support.evidenceRevision === command.evidenceRevision;
}

export function createListeningModeService(store: ListeningModeStore) {
  async function read(
    authority: ListeningModeAuthority,
    context: ListeningModeBindingContext,
    capabilities: HarnessCapabilities | null,
  ): Promise<ListeningModeReadResult> {
    const rejection = authorize(authority, context);
    if (rejection) return rejection;
    const current = await ensureControl(store, context.binding, capabilities);
    if (current.kind !== 'record') return { ok: false, code: 'unavailable' };
    return { ok: true, view: listeningModeView(current.control, capabilities) };
  }

  async function set(
    authority: ListeningModeAuthority,
    context: ListeningModeBindingContext,
    capabilities: HarnessCapabilities | null,
    command: ListeningModeCommand,
  ): Promise<ListeningModeResult> {
    const rejection = authorize(authority, context);
    if (rejection) return refusedListeningModeResult(command, rejection.code);
    if (command.bindingId !== context.binding.bindingId) return refusedListeningModeResult(command, 'binding_mismatch');
    if (command.expectedBindingGeneration !== context.binding.generation) return refusedListeningModeResult(command, 'stale_binding');
    const current = await ensureControl(store, context.binding, capabilities);
    if (current.kind !== 'record') return refusedListeningModeResult(command, 'unavailable');

    const result = await store.compareAndSet({
      key: keyFor(context.binding),
      expectedVersion: command.expectedVersion,
      operationId: command.commandId,
      operationFingerprint: listeningModeCommandFingerprint(command),
      next: { ...nextOf(current.control), requested: command.requested },
    });
    if (result.kind === 'applied') return commandResult(command, 'applied', listeningModeView(result.control, capabilities));
    if (result.kind === 'conflict') {
      const control = result.current ?? current.control;
      return commandResult(command, 'conflict', listeningModeView(control, capabilities));
    }
    return refusedListeningModeResult(
      command,
      result.kind === 'idempotency_conflict' ? 'idempotency_conflict' : 'unavailable',
    );
  }

  async function changeGrant(
    authority: OwnerAuthority,
    context: ListeningModeBindingContext,
    capabilities: HarnessCapabilities | null,
    command: OwnerRouteGrantCommand,
    expectedCommandKind: OwnerRouteGrantCommand['kind'],
    grantKind: RouteGrant['kind'],
    action: 'grant' | 'revoke',
  ): Promise<ListeningModeGrantResult> {
    const rejection = authorizeOwner(authority, context);
    if (rejection) return { outcome: 'refused', reason: rejection };
    if (command.kind !== expectedCommandKind) return { outcome: 'refused', reason: 'command_kind_mismatch' };
    if (command.bindingId !== context.binding.bindingId) return { outcome: 'refused', reason: 'binding_mismatch' };
    if (command.expectedBindingGeneration !== context.binding.generation) return { outcome: 'refused', reason: 'stale_binding' };
    if (
      action === 'grant'
      && grantKind === 'experimental_route'
      && !matchesExperimentalGrantCapability(capabilities, command)
    ) return { outcome: 'refused', reason: 'capability_mismatch' };
    const current = await ensureControl(store, context.binding, capabilities);
    if (current.kind !== 'record') return { outcome: 'refused', reason: 'unavailable' };

    const identity = {
      kind: grantKind,
      bindingId: context.binding.bindingId,
      generation: context.binding.generation,
      mode: command.mode,
      route: command.route,
      harnessVersion: command.harnessVersion,
      evidenceRevision: command.evidenceRevision,
    } as const;
    const field = grantKind === 'experimental_route' ? 'experimentalGrants' : 'hardCancelGrants';
    const existing = current.control[field];
    const grants = action === 'grant'
      ? [...existing.filter(grant => !sameGrantIdentity(grant, identity)), {
        v: 1 as const,
        ...identity,
        grantRevision: command.expectedVersion + 1,
      }]
      : existing.filter(grant => !sameGrantIdentity(grant, identity));
    const next = {
      ...nextOf(current.control),
      [field]: grants,
    } as ListeningModeStoreNext;
    const result = await store.compareAndSet({
      key: keyFor(context.binding),
      expectedVersion: command.expectedVersion,
      operationId: command.commandId,
      operationFingerprint: routeGrantCommandFingerprint(command),
      next,
    });
    if (result.kind === 'applied') {
      return { outcome: 'applied', view: listeningModeView(result.control, capabilities), reason: null };
    }
    if (result.kind === 'conflict') {
      return {
        outcome: 'conflict',
        view: listeningModeView(result.current ?? current.control, capabilities),
        reason: 'stale_version',
      };
    }
    return { outcome: 'refused', reason: result.kind === 'idempotency_conflict' ? 'idempotency_conflict' : 'unavailable' };
  }

  return {
    read,
    set,
    grantExperimentalRoute: (
      authority: OwnerAuthority,
      context: ListeningModeBindingContext,
      capabilities: HarnessCapabilities | null,
      command: OwnerRouteGrantCommand,
    ) => changeGrant(authority, context, capabilities, command, 'grant_experimental_route', 'experimental_route', 'grant'),
    revokeExperimentalRoute: (
      authority: OwnerAuthority,
      context: ListeningModeBindingContext,
      capabilities: HarnessCapabilities | null,
      command: OwnerRouteGrantCommand,
    ) => changeGrant(authority, context, capabilities, command, 'revoke_experimental_route', 'experimental_route', 'revoke'),
    grantHardCancel: (
      authority: OwnerAuthority,
      context: ListeningModeBindingContext,
      capabilities: HarnessCapabilities | null,
      command: OwnerRouteGrantCommand,
    ) => changeGrant(authority, context, capabilities, command, 'grant_hard_cancel', 'hard_cancel', 'grant'),
    revokeHardCancel: (
      authority: OwnerAuthority,
      context: ListeningModeBindingContext,
      capabilities: HarnessCapabilities | null,
      command: OwnerRouteGrantCommand,
    ) => changeGrant(authority, context, capabilities, command, 'revoke_hard_cancel', 'hard_cancel', 'revoke'),
  };
}

export type ListeningModeService = ReturnType<typeof createListeningModeService>;
