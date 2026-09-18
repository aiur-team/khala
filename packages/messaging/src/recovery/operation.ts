import type {
  JsonValue, OwnerId, RecoveryFailureReason, RecoveryState, RecoveryStatus,
} from '@khala/contracts/messaging/index';

export type RecoveryHistory = Readonly<{ restored: number; unavailable: number }>;
export type AttemptPhase = 'idle' | 'active' | 'rejected';

export type OperationRecord = Readonly<{
  v: 1;
  operationId: string;
  ownerId: OwnerId;
  mode: string;
  accountGeneration: number;
  state: RecoveryState;
  reason: RecoveryFailureReason | null;
  restored: number;
  unavailable: number;
  attempts: number;
  attemptPhase: AttemptPhase;
  seq: number;
}>;

export function newOperation(operationId: string, ownerId: OwnerId, mode: string, accountGeneration: number): OperationRecord {
  return {
    v: 1, operationId, ownerId, mode, accountGeneration, state: 'locked', reason: null,
    restored: 0, unavailable: 0, attempts: 0, seq: 0,
    attemptPhase: 'idle',
  };
}

/** Exact contract shape: the shared decoder rejects additional fields. */
export function toStatus(record: OperationRecord): RecoveryStatus {
  return {
    operationId: record.operationId,
    mode: record.mode,
    state: record.state,
    reason: record.reason,
  };
}

export function terminal(record: OperationRecord): boolean {
  return ['restored', 'partial', 'unrecoverable', 'failed'].includes(record.state);
}

export function encodeOperation(record: OperationRecord): JsonValue {
  return { ...record };
}

const STATES: readonly RecoveryState[] = ['locked', 'restoring', 'restored', 'partial', 'unrecoverable', 'failed'];
const REASONS: readonly RecoveryFailureReason[] = ['secret_rejected', 'backup_missing', 'backup_corrupt', 'storage_unavailable', 'cancelled_locally'];
const FIELDS = [
  'v', 'operationId', 'ownerId', 'mode', 'accountGeneration', 'state', 'reason',
  'restored', 'unavailable', 'attempts', 'attemptPhase', 'seq',
];

export function decodeOperation(value: JsonValue): OperationRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const input = value as { readonly [key: string]: JsonValue };
  const keys = Object.keys(input);
  if (keys.length !== FIELDS.length || !FIELDS.every(key => Object.hasOwn(input, key))) return null;
  const text = (key: string) => typeof input[key] === 'string' && input[key] !== '' ? input[key] as string : null;
  const count = (key: string) => Number.isSafeInteger(input[key]) && (input[key] as number) >= 0 ? input[key] as number : null;
  const operationId = text('operationId');
  const ownerId = text('ownerId');
  const mode = text('mode');
  const accountGeneration = count('accountGeneration');
  const restored = count('restored');
  const unavailable = count('unavailable');
  const attempts = count('attempts');
  const attemptPhase = ['idle', 'active', 'rejected'].includes(input.attemptPhase as string)
    ? input.attemptPhase as AttemptPhase : null;
  const seq = count('seq');
  const state = STATES.includes(input.state as RecoveryState) ? input.state as RecoveryState : null;
  const reason = input.reason === null ? null : REASONS.includes(input.reason as RecoveryFailureReason)
    ? input.reason as RecoveryFailureReason : null;
  if (input.v !== 1 || operationId === null || ownerId === null || mode === null || accountGeneration === null
    || restored === null || unavailable === null || attempts === null || attemptPhase === null || seq === null || state === null
    || (input.reason !== null && reason === null)
    || (state === 'failed' || state === 'unrecoverable') !== (reason !== null)
    || ((state === 'locked' || state === 'restoring' || state === 'restored' || state === 'partial') && reason !== null)) return null;
  return {
    v: 1, operationId, ownerId: ownerId as OwnerId, mode, accountGeneration, state, reason,
    restored, unavailable, attempts, attemptPhase, seq,
  };
}
