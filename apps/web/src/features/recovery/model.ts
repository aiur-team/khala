import type {
  DeviceState,
  IdentityState,
  OperationResult,
  RecoveryRejection,
  RecoveryState,
  RecoveryStatus,
  RevocationProgress,
  RevocationRejection,
} from '@khala/contracts/messaging/index';

import type {
  ClosureCapability,
  ClosureRejection,
  ClosureStatus,
  HistoryAvailability,
  RecoveryConnection,
  RecoverySnapshot,
  RevocationCapability,
} from './ports';

export type RecoveryAction = 'recover' | 'revoke_device' | 'revoke_binding' | 'close_room';

export type RecoveryOperation =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{
    kind: 'recovery';
    operationId: string;
    state: RecoveryState | 'outcome_unknown';
    reason: string | null;
  }>
  | Readonly<{
    kind: 'revocation';
    operationId: string;
    state: RevocationProgress['state'] | 'failed' | 'outcome_unknown';
    reason: string | null;
  }>
  | Readonly<{
    kind: 'closure';
    operationId: string;
    state: ClosureStatus['state'] | 'outcome_unknown';
    reason: string | null;
  }>;

export type RecoveryView = Readonly<{
  identityState: IdentityState['kind'];
  deviceState: DeviceState;
  deviceId: RecoverySnapshot['device']['deviceId'];
  deviceGeneration: number;
  history: HistoryAvailability;
  connection: RecoveryConnection;
  operation: RecoveryOperation;
  recoveryModes: readonly string[];
  recoveryUnavailableReason: RecoverySnapshot['recovery']['unavailableReason'];
  revocationTargets: readonly RevocationCapability[];
  closure: ClosureCapability | null;
  allowedActions: readonly RecoveryAction[];
}>;

export const IDLE_RECOVERY_OPERATION: RecoveryOperation = Object.freeze({ kind: 'idle' });

const HISTORY_STATES: readonly HistoryAvailability[] = ['available', 'partial', 'unavailable'];
const CONNECTION_STATES: readonly RecoveryConnection[] = ['online', 'offline', 'unknown'];

function identityKind(identity: IdentityState): IdentityState['kind'] {
  switch (identity.kind) {
    case 'signed_in':
    case 'signed_out':
    case 'unavailable':
      return identity.kind;
    default:
      return 'unavailable';
  }
}

function validRecoveryModes(_snapshot: RecoverySnapshot): readonly string[] {
  void _snapshot;
  // P14 has no recovery mode. A stale or malformed capability snapshot must
  // not reopen a setup or recovery-key flow in this UI.
  return [];
}

function closureIsCallable(snapshot: RecoverySnapshot): boolean {
  if (snapshot.identity.kind !== 'signed_in' || snapshot.closure?.available !== true) return false;
  return snapshot.closure.ownerId === snapshot.identity.principal.ownerId;
}

export function canBeginOperation(operation: RecoveryOperation): boolean {
  return operation.kind === 'idle'
    || operation.state === 'failed'
    || (operation.kind === 'recovery' && operation.state === 'unrecoverable');
}

/** Projects only observed facts; connectivity and device readiness never imply complete history. */
export function projectRecoveryView(
  snapshot: RecoverySnapshot,
  operation: RecoveryOperation = IDLE_RECOVERY_OPERATION,
): RecoveryView {
  const modes = validRecoveryModes(snapshot);
  const allowedActions: RecoveryAction[] = [];

  if (canBeginOperation(operation) && identityKind(snapshot.identity) === 'signed_in') {
    if (modes.length > 0) allowedActions.push('recover');
    if (snapshot.revocationTargets.some(target => target.targetKind === 'device')) allowedActions.push('revoke_device');
    if (snapshot.revocationTargets.some(target => target.targetKind === 'binding')) allowedActions.push('revoke_binding');
    if (closureIsCallable(snapshot)) allowedActions.push('close_room');
  }

  return {
    identityState: identityKind(snapshot.identity),
    deviceState: snapshot.device.state,
    deviceId: snapshot.device.deviceId,
    deviceGeneration: snapshot.device.generation,
    history: HISTORY_STATES.includes(snapshot.history) ? snapshot.history : 'unavailable',
    connection: CONNECTION_STATES.includes(snapshot.connection) ? snapshot.connection : 'unknown',
    operation,
    recoveryModes: modes,
    recoveryUnavailableReason: snapshot.recovery.unavailableReason,
    revocationTargets: snapshot.revocationTargets.map(target => ({ ...target })),
    closure: snapshot.closure === null
      ? null
      : { ...snapshot.closure, consequences: { ...snapshot.closure.consequences } } as ClosureCapability,
    allowedActions,
  };
}

export function isRecoveryModeAllowed(view: RecoveryView, mode: string): boolean {
  return view.allowedActions.includes('recover') && view.recoveryModes.includes(mode);
}

function failedReason<T, Code extends string>(result: OperationResult<T, Code>): string {
  return result.kind === 'rejected' ? result.code : 'dependency_unavailable';
}

export function projectRecoveryOperation(
  operationId: string,
  result: OperationResult<RecoveryStatus, RecoveryRejection | 'not_found'>,
): RecoveryOperation {
  if (result.kind === 'outcome_unknown' || (result.kind === 'ok' && result.value.operationId !== operationId)) {
    return { kind: 'recovery', operationId, state: 'outcome_unknown', reason: null };
  }
  if (result.kind === 'ok') {
    return {
      kind: 'recovery',
      operationId,
      state: result.value.state,
      reason: result.value.reason,
    };
  }
  return { kind: 'recovery', operationId, state: 'failed', reason: failedReason(result) };
}

export function projectRevocationOperation(
  operationId: string,
  result: OperationResult<RevocationProgress, RevocationRejection | 'not_found'>,
): RecoveryOperation {
  if (result.kind === 'outcome_unknown' || (result.kind === 'ok' && result.value.operationId !== operationId)) {
    return { kind: 'revocation', operationId, state: 'outcome_unknown', reason: null };
  }
  if (result.kind === 'ok') {
    return { kind: 'revocation', operationId, state: result.value.state, reason: null };
  }
  return { kind: 'revocation', operationId, state: 'failed', reason: failedReason(result) };
}

export function projectClosureOperation(
  operationId: string,
  result: OperationResult<ClosureStatus, ClosureRejection | 'not_found'>,
): RecoveryOperation {
  if (result.kind === 'outcome_unknown' || (result.kind === 'ok' && result.value.operationId !== operationId)) {
    return { kind: 'closure', operationId, state: 'outcome_unknown', reason: null };
  }
  if (result.kind === 'ok') {
    return {
      kind: 'closure',
      operationId,
      state: result.value.state,
      reason: result.value.reason,
    };
  }
  return { kind: 'closure', operationId, state: 'failed', reason: failedReason(result) };
}
