// Named faults, each tied to one injection boundary and the oracle a scenario must
// check after it fires. Drivers call `checkpoint` at their boundaries; an armed fault
// that never reaches its boundary is itself a failure (`unfired`). A real component
// enacts a fault by calling `checkpoint` at the native seam that matches the boundary
// and turning the returned or thrown fault into native behaviour (a lost reply, an
// exited host, a busy thread).

import type { ScenarioClock } from './clock';
import type { EvidenceLog } from './evidence';

export const FAULTS = [
  'disconnect_before_write',
  'disconnect_after_write',
  'crash_after_pending',
  'crash_after_intent',
  'duplicate_event',
  'reordered_receipt',
  'keys_delayed',
  'session_busy',
  'session_exit',
] as const;

export type Fault = (typeof FAULTS)[number];

export const FAULT_BOUNDARIES = [
  'transport.before_write',
  'transport.after_write',
  'connector.after_pending',
  'connector.after_intent',
  'transport.deliver_event',
  'transport.deliver_receipts',
  'crypto.decrypt',
  'harness.accept',
] as const;

export type FaultBoundary = (typeof FAULT_BOUNDARIES)[number];

export type FaultSpec = Readonly<{
  boundary: FaultBoundary;
  /** Throwing faults interrupt the caller; the others are enacted by the driver. */
  effect: 'throw_disconnect' | 'throw_crash' | 'driver';
  /** Held faults keep firing at their boundary until cleared; others fire once. */
  held: boolean;
  oracle: string;
}>;

export const FAULT_SPECS: Readonly<Record<Fault, FaultSpec>> = {
  disconnect_before_write: {
    boundary: 'transport.before_write',
    effect: 'throw_disconnect',
    held: false,
    oracle: 'nothing reaches the model and the attempt is never reported as success',
  },
  disconnect_after_write: {
    boundary: 'transport.after_write',
    effect: 'throw_disconnect',
    held: false,
    oracle: 'the write happened but is unconfirmed: outcome_unknown, and no second submission',
  },
  crash_after_pending: {
    boundary: 'connector.after_pending',
    effect: 'throw_crash',
    held: false,
    oracle: 'the pending event survives restart and still reaches no model before approval',
  },
  crash_after_intent: {
    boundary: 'connector.after_intent',
    effect: 'throw_crash',
    held: false,
    oracle: 'after restart the intent is reconciled; resubmission only when reconciliation proves it safe',
  },
  duplicate_event: {
    boundary: 'transport.deliver_event',
    effect: 'driver',
    held: false,
    oracle: 'a redelivered event is one pending item and at most one model input',
  },
  reordered_receipt: {
    boundary: 'transport.deliver_receipts',
    effect: 'driver',
    held: false,
    oracle: 'receipts are independent facts; arrival order never regresses or advances a numeric progress',
  },
  keys_delayed: {
    boundary: 'crypto.decrypt',
    effect: 'driver',
    held: true,
    oracle: 'the event stays listed as undecryptable, never disappears, and is not releasable until keys arrive',
  },
  session_busy: {
    boundary: 'harness.accept',
    effect: 'driver',
    held: true,
    oracle: 'the harness busy capability decides the outcome; no silent drop or duplicate',
  },
  session_exit: {
    boundary: 'harness.accept',
    effect: 'driver',
    held: false,
    oracle: 'failed(session_unavailable); no replacement session is created',
  },
};

export class InjectedDisconnect extends Error {
  readonly fault: Fault;
  constructor(fault: Fault) {
    super(`injected ${fault}`);
    this.name = 'InjectedDisconnect';
    this.fault = fault;
  }
}

export class InjectedCrash extends Error {
  readonly fault: Fault;
  constructor(fault: Fault) {
    super(`injected ${fault}`);
    this.name = 'InjectedCrash';
    this.fault = fault;
  }
}

export type ArmedFault = Readonly<{ fault: Fault; ownerId: string }>;
export type FiredFault = Readonly<{ fault: Fault; ownerId: string; operationId: string; driver: string | null }>;

/** The boundary side of fault injection: what a driver calls where a fault can happen. */
export interface FaultBoundaryPort {
  /**
   * Called at `boundary` for `ownerId`. Throws for disconnect/crash faults, returns a
   * driver-enacted fault, or returns null when nothing is armed.
   */
  checkpoint(boundary: FaultBoundary, ownerId: string, operationId: string): Fault | null;
  /** Ends a held fault (for example, keys arrive or the session becomes idle). */
  clear(fault: Fault, ownerId: string): void;
}

export interface FaultInjector extends FaultBoundaryPort {
  arm(fault: Fault, ownerId: string): void;
  isArmed(fault: Fault, ownerId: string): boolean;
  armed(): readonly ArmedFault[];
  fired(): readonly FiredFault[];
  /** Armed faults that have not fired once: a scenario that injected them proved nothing. */
  unfired(): readonly ArmedFault[];
}

/** Shared fault state. The scenario hands out boundary ports stamped with a driver. */
export interface FaultState extends Omit<FaultInjector, keyof FaultBoundaryPort> {
  /** A boundary port whose firings are `driver`'s evidence; null is the in-process fake. */
  boundaryFor(driver: string | null): FaultBoundaryPort;
}

export function createFaultState(
  evidence: EvidenceLog,
  clockFor: (ownerId: string) => ScenarioClock,
): FaultState {
  const armed: { fault: Fault; ownerId: string; fired: boolean }[] = [];
  const fired: FiredFault[] = [];

  return {
    arm(fault, ownerId) {
      if (!FAULTS.includes(fault)) throw new TypeError(`unknown fault ${String(fault)}`);
      if (armed.some(entry => entry.fault === fault && entry.ownerId === ownerId)) {
        throw new Error(`${fault} is already armed for ${ownerId}`);
      }
      armed.push({ fault, ownerId, fired: false });
    },
    isArmed: (fault, ownerId) => armed.some(entry => entry.fault === fault && entry.ownerId === ownerId),
    armed: () => armed.map(({ fault, ownerId }) => ({ fault, ownerId })),
    fired: () => [...fired],
    unfired: () => armed.filter(entry => !entry.fired).map(({ fault, ownerId }) => ({ fault, ownerId })),
    boundaryFor: driver => ({
      clear(fault, ownerId) {
        const index = armed.findIndex(entry => entry.fault === fault && entry.ownerId === ownerId);
        if (index < 0) throw new Error(`${fault} is not armed for ${ownerId}`);
        if (!armed[index]!.fired) throw new Error(`${fault} for ${ownerId} was cleared before it fired`);
        armed.splice(index, 1);
      },
      checkpoint(boundary, ownerId, operationId) {
        const entry = armed.find(candidate => candidate.ownerId === ownerId
          && FAULT_SPECS[candidate.fault].boundary === boundary
          && (FAULT_SPECS[candidate.fault].held || !candidate.fired));
        if (!entry) return null;
        const spec = FAULT_SPECS[entry.fault];
        // Recorded before it counts: a live firing without a driver is refused here.
        evidence.record(`fault.${entry.fault}`, { ownerId, operationId }, clockFor(ownerId), driver);
        entry.fired = true;
        fired.push({ fault: entry.fault, ownerId, operationId, driver });
        if (spec.effect === 'throw_disconnect') throw new InjectedDisconnect(entry.fault);
        if (spec.effect === 'throw_crash') throw new InjectedCrash(entry.fault);
        return entry.fault;
      },
    }),
  };
}
