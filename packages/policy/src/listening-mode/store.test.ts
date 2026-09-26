import type {
  AgentBindingAuthority,
  AuthorizationId,
  BindingId,
  CommandId,
  DeliveryLimits,
  DeviceId,
  HarnessCapabilities,
  ListeningModeCommand,
  ListeningModeControl,
  OwnerId,
  OwnerAuthority,
  OwnerRouteGrantCommand,
  ParticipantId,
  SessionBinding,
} from '@khala/contracts/delivery/index';
import { describe, expect, it } from 'vitest';
import { listeningModeStoreConformance } from '../../test/fixtures/listening-mode/conformance';
import {
  createListeningModeService,
  type ListeningModeStore,
  type ListeningModeStoreWrite,
  type ListeningModeWriteResult,
} from './store';

const binding = (generation = 2): SessionBinding => ({
  v: 1,
  bindingId: 'binding-1' as BindingId,
  ownerId: 'owner-1' as OwnerId,
  agentParticipantId: 'agent-1' as ParticipantId,
  deviceId: 'device-1' as DeviceId,
  harness: 'codex',
  sessionId: 'session-1',
  generation,
});

const support = (status: 'proven' | 'experimental' = 'proven') => ({
  status,
  route: 'codex-hooks-sync',
  testedVersion: '0.154.0',
  evidenceRef: 'docs/evidence/codex-hooks.md',
  evidenceRevision: 'codex-hooks-v1',
  reason: status === 'experimental' ? 'Owner consent required.' : null,
} as const);

const capabilities = (status: 'proven' | 'experimental' = 'proven'): HarnessCapabilities => ({
  v: 3,
  harness: 'codex',
  version: '0.154.0',
  adapterVersion: 'hooks-1',
  support: 'tested',
  existingSession: 'native_cli_queue',
  immediateNotification: 'native_cli_queue',
  busy: 'queue',
  receiptEvidence: ['harness_queued'],
  reconcileByReleaseId: 'unsupported',
  limits: { maxSelectionEvents: 32, maxPayloadBytes: 65_536 } as DeliveryLimits,
  evidenceRef: 'docs/evidence/codex-hooks.md',
  modes: {
    steer: { ...support(), route: 'codex-hooks-steer' },
    sync: support(status),
    async: { ...support(), route: 'codex-pull' },
  },
  acknowledgement: 'batch_token_next_call',
});

const owner = (): OwnerAuthority => ({
  ownerId: 'owner-1' as OwnerId,
  issuer: 'https://issuer.example',
  subject: 'owner-subject',
  authenticatedAt: '2026-09-24T12:00:00Z',
  authorizationId: 'authorization-1' as AuthorizationId,
});

const agent = (generation = 2): AgentBindingAuthority => ({
  kind: 'agent_binding', bindingId: 'binding-1' as BindingId, generation,
} as AgentBindingAuthority);

const modeCommand = (overrides: Partial<ListeningModeCommand> = {}): ListeningModeCommand => ({
  v: 1,
  commandId: 'mode-command-1' as CommandId,
  bindingId: 'binding-1' as BindingId,
  expectedBindingGeneration: 2,
  expectedVersion: 1,
  requested: 'sync',
  issuedAt: '2026-09-24T12:00:00Z',
  ...overrides,
});

const grantCommand = (
  kind: OwnerRouteGrantCommand['kind'],
  overrides: Partial<OwnerRouteGrantCommand> = {},
): OwnerRouteGrantCommand => ({
  v: 1,
  kind,
  commandId: `command-${kind}` as CommandId,
  bindingId: 'binding-1' as BindingId,
  expectedBindingGeneration: 2,
  expectedVersion: 1,
  mode: 'sync',
  route: 'codex-hooks-sync',
  harnessVersion: '0.154.0',
  evidenceRevision: 'codex-hooks-v1',
  issuedAt: '2026-09-24T12:00:00Z',
  ...overrides,
});

function memoryStore(initial?: ListeningModeControl): ListeningModeStore {
  const records = new Map<string, ListeningModeControl>();
  const operations = new Map<string, Readonly<{ write: ListeningModeStoreWrite; result: ListeningModeWriteResult }>>();
  const keyOf = (key: Readonly<{ bindingId: string; generation: number }>) => `${key.bindingId}:${key.generation}`;
  if (initial) records.set(keyOf(initial), initial);
  return {
    async read(key) {
      const control = records.get(keyOf(key));
      return control ? { kind: 'record', control } : { kind: 'absent' };
    },
    async compareAndSet(write) {
      const prior = operations.get(write.operationId);
      if (prior) return prior.write.operationFingerprint === write.operationFingerprint
        ? prior.result
        : { kind: 'idempotency_conflict' };
      const key = keyOf(write.key);
      const current = records.get(key) ?? null;
      if ((current?.version ?? null) !== write.expectedVersion) {
        const result = { kind: 'conflict' as const, current };
        operations.set(write.operationId, { write, result });
        return result;
      }
      const control: ListeningModeControl = {
        ...write.key,
        ...write.next,
        version: (current?.version ?? 0) + 1,
      };
      records.set(key, control);
      const result = { kind: 'applied' as const, control };
      operations.set(write.operationId, { write, result });
      return result;
    },
  };
}

const conformanceInitial = (): ListeningModeControl => ({
  bindingId: binding().bindingId,
  generation: binding().generation,
  requested: 'sync',
  version: 1,
  experimentalGrants: [],
  hardCancelGrants: [],
  lastChangedBy: { kind: 'unknown' },
});

listeningModeStoreConformance('memory', () => {
  const initial = conformanceInitial();
  return {
    store: memoryStore(initial),
    key: { bindingId: initial.bindingId, generation: initial.generation },
    initial,
  };
});

describe('listening-mode service', () => {
  it('initializes once and fails closed when capabilities are unavailable', async () => {
    const service = createListeningModeService(memoryStore());
    const result = await service.read(agent(), { binding: binding(), status: 'active' }, null);

    expect(result).toMatchObject({
      ok: true,
      view: { requested: 'sync', version: 1, effective: null, effectiveReason: 'capabilities_unavailable' },
    });
  });

  it('stores no requested mode for a harness with no proven or experimental mode', async () => {
    const unknown = (route: string) => ({
      status: 'unknown', route, evidenceRef: null, evidenceRevision: null, reason: 'No evidence.',
    } as const);
    const unevidenced: HarnessCapabilities = {
      ...capabilities(),
      modes: { steer: unknown('cursor-steer'), sync: unknown('cursor-sync'), async: unknown('cursor-async') },
    };
    const service = createListeningModeService(memoryStore());
    const context = { binding: binding(), status: 'active' as const };

    expect(await service.read(agent(), context, unevidenced)).toMatchObject({
      ok: true,
      view: { requested: null, version: 1, effective: null, effectiveReason: 'no_requested_mode' },
    });

    const chosen = await service.set(owner(), context, capabilities(), modeCommand({ requested: 'steer', expectedVersion: 1 }));
    expect(chosen).toMatchObject({ outcome: 'applied', version: 2, requested: 'steer', effective: 'steer' });
  });

  it('gives owner and exact agent authority the same set path', async () => {
    const ownerService = createListeningModeService(memoryStore());
    const agentService = createListeningModeService(memoryStore());
    const context = { binding: binding(), status: 'active' as const };

    const ownerResult = await ownerService.set(owner(), context, capabilities(), modeCommand({ requested: 'steer' }));
    const agentResult = await agentService.set(agent(), context, capabilities(), modeCommand({ requested: 'steer' }));

    expect(agentResult).toEqual(ownerResult);
    expect(agentResult).toMatchObject({ outcome: 'applied', version: 2, requested: 'steer', effective: 'steer' });
  });

  it.each([
    ['unknown', null, 'acknowledgement_unavailable'],
    ['unsupported', null, 'acknowledgement_unavailable'],
    ['batch_token_next_call', 'async', null],
  ] as const)(
    'projects requested async with %s acknowledgement',
    async (acknowledgement, effective, effectiveReason) => {
      const service = createListeningModeService(memoryStore());
      const currentCapabilities: HarnessCapabilities = { ...capabilities(), acknowledgement };

      await expect(service.set(
        agent(),
        { binding: binding(), status: 'active' },
        currentCapabilities,
        modeCommand({ requested: 'async' }),
      )).resolves.toMatchObject({ outcome: 'applied', requested: 'async', effective, reason: effectiveReason });
    },
  );

  it('records the actor from the verified authority and ignores a claimed actor in input', async () => {
    const store = memoryStore();
    const service = createListeningModeService(store);
    const context = { binding: binding(), status: 'active' as const };
    const key = { bindingId: binding().bindingId, generation: 2 };

    const initial = await service.read(owner(), context, capabilities());
    expect(initial).toMatchObject({ ok: true, view: { lastChangedBy: { kind: 'unknown' } } });

    // Wrong-implementation guard: an agent whose input claims owner must still record agent.
    const forged = { ...modeCommand({ requested: 'async' }), lastChangedBy: { kind: 'owner', participantId: 'owner-1' } };
    await expect(service.set(agent(), context, capabilities(), forged as ListeningModeCommand))
      .resolves.toMatchObject({ outcome: 'applied', version: 2 });
    await expect(store.read(key)).resolves.toMatchObject({
      control: { lastChangedBy: { kind: 'agent', participantId: 'agent-1' } },
    });

    await expect(service.set(owner(), context, capabilities(), modeCommand({
      commandId: 'mode-command-2' as CommandId, expectedVersion: 2, requested: 'sync',
    }))).resolves.toMatchObject({ outcome: 'applied', version: 3 });
    await expect(service.read(agent(), context, capabilities())).resolves.toMatchObject({
      ok: true,
      view: { lastChangedBy: { kind: 'owner', participantId: 'owner-1' } },
    });
  });

  it('rejects stale, cross-binding and revoked agent authority before store access', async () => {
    let reads = 0;
    const store = memoryStore();
    const service = createListeningModeService({
      ...store,
      async read(key) { reads += 1; return store.read(key); },
    });

    await expect(service.read(agent(1), { binding: binding(), status: 'active' }, capabilities()))
      .resolves.toEqual({ ok: false, code: 'stale_binding' });
    await expect(service.read({ ...agent(), bindingId: 'binding-2' as BindingId } as AgentBindingAuthority, { binding: binding(), status: 'active' }, capabilities()))
      .resolves.toEqual({ ok: false, code: 'binding_mismatch' });
    await expect(service.read(agent(), { binding: binding(), status: 'revoked' }, capabilities()))
      .resolves.toEqual({ ok: false, code: 'binding_revoked' });
    await expect(service.read(
      { ...owner(), ownerId: 'owner-other' as OwnerId },
      { binding: binding(), status: 'active' },
      capabilities(),
    )).resolves.toEqual({ ok: false, code: 'forbidden' });
    expect(reads).toBe(0);
  });

  it('returns an identical command retry and rejects changed command-id reuse', async () => {
    const service = createListeningModeService(memoryStore());
    const context = { binding: binding(), status: 'active' as const };
    const command = modeCommand({ requested: 'steer' });

    const first = await service.set(agent(), context, capabilities(), command);
    const reordered: ListeningModeCommand = {
      issuedAt: command.issuedAt,
      requested: command.requested,
      expectedVersion: command.expectedVersion,
      expectedBindingGeneration: command.expectedBindingGeneration,
      bindingId: command.bindingId,
      commandId: command.commandId,
      v: command.v,
    };
    await expect(service.set(agent(), context, capabilities(), reordered)).resolves.toEqual(first);
    await expect(service.set(agent(), context, capabilities(), { ...command, requested: 'async' }))
      .resolves.toMatchObject({ outcome: 'refused', reason: 'idempotency_conflict' });
  });

  it('requires matching experimental consent without rewriting requested mode', async () => {
    const service = createListeningModeService(memoryStore());
    const context = { binding: binding(), status: 'active' as const };
    const experimental = capabilities('experimental');

    await expect(service.read(agent(), context, experimental)).resolves.toMatchObject({
      ok: true,
      view: { requested: 'sync', effective: null, effectiveReason: 'experimental_grant_required' },
    });
    await expect(service.grantExperimentalRoute(owner(), context, experimental, grantCommand('grant_experimental_route')))
      .resolves.toMatchObject({ outcome: 'applied', view: { requested: 'sync', effective: 'sync' } });
  });

  it.each([
    ['unavailable capabilities', null],
    ['non-experimental support', capabilities()],
    ['route drift', {
      ...capabilities('experimental'),
      modes: {
        ...capabilities('experimental').modes,
        sync: { ...capabilities('experimental').modes.sync, route: 'codex-hooks-sync-v2' },
      },
    }],
    ['harness-version drift', {
      ...capabilities('experimental'),
      modes: {
        ...capabilities('experimental').modes,
        sync: { ...capabilities('experimental').modes.sync, testedVersion: '0.155.0' },
      },
    }],
    ['evidence-revision drift', {
      ...capabilities('experimental'),
      modes: {
        ...capabilities('experimental').modes,
        sync: { ...capabilities('experimental').modes.sync, evidenceRevision: 'codex-hooks-v2' },
      },
    }],
  ] as const)('refuses experimental consent for %s before store access', async (_label, currentCapabilities) => {
    let reads = 0;
    let writes = 0;
    const base = memoryStore();
    const service = createListeningModeService({
      async read(key) { reads += 1; return base.read(key); },
      async compareAndSet(write) { writes += 1; return base.compareAndSet(write); },
    });

    await expect(service.grantExperimentalRoute(
      owner(),
      { binding: binding(), status: 'active' },
      currentCapabilities,
      grantCommand('grant_experimental_route'),
    )).resolves.toEqual({ outcome: 'refused', reason: 'capability_mismatch' });
    expect({ reads, writes }).toEqual({ reads: 0, writes: 0 });
  });

  it('invalidates consent on capability route drift without rewriting durable control', async () => {
    const service = createListeningModeService(memoryStore());
    const context = { binding: binding(), status: 'active' as const };
    const experimental = capabilities('experimental');

    await service.grantExperimentalRoute(owner(), context, experimental, grantCommand('grant_experimental_route'));
    const changedRoute: HarnessCapabilities = {
      ...experimental,
      modes: {
        ...experimental.modes,
        sync: { ...experimental.modes.sync, route: 'codex-hooks-sync-v2' },
      },
    };

    await expect(service.read(agent(), context, changedRoute)).resolves.toMatchObject({
      ok: true,
      view: {
        requested: 'sync',
        version: 2,
        effective: null,
        effectiveReason: 'experimental_grant_required',
      },
    });
  });

  it('grants and revokes experimental and hard-cancel consent independently', async () => {
    const service = createListeningModeService(memoryStore());
    const context = { binding: binding(), status: 'active' as const };
    const experimental = capabilities('experimental');

    const experimentalGranted = await service.grantExperimentalRoute(
      owner(), context, experimental, grantCommand('grant_experimental_route'),
    );
    expect(experimentalGranted).toMatchObject({
      outcome: 'applied',
      view: { experimentalGrants: [{ kind: 'experimental_route' }], hardCancelGrants: [] },
    });

    const hardCancelGranted = await service.grantHardCancel(
      owner(), context, experimental, grantCommand('grant_hard_cancel', { expectedVersion: 2 }),
    );
    expect(hardCancelGranted).toMatchObject({
      outcome: 'applied',
      view: {
        experimentalGrants: [{ kind: 'experimental_route' }],
        hardCancelGrants: [{ kind: 'hard_cancel' }],
      },
    });

    const experimentalRevoked = await service.revokeExperimentalRoute(
      owner(), context, null, grantCommand('revoke_experimental_route', { expectedVersion: 3 }),
    );
    expect(experimentalRevoked).toMatchObject({
      outcome: 'applied',
      view: { experimentalGrants: [], hardCancelGrants: [{ kind: 'hard_cancel' }] },
    });

    await expect(service.revokeHardCancel(
      owner(), context, null, grantCommand('revoke_hard_cancel', { expectedVersion: 4 }),
    )).resolves.toMatchObject({
      outcome: 'applied',
      view: { experimentalGrants: [], hardCancelGrants: [] },
    });
  });

  it.each([
    ['grantExperimentalRoute', 'grant_experimental_route', capabilities('experimental')],
    ['revokeExperimentalRoute', 'revoke_experimental_route', capabilities('experimental')],
    ['grantHardCancel', 'grant_hard_cancel', capabilities()],
    ['revokeHardCancel', 'revoke_hard_cancel', capabilities()],
  ] as const)('refuses forged agent authority before store access through %s', async (
    method,
    commandKind,
    currentCapabilities,
  ) => {
    let reads = 0;
    let writes = 0;
    const base = memoryStore();
    const service = createListeningModeService({
      async read(key) { reads += 1; return base.read(key); },
      async compareAndSet(write) { writes += 1; return base.compareAndSet(write); },
    });
    const forgedAuthority = { ...agent(), ownerId: binding().ownerId } as unknown as OwnerAuthority;

    await expect(service[method](
      forgedAuthority,
      { binding: binding(), status: 'active' },
      currentCapabilities,
      grantCommand(commandKind),
    )).resolves.toEqual({ outcome: 'refused', reason: 'forbidden' });
    expect({ reads, writes }).toEqual({ reads: 0, writes: 0 });
  });
});
