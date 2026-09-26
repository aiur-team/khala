import {
  decodePairingOwnerResult,
  type Disposer,
  type OperationResult,
  type PairingDecisionRequest,
  type PairingOwnerResult,
} from '@khala/contracts/messaging/index';
import { isDecidable, type DecisionChoice, type DecisionStatus } from '../approval-decision/model';
import { INITIAL_PAIRING_VIEW, claimIdentity, isAwaitingDecision, type PairingView } from './model';
import type { PairingApprovalPort } from './ports';

export interface PairingApprovalController {
  getView(): PairingView;
  subscribe(listener: (view: PairingView) => void): Disposer;
  /** Loads the request. Idempotent. */
  start(): void;
  refresh(): void;
  /** Decides only the displayed claim, at the displayed revision. */
  decide(choice: DecisionChoice): void;
  /** Resends the held decision with its original operation ID. */
  retry(): void;
  dispose(): void;
}

export type PairingApprovalOptions = Readonly<{
  createId?: () => string;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}>;

const defaultCreateId = (): string =>
  typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `op_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;

const RETRYABLE_MESSAGE = 'Could not confirm your decision with the server. Retry sends the same decision; it is never recorded twice.';
const EXPIRED_MESSAGE = 'This pairing request expired. Nothing was granted.';
const CHANGED_MESSAGE = 'The agent session changed while you were reviewing it. The new session is shown; review it and decide again.';
const RELOADED_MESSAGE = 'This request changed while you were reviewing it. It has been reloaded; review it and decide again.';
const CONFLICT_MESSAGE = 'This pairing request was already decided in another window.';
const AUTHORITY_MESSAGE = 'You can no longer decide this pairing request. Only the channel’s current owner can.';
const MAX_TIMER_MS = 2_147_000_000;

type Held = Readonly<{ request: PairingDecisionRequest; decision: DecisionChoice }>;

/** The status a projection implies on its own, or null when the owner can still decide it. */
function terminalStatus(pairing: PairingOwnerResult, nowMs: number): DecisionStatus | null {
  switch (pairing.state) {
    case 'approved':
      return { kind: 'decided', message: 'Approved. The agent joins when its connector picks this up; this page shows when it connects.' };
    case 'denied':
      return { kind: 'decided', message: 'Denied. Nothing was granted.' };
    case 'expired':
      return { kind: 'blocked', message: EXPIRED_MESSAGE };
    case 'issued':
      return { kind: 'blocked', message: 'No agent has claimed this code yet. Nothing to decide.' };
    case 'claimed':
      return isAwaitingDecision(pairing, nowMs) ? null : { kind: 'blocked', message: EXPIRED_MESSAGE };
  }
}

export function createPairingApprovalController(
  port: PairingApprovalPort,
  requestHandle: string,
  options: PairingApprovalOptions = {},
): PairingApprovalController {
  const createId = options.createId ?? defaultCreateId;
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? (timer => clearTimeout(timer as ReturnType<typeof setTimeout>));
  let view: PairingView = INITIAL_PAIRING_VIEW;
  let started = false;
  let disposed = false;
  let readSequence = 0;
  // One held decision, reused only by `retry()`, so a lost response resolves
  // to the same decision instead of a second one. A changed claim drops it.
  let held: Held | null = null;
  let inFlight: Held | null = null;
  let expiryTimer: unknown = null;
  const listeners = new Set<(view: PairingView) => void>();

  function emit(next: PairingView): void {
    view = next;
    if (disposed) return;
    for (const listener of listeners) listener(view);
  }

  function setStatus(status: DecisionStatus): void {
    emit({ ...view, status });
  }

  function clearExpiry(): void {
    if (expiryTimer !== null) clearTimer(expiryTimer);
    expiryTimer = null;
  }

  function armExpiry(pairing: PairingOwnerResult): void {
    clearExpiry();
    if (pairing.state !== 'claimed' && pairing.state !== 'issued') return;
    const wait = Date.parse(pairing.expiresAt) - now();
    // A wait longer than the timer limit re-arms itself when it fires early.
    expiryTimer = setTimer(expire, Math.min(Math.max(wait, 0), MAX_TIMER_MS));
  }

  /** Expiry is terminal: the decision controls go away and nothing is sent. */
  function expire(): void {
    expiryTimer = null;
    const pairing = view.pairing;
    if (disposed || !pairing || (pairing.state !== 'claimed' && pairing.state !== 'issued')) return;
    if (now() < Date.parse(pairing.expiresAt)) return armExpiry(pairing);
    held = null;
    emit({ ...view, pairing: { ...pairing, state: 'expired' }, status: { kind: 'blocked', message: EXPIRED_MESSAGE } });
    // The server is authoritative; a decision that landed first wins.
    void read();
  }

  function decodeOwner(value: unknown): PairingOwnerResult | null {
    const decoded = decodePairingOwnerResult(value);
    return decoded.ok && decoded.value.requestHandle === requestHandle ? decoded.value : null;
  }

  /** Applies a fresh server projection, discarding any decision made about a different claim. */
  function reconcile(next: PairingOwnerResult): void {
    const previous = view.pairing;
    const terminal = terminalStatus(next, now());
    armExpiry(next);
    if (terminal !== null) {
      held = null;
      return emit({ ...view, phase: 'ready', pairing: next, readOnly: false, status: terminal });
    }
    const changed = previous !== null && previous.state === 'claimed' && claimIdentity(previous) !== claimIdentity(next);
    if (changed) held = null;
    const status: DecisionStatus = changed
      ? { kind: 'refreshed', message: CHANGED_MESSAGE }
      : view.status.kind === 'reloading'
        ? { kind: 'refreshed', message: RELOADED_MESSAGE }
        : view.status.kind === 'blocked' || view.status.kind === 'decided' ? { kind: 'idle' } : view.status;
    emit({ ...view, phase: 'ready', pairing: next, readOnly: false, status });
  }

  function loseAuthority(): void {
    readSequence += 1;
    held = null;
    emit({ ...view, phase: view.pairing ? view.phase : 'unavailable', readOnly: true, status: { kind: 'blocked', message: AUTHORITY_MESSAGE } });
  }

  async function read(): Promise<void> {
    const sequence = ++readSequence;
    let result: OperationResult<unknown, string>;
    try {
      result = await port.inspect(requestHandle);
    } catch {
      result = { kind: 'unavailable', retryable: true };
    }
    if (disposed || sequence !== readSequence) return;
    if (result.kind === 'ok') {
      const next = decodeOwner(result.value);
      if (next !== null) return reconcile(next);
    } else if (result.kind === 'rejected') {
      if (result.code === 'not_found' || result.code === 'feature_unavailable') {
        held = null;
        clearExpiry();
        return emit({
          ...view,
          phase: 'unavailable',
          status: {
            kind: 'blocked',
            message: result.code === 'not_found' ? 'This pairing request is no longer available.' : 'Pairing is not available right now.',
          },
        });
      }
      return loseAuthority();
    }
    // Unreadable or unreachable: keep whatever was last shown.
    emit({ ...view, phase: view.pairing ? view.phase : 'load_failed' });
  }

  /** After a stale claim: nothing is decidable until the current version has loaded. */
  async function reloadForRedecision(): Promise<void> {
    setStatus({ kind: 'reloading', message: 'This request changed while you were reviewing it. Loading the current version…' });
    await read();
    if (disposed) return;
    if (view.status.kind === 'reloading') {
      setStatus({ kind: 'blocked', message: 'This request changed, and its current version could not be loaded. Close it and review it again.' });
    }
  }

  async function submit(current: Held): Promise<void> {
    if (held !== current) return;
    inFlight = current;
    setStatus({ kind: 'submitting', decision: current.decision });
    let result: OperationResult<unknown, string>;
    try {
      result = await port.decide(current.request);
    } catch {
      result = { kind: 'outcome_unknown', operationId: current.request.operationId };
    }
    if (inFlight === current) inFlight = null;
    // A refresh or a changed claim already superseded this decision.
    if (disposed || held !== current) return;
    if (result.kind === 'ok') {
      const next = decodeOwner(result.value);
      if (next !== null) {
        const expected = current.decision === 'approve' ? 'approved' : 'denied';
        // Only a result for the displayed claim counts as this decision.
        if (next.state === expected && next.claim?.fingerprint === current.request.claimFingerprint) {
          held = null;
          readSequence += 1;
          clearExpiry();
          return emit({ ...view, pairing: next, status: terminalStatus(next, now())! });
        }
        held = null;
        return reconcile(next);
      }
      // An undecodable success is an unknown outcome: keep the decision held.
      result = { kind: 'outcome_unknown', operationId: current.request.operationId };
    }
    if (result.kind === 'rejected') {
      held = null;
      switch (result.code) {
        case 'signed_out':
        case 'forbidden':
          return loseAuthority();
        case 'stale_claim':
          return reloadForRedecision();
        case 'expired':
          setStatus({ kind: 'blocked', message: EXPIRED_MESSAGE });
          return void read();
        case 'decision_conflict':
          setStatus({ kind: 'blocked', message: CONFLICT_MESSAGE });
          return void read();
        default:
          return setStatus({ kind: 'blocked', message: `Nothing was recorded (${result.code}).` });
      }
    }
    // Unavailable or unknown: keep the held operation so a retry resolves to the same decision.
    setStatus({ kind: 'retryable', decision: current.decision, message: RETRYABLE_MESSAGE });
  }

  return {
    getView: () => view,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    start() {
      if (disposed || started) return;
      started = true;
      void read();
    },

    refresh() {
      if (!disposed) void read();
    },

    decide(choice) {
      const pairing = view.pairing;
      if (disposed || view.readOnly || !pairing || inFlight !== null || !isDecidable(view.status)) return;
      const claim = pairing.claim;
      if (!isAwaitingDecision(pairing, now()) || claim === null) {
        // Checked here as well as by the timer, so a stalled timer never lets a stale approval out.
        if (pairing.state === 'claimed') expire();
        return;
      }
      held = {
        decision: choice,
        request: {
          v: 1,
          requestHandle: pairing.requestHandle,
          revision: pairing.revision,
          claimFingerprint: claim.fingerprint,
          decision: choice,
          operationId: createId(),
        },
      };
      void submit(held);
    },

    retry() {
      const current = held;
      if (disposed || current === null || view.status.kind !== 'retryable' || inFlight !== null) return;
      void submit(current);
    },

    dispose() {
      disposed = true;
      clearExpiry();
      listeners.clear();
    },
  };
}
