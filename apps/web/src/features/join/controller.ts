// Orchestrates OAuth entry and chat admission. Reinspects admission after
// every identity change, fences stale async responses by a lifecycle
// generation, and never issues a second `admit` for one attempt: the
// operation ID is created once per attempt and reused across retries.

import type { AuthPrincipal, DeviceId, Disposer } from '@khala/contracts/messaging/index';
import { admissionRejectionPhase, CHECKING_IDENTITY_VIEW, deviceReasonErrorCode, inviteStatePhase, type JoinView } from './model';
import { buildReturnPath } from './location';
import type { JoinPorts } from './ports';

export interface JoinController {
  getView(): JoinView;
  subscribe(listener: (view: JoinView) => void): Disposer;
  /** Parses `locationUrl` and starts (or restarts) the join pipeline. */
  start(locationUrl: string): void;
  /** Re-runs the pipeline from the current step; safe to call after any `unavailable` phase. */
  retry(): void;
  /** Begins OAuth sign-in. Only ever called from explicit user action, never automatically. */
  signIn(): Promise<void>;
}

function unavailableView(errorCode: string, retryAllowed = true, email: string | null = null): JoinView {
  return { phase: 'unavailable', email, roomId: null, retryAllowed, errorCode };
}

const SIGN_IN_VIEW: JoinView = { phase: 'sign_in', email: null, roomId: null, retryAllowed: false, errorCode: null };

export function createJoinController(ports: JoinPorts): JoinController {
  let generation = 0;
  let view: JoinView = CHECKING_IDENTITY_VIEW;
  let inviteRef: string | null = null;
  let operationId: string | null = null;
  const listeners = new Set<(view: JoinView) => void>();

  function setView(next: JoinView) {
    view = next;
    for (const listener of listeners) listener(view);
  }

  async function runPipeline(gen: number, ref: string) {
    const identity = await ports.identity.current();
    if (gen !== generation) return;

    if (identity.kind === 'unavailable') {
      setView(unavailableView('identity_unavailable'));
      return;
    }
    if (identity.kind === 'signed_out') {
      setView(SIGN_IN_VIEW);
      return;
    }

    await checkInvitation(gen, ref, identity.principal);
  }

  async function checkInvitation(gen: number, ref: string, principal: AuthPrincipal) {
    setView({ phase: 'checking_invitation', email: principal.verifiedEmail, roomId: null, retryAllowed: false, errorCode: null });
    const state = await ports.admission.inspect(ref);
    if (gen !== generation) return;

    const phase = inviteStatePhase(state);
    if (phase === 'sign_in') {
      setView(SIGN_IN_VIEW);
      return;
    }
    if (phase !== null) {
      setView({
        phase,
        email: principal.verifiedEmail,
        roomId: null,
        retryAllowed: state === 'unavailable',
        errorCode: state === 'unavailable' ? 'invitation_unavailable' : null,
      });
      return;
    }

    await ensureDevice(gen, ref, principal);
  }

  async function ensureDevice(gen: number, ref: string, principal: AuthPrincipal) {
    setView({ phase: 'initializing_device', email: principal.verifiedEmail, roomId: null, retryAllowed: false, errorCode: null });
    const result = await ports.device.ensureReady(principal.ownerId);
    if (gen !== generation) return;

    if (result.kind === 'rejected') {
      if (result.code === 'owner_mismatch') {
        setView({ phase: 'wrong_account', email: principal.verifiedEmail, roomId: null, retryAllowed: false, errorCode: null });
      } else {
        setView(unavailableView('unsupported_environment', false, principal.verifiedEmail));
      }
      return;
    }
    if (result.kind === 'unavailable' || result.kind === 'outcome_unknown') {
      setView(unavailableView('device_unavailable', true, principal.verifiedEmail));
      return;
    }
    if (result.value.state !== 'ready' || result.value.deviceId === null) {
      setView(unavailableView(deviceReasonErrorCode(result.value.reason), true, principal.verifiedEmail));
      return;
    }

    await admit(gen, ref, principal, result.value.deviceId);
  }

  async function admit(gen: number, ref: string, principal: AuthPrincipal, deviceId: DeviceId) {
    setView({ phase: 'joining', email: principal.verifiedEmail, roomId: null, retryAllowed: false, errorCode: null });
    operationId ??= globalThis.crypto.randomUUID();
    const result = await ports.admission.admit({ operationId, inviteRef: ref, deviceId });
    if (gen !== generation) return;

    if (result.kind === 'ok') {
      operationId = null;
      setView({ phase: 'joined', email: principal.verifiedEmail, roomId: result.value.room.roomId, retryAllowed: false, errorCode: null });
      return;
    }
    if (result.kind === 'rejected') {
      operationId = null;
      const phase = admissionRejectionPhase(result.code);
      if (phase === 'sign_in') {
        setView(SIGN_IN_VIEW);
        return;
      }
      if (phase === 'unavailable') {
        // operation_mismatch: the attempt's operation id is already cleared above,
        // so a retry claims a fresh one rather than reusing a rejected id.
        setView(unavailableView('admission_rejected', true, principal.verifiedEmail));
        return;
      }
      setView({ phase, email: principal.verifiedEmail, roomId: null, retryAllowed: false, errorCode: null });
      return;
    }
    if (result.kind === 'unavailable') {
      setView(unavailableView('admission_unavailable', true, principal.verifiedEmail));
      return;
    }
    // outcome_unknown: keep the same operation ID. A retry re-sends it unchanged and
    // resolves the same attempt; it never issues a second claim with a new one.
    setView(unavailableView('admission_unknown', true, principal.verifiedEmail));
  }

  function start(locationUrl: string) {
    generation += 1;
    const gen = generation;
    operationId = null;
    const location = ports.codec.parseJoinLocation(locationUrl);
    if ('error' in location) {
      inviteRef = null;
      setView(unavailableView('invalid_location', false));
      return;
    }
    inviteRef = location.inviteRef;
    setView(CHECKING_IDENTITY_VIEW);
    void runPipeline(gen, location.inviteRef);
  }

  function retry() {
    if (inviteRef === null) return;
    generation += 1;
    const gen = generation;
    setView(CHECKING_IDENTITY_VIEW);
    void runPipeline(gen, inviteRef);
  }

  async function signIn(): Promise<void> {
    if (inviteRef === null) return;
    const gen = generation;
    const returnPath = buildReturnPath(inviteRef);
    const result = await ports.identity.beginSignIn(returnPath);
    if (gen !== generation) return;
    if (result.kind === 'ok') {
      ports.navigate(result.value.url);
      return;
    }
    setView(unavailableView(result.kind === 'rejected' ? 'invalid_return_path' : 'identity_unavailable'));
  }

  return {
    getView: () => view,
    subscribe: listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    start,
    retry,
    signIn,
  };
}
