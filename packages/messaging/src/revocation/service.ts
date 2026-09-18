// Device and agent-binding revocation (KHA-128). Implements the KHA-105 `RevocationPort`
// for one authenticated human owner against injected ports. It imports no control
// backend, storage provider or SDK. Composition roots supply those.

import {
  type AuthPrincipal, type BindingId, type CallOptions, type ControlStore, type DeviceId, type OperationResult,
  type OwnerId, type RevocationPort, type RevocationProgress, type RevocationRejection, type RevocationRequest,
  type RevocationSubject, ok, outcomeUnknown, rejected, unavailable,
} from '@khala/contracts/messaging/index';
import { type Loaded, type Stored, operationJournal } from './journal';
import {
  type ExcludedDevice, type OperationRecord, type RevocationStatus, newOperation, sameIntent, subjectOf, toProgress,
  toStatus,
} from './operation';
import {
  type AcknowledgmentOutcome, type EndpointAcknowledgment, type ProtocolRevocationPort, applyAcknowledgment,
  reconcileRemoval, reconcileRotation,
} from './reconcile';

/**
 * The owner mapping, current generation and messaging device of a device or binding.
 *
 * `generation` must be the durable, control-plane generation (`DeviceView.generation` or
 * `SessionBinding.generation` as the control plane records it), not a client-local counter. A
 * disabled target cannot advance it: only a new binding or a newly admitted device starts a new
 * generation, under its own authority.
 *
 * `device` is the messaging device the revocation excludes, with its identity key: the device
 * itself, or the agent's own device for a binding (`SessionBinding.deviceId`). For a device
 * target its ID is the target ID.
 */
export type TargetLookup =
  | Readonly<{ kind: 'found'; ownerId: OwnerId; generation: number; device: ExcludedDevice }>
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'unavailable' }>;

export interface RevocationTargets {
  lookup(subject: RevocationSubject, options?: CallOptions): Promise<TargetLookup>;
}

/**
 * - `applied`: the target is disabled at `revokedGeneration`, and a retry of the same operation also returns this.
 * - `stale`: the target is not at `expectedGeneration`. After a lost response this can be the operation's own
 *   earlier disable, so the service reads the target before treating it as a refusal.
 */
export type DisableResult = Readonly<{ kind: 'applied' | 'stale' | 'outcome_unknown' | 'unavailable' }>;

export type CapabilityRevocationResult = Readonly<{ kind: 'applied' | 'outcome_unknown' | 'unavailable' }>;

/** Khala's own control plane. Both methods must be idempotent per operation ID. */
export interface RevocationControlPort {
  /**
   * After `applied`, Khala refuses new release and dispatch for the target, including releases
   * queued before the revocation, and it moves the target to `revokedGeneration`. No trust, queued
   * delivery authority or approval carries over to a replacement device or binding: a rebind is a
   * new generation with its own authority.
   */
  disable(
    input: RevocationSubject & Readonly<{ operationId: string; expectedGeneration: number; revokedGeneration: number }>,
    options?: CallOptions,
  ): Promise<DisableResult>;
  /**
   * Invalidates the agent's adapter capability for a binding: after `applied`, no adapter token
   * issued for the binding is accepted, whatever its generation. A binding revocation cannot
   * complete without it.
   */
  revokeAdapterCapability(
    input: Readonly<{ operationId: string; bindingId: BindingId; revokedGeneration: number }>,
    options?: CallOptions,
  ): Promise<CapabilityRevocationResult>;
}

export type RevocationServiceDeps = Readonly<{
  /**
   * The authenticated human making requests through this instance. Only a human principal can
   * revoke. An agent or adapter identity has no principal, so it cannot be wired in here.
   */
  principal: AuthPrincipal;
  /** Operation journal. Intent is written here before any remote effect. */
  journal: ControlStore;
  targets: RevocationTargets;
  control: RevocationControlPort;
  protocol: ProtocolRevocationPort;
}>;

export interface RevocationService extends RevocationPort {
  /** Each boundary on its own, whether a retry can help, and what revocation cannot recall. */
  status(operationId: string, options?: CallOptions): Promise<OperationResult<RevocationStatus, 'not_found'>>;
}

type Created = Loaded | Readonly<{ kind: 'mismatch' | 'outcome_unknown' }>;

function sameDevice(subject: RevocationSubject, device: ExcludedDevice): boolean {
  return subject.targetKind !== 'device' || device.deviceId === (subject.targetId as DeviceId);
}

export function createRevocationService(deps: RevocationServiceDeps): RevocationService {
  const { targets, control, protocol } = deps;
  const ownerId = deps.principal.ownerId;
  const journal = operationJournal(ownerId, deps.journal);

  /** Records a new intent. Anything short of a confirmed write stops before any remote effect. */
  async function recordIntent(key: string, request: RevocationRequest, device: ExcludedDevice, options?: CallOptions): Promise<Created> {
    const record = newOperation(ownerId, request, device);
    const result = await journal.create(key, record, options);
    switch (result.kind) {
      case 'applied':
        return { kind: 'found', stored: { key, record, revision: result.record.revision } };
      // Another request created this operation first. The caller compares intents.
      case 'conflict':
        return journal.load(request.operationId, options);
      // The same write ID was claimed with other bytes: a concurrent request with a different intent.
      case 'operation_mismatch':
        return { kind: 'mismatch' };
      case 'outcome_unknown':
        return { kind: 'outcome_unknown' };
      case 'unavailable':
        return { kind: 'unavailable' };
    }
  }

  /**
   * A `stale` disable after a lost response may be this operation's own. The target is disabled if
   * it already sits at the revoked generation, because a disabled target cannot advance. A target
   * that no longer exists holds no release or dispatch authority either, so it has converged, and
   * its device is still excluded.
   */
  async function staleOrDisabled(record: OperationRecord, options?: CallOptions): Promise<'disabled' | 'stale' | null> {
    const target = await targets.lookup(record, options);
    if (target.kind === 'unavailable') return null;
    return target.kind === 'absent' || target.generation === record.revokedGeneration ? 'disabled' : 'stale';
  }

  /**
   * Moves each boundary forward once. Returns only what is durably journaled, so `revoke` never
   * reports more than a later `inspect` would.
   */
  async function advance(stored: Stored, options?: CallOptions): Promise<OperationRecord> {
    let current = stored;
    const stopped = () => options?.signal?.aborted === true;
    const step = async (next: OperationRecord): Promise<boolean> => {
      if (next === current.record) return false;
      const saved = await journal.save(current, next, options);
      if (saved.kind === 'unsaved') return false;
      current = saved.stored;
      return true;
    };

    if (current.record.control === 'pending') {
      if (stopped()) return current.record;
      const { record } = current;
      const disabled = await control.disable({
        ...subjectOf(record),
        operationId: record.operationId,
        expectedGeneration: record.expectedGeneration,
        revokedGeneration: record.revokedGeneration,
      }, options);
      const outcome = disabled.kind === 'applied' ? 'disabled'
        : disabled.kind === 'stale' ? await staleOrDisabled(record, options)
          : null;
      // Later steps wait until the disable is durable. A retry repeats the idempotent disable.
      if (outcome === null || !(await step({ ...record, control: outcome }))) return current.record;
    }
    if (current.record.control !== 'disabled') return current.record;

    const { record } = current;
    if (record.targetKind === 'binding' && record.capability === 'pending' && !stopped()) {
      const revoked = await control.revokeAdapterCapability(
        { operationId: record.operationId, bindingId: record.targetId, revokedGeneration: record.revokedGeneration },
        options,
      );
      if (revoked.kind === 'applied') await step({ ...record, capability: 'revoked' });
    }
    // Device exclusion does not wait on the capability: the two boundaries are independent.
    if (stopped()) return current.record;
    await step(await reconcileRemoval(current.record, protocol, options));
    if (stopped()) return current.record;
    await step(await reconcileRotation(current.record, protocol, options));
    return current.record;
  }

  function report(record: OperationRecord, operationId: string, options?: CallOptions): OperationResult<RevocationProgress, RevocationRejection> {
    const progress = toProgress(record);
    if (progress === null) return rejected('stale_generation');
    if (options?.signal?.aborted) return outcomeUnknown(operationId);
    return ok(progress);
  }

  async function revoke(request: RevocationRequest, options?: CallOptions): Promise<OperationResult<RevocationProgress, RevocationRejection>> {
    let loaded = await journal.load(request.operationId, options);
    if (loaded.kind === 'unavailable') return unavailable();
    if (loaded.kind === 'absent') {
      if (options?.signal?.aborted) return unavailable();
      const target = await targets.lookup(request, options);
      if (target.kind === 'unavailable') return unavailable();
      if (target.kind === 'absent') return rejected('not_found');
      if (target.ownerId !== ownerId) return rejected('forbidden');
      if (target.generation !== request.expectedGeneration) return rejected('stale_generation');
      // A device target whose lookup names another device is a lookup defect, never acted on.
      if (!sameDevice(request, target.device)) return unavailable();
      const created = await recordIntent(loaded.key, request, target.device, options);
      if (created.kind === 'mismatch') return rejected('operation_mismatch');
      if (created.kind === 'outcome_unknown') return outcomeUnknown(request.operationId);
      // An intent that cannot be read back is never acted on.
      if (created.kind !== 'found') return unavailable();
      loaded = created;
    }
    const { stored } = loaded;
    if (!sameIntent(stored.record, ownerId, request)) return rejected('operation_mismatch');
    return report(await advance(stored, options), request.operationId, options);
  }

  async function loadOwned(operationId: string, options?: CallOptions): Promise<OperationResult<Stored, 'not_found'>> {
    const loaded = await journal.load(operationId, options);
    if (loaded.kind === 'unavailable') return unavailable();
    return loaded.kind === 'absent' ? rejected('not_found') : ok(loaded.stored);
  }

  return {
    revoke,

    async inspect(operationId, options) {
      const loaded = await loadOwned(operationId, options);
      if (loaded.kind !== 'ok') return loaded;
      const progress = toProgress(loaded.value.record);
      return progress === null ? rejected('not_found') : ok(progress);
    },

    async status(operationId, options) {
      const loaded = await loadOwned(operationId, options);
      return loaded.kind === 'ok' ? ok(toStatus(loaded.value.record)) : loaded;
    },
  };
}

export type AcknowledgmentReceiverDeps = Readonly<{
  /** Owner of the authenticated endpoint that sends the acknowledgments. */
  ownerId: OwnerId;
  journal: ControlStore;
}>;

/**
 * Endpoint-facing port. It can only record an acknowledgment, so wiring it into an endpoint grants
 * no right to revoke or to read status.
 */
export interface AcknowledgmentReceiver {
  /**
   * `unavailable` means it was not recorded yet, so the endpoint resends. `ignored` is final: the
   * acknowledgment can never apply to this operation.
   */
  acknowledge(ack: EndpointAcknowledgment, options?: CallOptions): Promise<OperationResult<AcknowledgmentOutcome, never>>;
}

export function createAcknowledgmentReceiver(deps: AcknowledgmentReceiverDeps): AcknowledgmentReceiver {
  const journal = operationJournal(deps.ownerId, deps.journal);
  return {
    async acknowledge(ack, options) {
      const loaded = await journal.load(ack.operationId, options);
      if (loaded.kind === 'absent') return ok('ignored');
      if (loaded.kind !== 'found') return unavailable();
      const applied = applyAcknowledgment(loaded.stored.record, ack);
      // The endpoint can stop before its disable is journaled. It resends until that write lands.
      if (applied.outcome === 'early') return unavailable();
      if (applied.outcome !== 'recorded') return ok(applied.outcome);
      const saved = await journal.save(loaded.stored, applied.record, options);
      return saved.kind === 'saved' ? ok('recorded') : unavailable();
    },
  };
}
