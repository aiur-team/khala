// The human-facing join state. Richer than the raw admission/device
// discriminants it is built from, but every value here must trace back to a
// canonical result or code — `wrong_account` is never inferred merely because
// two display emails differ.

import type { AdmissionRejection, DeviceReason, InviteState } from '@khala/contracts/messaging/index';

export type JoinPhase =
  | 'checking_identity'
  | 'sign_in'
  | 'checking_invitation'
  | 'initializing_device'
  | 'joining'
  | 'joined'
  | 'expired'
  | 'revoked'
  | 'wrong_account'
  | 'unavailable';

export type JoinView = Readonly<{
  phase: JoinPhase;
  email: string | null;
  roomId: string | null;
  retryAllowed: boolean;
  errorCode: string | null;
}>;

export const CHECKING_IDENTITY_VIEW: JoinView = {
  phase: 'checking_identity',
  email: null,
  roomId: null,
  retryAllowed: false,
  errorCode: null,
};

/**
 * Terminal or redirecting phase implied by an `InviteState`, or `null` when
 * the state means "keep going" (`eligible`, `already_joined` still require
 * device readiness and an `admit` call to reach a room).
 */
export function inviteStatePhase(state: InviteState): JoinPhase | null {
  switch (state) {
    case 'expired':
      return 'expired';
    case 'revoked':
      return 'revoked';
    case 'identity_mismatch':
      return 'wrong_account';
    case 'unavailable':
      return 'unavailable';
    case 'auth_required':
      return 'sign_in';
    case 'eligible':
    case 'already_joined':
      return null;
  }
}

/** Whether a phase reached from an `InviteState` allows an explicit retry. */
export function inviteStateRetryAllowed(state: InviteState): boolean {
  return state === 'unavailable';
}

export function admissionRejectionPhase(code: AdmissionRejection): JoinPhase {
  switch (code) {
    case 'expired':
      return 'expired';
    case 'revoked':
      return 'revoked';
    case 'identity_mismatch':
    case 'forbidden':
      return 'wrong_account';
    case 'auth_required':
      return 'sign_in';
    case 'operation_mismatch':
      return 'unavailable';
  }
}

/**
 * A device state that is not `ready` after `ensureReady` resolves. `new` and
 * `initializing` are transitional and never reach this mapping; every other
 * state is a real failure that offers retry rather than a default
 * key-management ceremony.
 */
export function deviceReasonErrorCode(reason: DeviceReason | null): string {
  return reason ?? 'device_unavailable';
}
