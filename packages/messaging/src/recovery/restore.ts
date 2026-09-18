import type {
  CallOptions, OwnerId, ProvideRecoverySecret, RecoveryFailureReason,
} from '@khala/contracts/messaging/index';
import { sameSession, type RecoveryIdentity, type RecoverySession } from './capabilities';
import type { RecoveryHistory } from './operation';

export type RecoveryMaterial = Readonly<{
  ownerId: OwnerId;
  /** Stable, nonsecret fingerprint of this concrete transfer/backup. */
  id: string;
  /** Exact SDK backup/transfer format of the material about to be imported. */
  version: string;
  /** Established by the endpoint SDK, never from a server assertion alone. */
  trusted: boolean;
}>;

export type RestoreResult =
  | Readonly<{ kind: 'restored'; history: RecoveryHistory }>
  | Readonly<{ kind: 'secret_rejected' | 'backup_missing' | 'backup_corrupt' | 'storage_unavailable' | 'cancelled' }>;

export interface RecoverySubstrate {
  capabilities(options?: CallOptions): Promise<import('./capabilities').SubstrateCapabilities>;
  material(mode: string, options?: CallOptions): Promise<RecoveryMaterial | null>;
  /** Must be idempotent for the operation ID and attempt pair. */
  restore(
    input: Readonly<{
      operationId: string;
      mode: string;
      attempt: number;
      secret: Uint8Array;
      expectedSession: Readonly<{ ownerId: OwnerId; generation: number }>;
    }>,
    options?: CallOptions,
  ): Promise<RestoreResult>;
}

export type RestoreTerminal = Readonly<{
  kind: 'terminal';
  state: 'restored' | 'partial' | 'unrecoverable' | 'failed';
  reason: RecoveryFailureReason | null;
  history: RecoveryHistory;
  attempts: number;
}> | Readonly<{ kind: 'aborted'; attempts: number }>;

type RunRestoreInput = Readonly<{
  operationId: string;
  mode: string;
  approvedVersion: string;
  initialSession: RecoverySession;
  initialAttempts: number;
  initialAttemptPhase: import('./operation').AttemptPhase;
  maxSecretAttempts: number;
  provideSecret: ProvideRecoverySecret;
  checkAttempt: (material: RecoveryMaterial) => Promise<'available' | 'exhausted' | 'unavailable'>;
  reserveAttempt: (material: RecoveryMaterial, attempt: number) => Promise<'reserved' | 'exhausted' | 'unavailable'>;
  /** Persists the operation attempt phase before a secret is requested. */
  onAttempt: (attempt: number, phase: 'active' | 'rejected') => Promise<boolean>;
  identity: RecoveryIdentity;
  substrate: RecoverySubstrate;
  options?: CallOptions;
}>;

const empty = { restored: 0, unavailable: 0 } as const;

const validHistory = (history: RecoveryHistory): boolean =>
  Number.isSafeInteger(history.restored) && history.restored >= 0
  && Number.isSafeInteger(history.unavailable) && history.unavailable >= 0;

async function stillCurrent(input: RunRestoreInput): Promise<boolean> {
  try {
    return sameSession(input.initialSession, await input.identity.current(input.options));
  } catch {
    return false;
  }
}

const terminal = (
  state: 'restored' | 'partial' | 'unrecoverable' | 'failed',
  reason: RecoveryFailureReason | null,
  history: RecoveryHistory,
  attempts: number,
): RestoreTerminal => ({ kind: 'terminal', state, reason, history, attempts });

/** Runs endpoint-local restore. Secret bytes are never returned and are zeroed after the SDK call. */
export async function runRestore(input: RunRestoreInput): Promise<RestoreTerminal> {
  if (input.options?.signal?.aborted) return { kind: 'aborted', attempts: input.initialAttempts };
  if (!await stillCurrent(input)) return terminal('failed', 'cancelled_locally', empty, input.initialAttempts);
  let material: RecoveryMaterial | null;
  try {
    material = await input.substrate.material(input.mode, input.options);
  } catch {
    return terminal('failed', 'storage_unavailable', empty, input.initialAttempts);
  }
  if (input.options?.signal?.aborted) return { kind: 'aborted', attempts: input.initialAttempts };
  if (!await stillCurrent(input)) return terminal('failed', 'cancelled_locally', empty, input.initialAttempts);
  if (material === null) return terminal('unrecoverable', 'backup_missing', empty, input.initialAttempts);
  const session = input.initialSession;
  if (session.kind !== 'signed_in' || material.id === '' || material.ownerId !== session.ownerId
    || material.version !== input.approvedVersion || !material.trusted) {
    return terminal('failed', 'backup_corrupt', empty, input.initialAttempts);
  }

  let attempts = input.initialAttempts;
  let resumeActive = input.initialAttemptPhase === 'active' && attempts > 0;
  while (resumeActive || attempts < input.maxSecretAttempts) {
    const attempt = resumeActive ? attempts : attempts + 1;
    if (!resumeActive) {
      const availability = await input.checkAttempt(material);
      if (availability === 'exhausted') return terminal('failed', 'secret_rejected', empty, attempts);
      if (availability === 'unavailable') return terminal('failed', 'storage_unavailable', empty, attempts);
    }
    resumeActive = false;
    if (input.options?.signal?.aborted) return { kind: 'aborted', attempts };
    let secret: Uint8Array | null;
    try {
      secret = await input.provideSecret({ operationId: input.operationId, mode: input.mode, attempt });
    } catch {
      secret = null;
    }
    if (!await stillCurrent(input)) {
      secret?.fill(0);
      return terminal('failed', 'cancelled_locally', empty, attempts);
    }
    if (input.options?.signal?.aborted) {
      secret?.fill(0);
      return { kind: 'aborted', attempts };
    }
    if (secret === null) return terminal('failed', 'cancelled_locally', empty, attempts);
    if (attempt !== attempts) {
      const reserved = await input.reserveAttempt(material, attempt);
      if (reserved === 'exhausted') {
        secret.fill(0);
        return terminal('failed', 'secret_rejected', empty, attempts);
      }
      if (reserved === 'unavailable' || !await input.onAttempt(attempt, 'active')) {
        secret.fill(0);
        return terminal('failed', 'storage_unavailable', empty, attempts);
      }
      attempts = attempt;
    }

    const generationAbort = new AbortController();
    let stop: () => void;
    try {
      stop = input.identity.observe(next => { if (!sameSession(session, next)) generationAbort.abort(); });
    } catch {
      secret.fill(0);
      return terminal('failed', 'storage_unavailable', empty, attempts);
    }
    const callerSignal = input.options?.signal;
    const abortCaller = () => generationAbort.abort();
    callerSignal?.addEventListener('abort', abortCaller, { once: true });
    if (!await stillCurrent(input)) generationAbort.abort();

    let result: RestoreResult;
    try {
      result = generationAbort.signal.aborted
        ? { kind: 'cancelled' }
        : await input.substrate.restore({
          operationId: input.operationId, mode: input.mode, attempt: attempts, secret,
          expectedSession: { ownerId: session.ownerId, generation: session.generation },
        }, { signal: generationAbort.signal });
    } catch {
      result = { kind: 'storage_unavailable' };
    } finally {
      stop();
      callerSignal?.removeEventListener('abort', abortCaller);
      secret.fill(0);
    }
    if (callerSignal?.aborted) return { kind: 'aborted', attempts };
    if (!await stillCurrent(input)) return terminal('failed', 'cancelled_locally', empty, attempts);
    if (result.kind === 'secret_rejected') {
      if (!await input.onAttempt(attempts, 'rejected')) return terminal('failed', 'storage_unavailable', empty, attempts);
      continue;
    }
    if (result.kind === 'restored') {
      if (!validHistory(result.history)) {
        return terminal('failed', 'backup_corrupt', empty, attempts);
      }
      const state = result.history.unavailable === 0 ? 'restored' : 'partial';
      return terminal(state, null, result.history, attempts);
    }
    const reason: RecoveryFailureReason = result.kind === 'cancelled' ? 'cancelled_locally' : result.kind;
    return terminal(result.kind === 'backup_missing' ? 'unrecoverable' : 'failed', reason, empty, attempts);
  }
  return terminal('failed', 'secret_rejected', empty, attempts);
}
