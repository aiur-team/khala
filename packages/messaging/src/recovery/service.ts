import type {
  CallOptions, ControlStore, OperationResult, OwnerId, ProvideRecoverySecret, RecoveryPort, RecoveryRejection, RecoveryStatus,
} from '@khala/contracts/messaging/index';
import { ok, outcomeUnknown, rejected, unavailable } from '@khala/contracts/messaging/index';
import {
  projectCapabilities, type ApprovedRecoveryMode, type RecoveryIdentity,
} from './capabilities';
import { recoveryJournal, type StoredOperation } from './journal';
import {
  newOperation, terminal, toStatus, type OperationRecord,
} from './operation';
import { runRestore, type RecoverySubstrate } from './restore';
import { recoveryBudget } from './budget';

export type RecoveryServiceDeps = Readonly<{
  ownerId: OwnerId;
  identity: RecoveryIdentity;
  substrate: RecoverySubstrate;
  journal: ControlStore;
  /** Empty is the approved no-recovery policy: login succeeds, old history stays unavailable. */
  approvedModes: readonly ApprovedRecoveryMode[];
  maxSecretAttempts?: number;
}>;

export interface RecoveryService extends RecoveryPort {
  begin(
    input: Readonly<{ operationId: string; mode: string }>,
    provideSecret: ProvideRecoverySecret,
    options?: CallOptions,
  ): Promise<OperationResult<RecoveryStatus, RecoveryRejection>>;
  inspect(operationId: string, options?: CallOptions): Promise<OperationResult<RecoveryStatus, 'not_found'>>;
}

export function createRecoveryService(deps: RecoveryServiceDeps): RecoveryService {
  const journal = recoveryJournal(deps.ownerId, deps.journal);
  const budget = recoveryBudget(deps.ownerId, deps.journal);
  const approved = new Map(deps.approvedModes.map(mode => [mode.id, mode]));
  const maxSecretAttempts = deps.maxSecretAttempts ?? 3;
  if (!Number.isSafeInteger(maxSecretAttempts) || maxSecretAttempts < 1) throw new TypeError('maxSecretAttempts must be a positive integer');
  const inflight = new Map<string, Readonly<{
    mode: string;
    promise: Promise<OperationResult<RecoveryStatus, RecoveryRejection>>;
  }>>();

  async function capabilities(options?: CallOptions) {
    return (await projectCapabilities(deps.ownerId, deps.approvedModes, deps.identity, deps.substrate, options)).capabilities;
  }

  async function persist(
    current: StoredOperation,
    record: OperationRecord,
    options?: CallOptions,
  ): Promise<StoredOperation | null> {
    const saved = await journal.save(current, record, options);
    return saved.kind === 'saved' ? saved.stored : null;
  }

  async function perform(
    input: Readonly<{ operationId: string; mode: string }>,
    provideSecret: ProvideRecoverySecret,
    options?: CallOptions,
  ): Promise<OperationResult<RecoveryStatus, RecoveryRejection>> {
    if (options?.signal?.aborted) return unavailable();
    const projected = await projectCapabilities(deps.ownerId, deps.approvedModes, deps.identity, deps.substrate, options);
    if (projected.session.kind !== 'signed_in' || projected.session.ownerId !== deps.ownerId) return rejected('device_not_ready');
    const session = projected.session;
    if (options?.signal?.aborted) return unavailable();
    if (!projected.capabilities.modes.includes(input.mode)) return rejected('unsupported_mode');
    const approvedMode = approved.get(input.mode);
    if (!approvedMode) return rejected('unsupported_mode');

    const loaded = await journal.load(input.operationId, options);
    if (loaded.kind === 'unavailable') return unavailable();
    if (options?.signal?.aborted) return loaded.kind === 'absent' ? unavailable() : outcomeUnknown(input.operationId);
    let stored: StoredOperation;
    if (loaded.kind === 'found') {
      if (loaded.stored.record.mode !== input.mode || loaded.stored.record.accountGeneration !== session.generation) {
        return rejected('operation_mismatch');
      }
      if (terminal(loaded.stored.record)) return ok(toStatus(loaded.stored.record));
      stored = loaded.stored;
    } else {
      const record = newOperation(input.operationId, deps.ownerId, input.mode, session.generation);
      const created = await journal.create(loaded.key, record, options);
      if (created.kind === 'outcome_unknown') return outcomeUnknown(input.operationId);
      if (created.kind === 'unavailable') return unavailable();
      if (created.kind !== 'applied') {
        const raced = await journal.load(input.operationId, options);
        if (raced.kind !== 'found') return unavailable();
        if (raced.stored.record.mode !== input.mode || raced.stored.record.accountGeneration !== session.generation) {
          return rejected('operation_mismatch');
        }
        stored = raced.stored;
      } else {
        stored = { key: loaded.key, record, revision: created.record.revision };
      }
    }

    if (stored.record.state !== 'restoring') {
      const next = await persist(stored, { ...stored.record, state: 'restoring' }, options);
      if (!next) return outcomeUnknown(input.operationId);
      stored = next;
    }
    const result = await runRestore({
      operationId: input.operationId,
      mode: input.mode,
      approvedVersion: approvedMode.version,
      initialSession: session,
      initialAttempts: stored.record.attempts,
      initialAttemptPhase: stored.record.attemptPhase,
      maxSecretAttempts,
      provideSecret,
      checkAttempt: material => budget.available({
        mode: input.mode,
        accountGeneration: session.generation,
        material,
        limit: maxSecretAttempts,
      }, options),
      reserveAttempt: (material, attempt) => budget.reserve({
        operationId: input.operationId,
        mode: input.mode,
        accountGeneration: session.generation,
        material,
        attempt,
        limit: maxSecretAttempts,
      }, options),
      async onAttempt(attempt, attemptPhase) {
        const next = await persist(stored, { ...stored.record, attempts: attempt, attemptPhase }, options);
        if (!next) return false;
        stored = next;
        return true;
      },
      identity: deps.identity,
      substrate: deps.substrate,
      ...(options ? { options } : {}),
    });
    if (result.kind === 'aborted') return outcomeUnknown(input.operationId);
    const completed: OperationRecord = {
      ...stored.record,
      state: result.state,
      reason: result.reason,
      restored: result.history.restored,
      unavailable: result.history.unavailable,
      attempts: result.attempts,
      attemptPhase: stored.record.attemptPhase,
    };
    const saved = await persist(stored, completed, options);
    return saved ? ok(toStatus(saved.record)) : outcomeUnknown(input.operationId);
  }

  return {
    capabilities,
    begin(input, provideSecret, options) {
      const running = inflight.get(input.operationId);
      if (running) return running.mode === input.mode ? running.promise : Promise.resolve(rejected('operation_mismatch'));
      const promise = perform(input, provideSecret, options).finally(() => inflight.delete(input.operationId));
      inflight.set(input.operationId, { mode: input.mode, promise });
      return promise;
    },
    async inspect(operationId, options) {
      const loaded = await journal.load(operationId, options);
      if (loaded.kind === 'absent') return rejected('not_found');
      if (loaded.kind === 'unavailable') return unavailable();
      return ok(toStatus(loaded.stored.record));
    },
  };
}
