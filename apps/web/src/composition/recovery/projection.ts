// Safe, serialisable view of the recovery state for status, logs and telemetry.
// Built field by field from an allow-list, so no key, password, SDK token,
// principal or recovery secret can reach it, whatever the snapshot carries.

import type { RecoveryOperationReference, RecoverySnapshot } from '../../features/recovery/ports';

export type RecoveryAction = 'revoke' | 'close';

export type RecoveryObservation = Readonly<{
  operationId: string | null;
  operation: RecoveryOperationReference['kind'] | null;
  deviceState: RecoverySnapshot['device']['state'];
  history: RecoverySnapshot['history'];
  /** `null` only if a recovery mode were offered; under P14 it never is. */
  recoveryUnavailable: RecoverySnapshot['recovery']['unavailableReason'];
  allowedActions: readonly RecoveryAction[];
}>;

export function projectRecovery(
  snapshot: RecoverySnapshot,
  operation: RecoveryOperationReference | null,
): RecoveryObservation {
  const allowedActions: RecoveryAction[] = [];
  if (snapshot.identity.kind === 'signed_in' && operation === null) {
    if (snapshot.revocationTargets.length > 0) allowedActions.push('revoke');
    if (snapshot.closure?.available === true) allowedActions.push('close');
  }
  return {
    operationId: operation?.operationId ?? null,
    operation: operation?.kind ?? null,
    deviceState: snapshot.device.state,
    history: snapshot.history,
    recoveryUnavailable: snapshot.recovery.unavailableReason,
    allowedActions,
  };
}
