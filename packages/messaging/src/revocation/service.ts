// Device and agent-binding revocation (KHA-128). Implements the KHA-105 `RevocationPort`
// for one authenticated human owner against injected ports. It imports no control
// backend, storage provider or SDK. Composition roots supply those.

import {
  type CallOptions, type ControlStore, type OperationResult, type OwnerId, type RevocationPort, type RevocationProgress,
  type RevocationRejection, type RevocationRequest, type RevocationSubject,
  ok, outcomeUnknown, rejected, unavailable,
} from '@khala/contracts/messaging/index';
import {
  type OperationRecord, type RevocationStatus, decodeOperation, encodeOperation, newOperation, sameIntent, subjectOf,
  toProgress, toStatus,
} from './operation';
import {
  type AcknowledgmentOutcome, type EndpointAcknowledgment, type ProtocolRevocationPort, applyAcknowledgment,
  reconcileProtocol,
} from './reconcile';

/** The authenticated owner mapping and current generation of a device or binding. */
export type TargetLookup =
  | Readonly<{ kind: 'found'; ownerId: OwnerId; generation: number }>
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'unavailable' }>;

export interface RevocationTargets {
  lookup(subject: RevocationSubject, options?: CallOptions): Promise<TargetLookup>;
}

/**
 * - `applied`: the target is disabled at `revokedGeneration`, and a retry of the same operation also returns this.
 * - `stale`: the target is no longer at `expectedGeneration`, and this operation never applied.
 */
export type DisableResult = Readonly<{ kind: 'applied' | 'stale' | 'outcome_unknown' | 'unavailable' }>;

/**
 * Khala's own control plane. After `applied`, Khala refuses new release and dispatch for the
 * target, including releases queued before the revocation, and it moves the target to
 * `revokedGeneration`. No trust, queued delivery authority or approval carries over to a
 * replacement device or binding: a rebind is a new generation with its own authority.
 * Must be idempotent per operation ID.
 */
export interface RevocationControlPort {
  disable(
    input: RevocationSubject & Readonly<{ operationId: string; expectedGeneration: number; revokedGeneration: number }>,
    options?: CallOptions,
  ): Promise<DisableResult>;
}

export type RevocationServiceDeps = Readonly<{
  /** The authenticated human owner making requests through this instance. */
  ownerId: OwnerId;
  /** Operation journal. Intent is written here before any remote effect. */
  journal: ControlStore;
  targets: RevocationTargets;
  control: RevocationControlPort;
  protocol: ProtocolRevocationPort;
}>;

export interface RevocationService extends RevocationPort {
  /** Each boundary on its own, whether a retry can help, and what revocation cannot recall. */
  status(operationId: string, options?: CallOptions): Promise<OperationResult<RevocationStatus, 'not_found'>>;
  /** Records an endpoint's acknowledgment. `unavailable` means it was not recorded, so the endpoint should resend. */
  acknowledge(ack: EndpointAcknowledgment, options?: CallOptions): Promise<OperationResult<AcknowledgmentOutcome, never>>;
}

export const journalKey = (operationId: string): string => `revocation/${operationId}`;

type Stored = Readonly<{ record: OperationRecord; revision: string }>;
type Loaded = Readonly<{ kind: 'absent' }> | Readonly<{ kind: 'found'; stored: Stored }> | Readonly<{ kind: 'unavailable' }>;
type Saved = Readonly<{ kind: 'saved'; stored: Stored }> | Readonly<{ kind: 'unsaved' }>;

export function createRevocationService(deps: RevocationServiceDeps): RevocationService {
  const { ownerId, journal, targets, control, protocol } = deps;

  async function load(operationId: string, options?: CallOptions): Promise<Loaded> {
    const read = await journal.read(journalKey(operationId), options);
    if (read.kind !== 'record') return read;
    const record = decodeOperation(read.record.value);
    // A record that this module cannot read is never guessed at, and it is never overwritten.
    if (record === null || record.operationId !== operationId) return { kind: 'unavailable' };
    return { kind: 'found', stored: { record, revision: read.record.revision } };
  }

  /** Every journal write has its own store operation ID, so a lost response is resolvable. */
  async function save(current: Stored, next: OperationRecord, options?: CallOptions): Promise<Saved> {
    const record = { ...next, seq: current.record.seq + 1 };
    const key = journalKey(record.operationId);
    const writeId = `${record.operationId}#${record.seq}`;
    let result = await journal.compareAndSet(
      { key, expectedRevision: current.revision, operationId: writeId, next: { value: encodeOperation(record), expiresAt: null } },
      options,
    );
    if (result.kind === 'outcome_unknown') {
      const resolved = await journal.resolve({ key, operationId: writeId }, options);
      if (resolved.kind === 'applied') result = resolved;
    }
    return result.kind === 'applied' ? { kind: 'saved', stored: { record, revision: result.record.revision } } : { kind: 'unsaved' };
  }

  /** Records a new intent. Anything short of a confirmed write stops before any remote effect. */
  async function recordIntent(request: RevocationRequest, options?: CallOptions): Promise<Loaded | Readonly<{ kind: 'mismatch' | 'outcome_unknown' }>> {
    const record = newOperation(ownerId, request);
    const key = journalKey(request.operationId);
    const writeId = `${request.operationId}#0`;
    let result = await journal.compareAndSet(
      { key, expectedRevision: null, operationId: writeId, next: { value: encodeOperation(record), expiresAt: null } },
      options,
    );
    if (result.kind === 'outcome_unknown') {
      const resolved = await journal.resolve({ key, operationId: writeId }, options);
      if (resolved.kind === 'not_applied' || resolved.kind === 'unavailable') return { kind: 'unavailable' };
      if (resolved.kind === 'outcome_unknown') return { kind: 'outcome_unknown' };
      result = resolved;
    }
    switch (result.kind) {
      case 'applied':
        return { kind: 'found', stored: { record, revision: result.record.revision } };
      // Another request created this operation first. The caller compares intents.
      case 'conflict':
        return load(request.operationId, options);
      case 'operation_mismatch':
        return { kind: 'mismatch' };
      case 'unavailable':
        return { kind: 'unavailable' };
    }
  }

  /** Moves each boundary forward once. Returns the latest state known, which is durable except after a failed save. */
  async function advance(stored: Stored, options?: CallOptions): Promise<OperationRecord> {
    let current = stored;
    let record = stored.record;
    const stopped = () => options?.signal?.aborted === true;
    if (record.control === 'pending') {
      if (stopped()) return record;
      const disabled = await control.disable({
        ...subjectOf(record),
        operationId: record.operationId,
        expectedGeneration: record.expectedGeneration,
        revokedGeneration: record.revokedGeneration,
      }, options);
      if (disabled.kind !== 'applied' && disabled.kind !== 'stale') return record;
      record = { ...record, control: disabled.kind === 'applied' ? 'disabled' : 'stale' };
      const saved = await save(current, record, options);
      // The protocol step waits until the disable is durable. A retry repeats the idempotent disable.
      if (saved.kind === 'unsaved') return record;
      current = saved.stored;
      record = saved.stored.record;
    }
    if (record.control !== 'disabled' || stopped()) return record;
    const next = await reconcileProtocol(record, protocol, options);
    if (next === record) return record;
    const saved = await save(current, next, options);
    return saved.kind === 'saved' ? saved.stored.record : next;
  }

  function report(record: OperationRecord, operationId: string, options?: CallOptions): OperationResult<RevocationProgress, RevocationRejection> {
    const progress = toProgress(record);
    if (progress === null) return rejected('stale_generation');
    if (options?.signal?.aborted) return outcomeUnknown(operationId);
    return ok(progress);
  }

  async function revoke(request: RevocationRequest, options?: CallOptions): Promise<OperationResult<RevocationProgress, RevocationRejection>> {
    let loaded = await load(request.operationId, options);
    if (loaded.kind === 'unavailable') return unavailable();
    if (loaded.kind === 'absent') {
      if (options?.signal?.aborted) return unavailable();
      const target = await targets.lookup(request, options);
      if (target.kind === 'unavailable') return unavailable();
      if (target.kind === 'absent') return rejected('not_found');
      if (target.ownerId !== ownerId) return rejected('forbidden');
      if (target.generation !== request.expectedGeneration) return rejected('stale_generation');
      const created = await recordIntent(request, options);
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
    const loaded = await load(operationId, options);
    if (loaded.kind === 'unavailable') return unavailable();
    // Another owner's operation is indistinguishable from an absent one.
    if (loaded.kind === 'absent' || loaded.stored.record.ownerId !== ownerId) return rejected('not_found');
    return ok(loaded.stored);
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

    async acknowledge(ack, options) {
      const loaded = await loadOwned(ack.operationId, options);
      if (loaded.kind === 'rejected') return ok('ignored');
      if (loaded.kind !== 'ok') return unavailable();
      const applied = applyAcknowledgment(loaded.value.record, ack);
      if (applied.outcome !== 'recorded') return ok(applied.outcome);
      const saved = await save(loaded.value, applied.record, options);
      return saved.kind === 'saved' ? ok('recorded') : unavailable();
    },
  };
}
