// The dispatch linearization points. A scheduler claim rechecks effective controls and the listening
// mode, reserves budget once and snapshots the exact route in one local transaction. Promotion, in a
// second transaction at the proved boundary, revalidates that snapshot and persists the no-return
// dispatch intent. A control applied before the claim blocks the job; a pause or mode change applied
// after it does not recall the attempt, while route, evidence or session drift returns it to pending.

import {
  type HarnessCapabilities, type ReleasedJob, type SessionBinding, type UnverifiedReleasedJob,
  sameEventRef, sameSessionBinding,
} from '@khala/contracts/delivery/index';
import {
  checkLimits, currentRelease, dispatchMode, expired, reserve, routeSnapshot, sameSnapshot, supportedRoute,
  usablePolicy,
} from './budget';
import type { BlockCode, ClaimResult, DispatchRecord, DispatchTx } from './types';

export type ClaimInput = Readonly<{
  /** The stored release, already verified against its approval and payload digest. */
  job: ReleasedJob;
  /** The harness route the payload will be submitted to. */
  capabilities: HarnessCapabilities;
  /** Read inside the claiming transaction. */
  now: Date;
  attemptId: string;
  workerId: string;
  allowExperimentalAgentListener?: boolean;
}>;

export type PromoteInput = Readonly<{
  releaseId: DispatchRecord['releaseId'];
  attemptId: string;
  /** The session the boundary reported, and its decoded capabilities; null when undecodable. */
  binding: SessionBinding;
  capabilities: HarnessCapabilities | null;
  /** The exact bytes that will be submitted. */
  payloadBytes: number;
  allowExperimentalAgentListener?: boolean;
}>;

/**
 * `dispatching`: the no-return intent is durable and the submission may start. `requeued`: the
 * attempt went back to pending before any effect. `rejected`: the binding was revoked. `gone`: the
 * claim is no longer this attempt's to promote.
 */
export type PromoteResult =
  | Readonly<{ kind: 'dispatching' }>
  | Readonly<{ kind: 'requeued' | 'rejected'; code: BlockCode }>
  | Readonly<{ kind: 'gone' }>;

type Refusal = Readonly<{ code: BlockCode; terminal: boolean }>;

export function sameRelease(a: UnverifiedReleasedJob, b: UnverifiedReleasedJob): boolean {
  return a.v === b.v
    && a.releaseId === b.releaseId
    && a.approval.commandId === b.approval.commandId
    && a.approval.policyVersion === b.approval.policyVersion
    && a.approval.bindingGeneration === b.approval.bindingGeneration
    && sameSessionBinding(a.binding, b.binding)
    && a.policyVersion === b.policyVersion
    && a.events.length === b.events.length
    && a.events.every((event, index) => sameEventRef(event, b.events[index]!))
    && a.payloadRef === b.payloadRef
    && a.payloadDigest === b.payloadDigest
    && a.causalRootId === b.causalRootId;
}

/**
 * Effective controls for one queued record, all read from the release's own binding. Pause wins over
 * every mode, and the mode is checked before any harness is inspected. Without `capabilities` (a
 * precheck before the harness was inspected) the route is not checked yet.
 */
function refusal(
  tx: DispatchTx,
  record: DispatchRecord,
  now: Date,
  capabilities: HarnessCapabilities | null,
  allowExperimentalAgentListener = false,
): Refusal | null {
  const { job } = record;
  const current = tx.binding(job.binding.bindingId);
  if (current === null) return { code: 'stale_binding', terminal: true };
  if (current.revoked) return { code: 'revoked', terminal: true };
  if (!sameSessionBinding(current.binding, job.binding)) return { code: 'stale_binding', terminal: true };

  const policy = tx.policy(job.binding.bindingId);
  if (!usablePolicy(policy)) return { code: 'unconfigured', terminal: false };
  if (!currentRelease(policy, job.policyVersion)) return { code: 'stale_policy', terminal: true };
  if (policy.paused) return { code: 'paused', terminal: false };
  const mode = dispatchMode(policy.listening);
  if (mode === 'mode_async' || mode === 'mode_unavailable') return { code: mode, terminal: false };
  if (expired(policy, now)) return { code: 'expired', terminal: false };
  if (capabilities !== null && (!supportedRoute(capabilities, job.binding, allowExperimentalAgentListener)
    || routeSnapshot(capabilities, job.binding, mode, policy.listening.evidenceRevision) === null)) {
    return { code: 'harness_unsupported', terminal: false };
  }
  return checkLimits(tx, policy, record, capabilities?.busy ?? null);
}

function block(tx: DispatchTx, record: DispatchRecord, { code, terminal }: Refusal): ClaimResult {
  if (terminal) tx.put({ ...record, state: 'rejected', reason: code });
  else if (record.reason !== code) tx.put({ ...record, reason: code });
  return { kind: 'blocked', code };
}

/**
 * Runs inside `DispatchLedger.transact` before any verification or harness call. It records why a
 * queued job cannot claim now, so a paused, `async` or exhausted job is not re-verified on every
 * wake. `proceed` means it may go on to verification and the claim, which checks everything again.
 * `held` names a binding whose later releases must not overtake this one; a job whose earlier
 * release on the same binding is held in this pass is skipped unchanged. An exhausted causal root
 * holds only itself, so another root on the same binding stays eligible.
 */
export function precheck(
  tx: DispatchTx,
  releaseId: DispatchRecord['releaseId'],
  now: Date,
  held: ReadonlySet<string> = new Set(),
): PrecheckResult {
  const record = tx.record(releaseId);
  if (record?.state !== 'queued') return { kind: 'skip' };
  const bindingId = record.job.binding.bindingId;
  if (held.has(bindingId)) return { kind: 'held', bindingId };
  const refused = refusal(tx, record, now, null);
  if (refused === null) return { kind: 'proceed', record };
  block(tx, record, refused);
  return refused.terminal || refused.code === 'budget_exhausted' ? { kind: 'skip' } : { kind: 'held', bindingId };
}

export type PrecheckResult =
  | Readonly<{ kind: 'proceed'; record: DispatchRecord }>
  | Readonly<{ kind: 'held'; bindingId: DispatchRecord['job']['binding']['bindingId'] }>
  | Readonly<{ kind: 'skip' }>;

/**
 * Whether an arrival on this binding may wake the dispatcher: only an unpaused, usable policy whose
 * effective mode is `steer` or `sync`. An `async` arrival only persists.
 */
export function wakeable(tx: DispatchTx, job: UnverifiedReleasedJob): boolean {
  const policy = tx.policy(job.binding.bindingId);
  if (!usablePolicy(policy) || policy.paused) return false;
  const mode = dispatchMode(policy.listening);
  return mode === 'steer' || mode === 'sync';
}

/**
 * The scheduler claim. Runs inside `DispatchLedger.transact` and never performs an external effect.
 * It reserves the release's one causal attempt and snapshots `modeAtClaim` with the exact route.
 */
export function claim(tx: DispatchTx, input: ClaimInput): ClaimResult {
  const { job } = input;
  const record = tx.record(job.releaseId);
  if (record === null || record.state !== 'queued' || !sameRelease(record.job, job)) {
    return { kind: 'blocked', code: 'claimed_elsewhere' };
  }

  const refused = refusal(tx, record, input.now, input.capabilities, input.allowExperimentalAgentListener ?? false);
  if (refused !== null) return block(tx, record, refused);
  // `refusal` has already required a usable policy and an evidenced route for its dispatch mode.
  const { listening } = tx.policy(job.binding.bindingId)!;
  const snapshot = routeSnapshot(input.capabilities, job.binding, listening.effective as 'steer' | 'sync', listening.evidenceRevision)!;

  reserve(tx, record);
  tx.put({
    ...record,
    state: 'claimed',
    reason: null,
    attemptId: input.attemptId,
    workerId: input.workerId,
    claimedAt: input.now.toISOString(),
    snapshot,
    reserved: true,
  });
  return { kind: 'claimed', attemptId: input.attemptId, job, snapshot };
}

/**
 * Returns a pre-effect scheduler claim to pending with its reservation kept, so a later claim does
 * not reserve again and nothing is acknowledged. Pass `attemptId` to requeue only that attempt.
 */
export function requeue(
  tx: DispatchTx,
  releaseId: DispatchRecord['releaseId'],
  code: BlockCode,
  attemptId: string | null = null,
): boolean {
  const record = tx.record(releaseId);
  if (record?.state !== 'claimed' || (attemptId !== null && record.attemptId !== attemptId)) return false;
  tx.put({
    ...record,
    state: 'queued',
    reason: code,
    attemptId: null,
    workerId: null,
    claimedAt: null,
    snapshot: null,
    reserved: true,
  });
  return true;
}

/**
 * Promotion at the proved boundary. Runs inside `DispatchLedger.transact` immediately before the
 * submission. The durable binding and every snapshot field must still match what the boundary
 * reported; a pause or mode change since the claim is deliberately not rechecked.
 */
export function promote(tx: DispatchTx, input: PromoteInput): PromoteResult {
  const record = tx.record(input.releaseId);
  if (record?.state !== 'claimed' || record.attemptId !== input.attemptId || record.snapshot === null) {
    return { kind: 'gone' };
  }
  const { job, snapshot } = record;
  const drift = (code: BlockCode): PromoteResult => {
    requeue(tx, record.releaseId, code, input.attemptId);
    return { kind: 'requeued', code };
  };

  const current = tx.binding(job.binding.bindingId);
  if (current?.revoked === true) {
    tx.put({ ...record, state: 'rejected', reason: 'revoked', attemptId: null, workerId: null, claimedAt: null, snapshot: null });
    return { kind: 'rejected', code: 'revoked' };
  }
  // The durable binding, then the session the boundary is about to deliver into: a replacement on
  // either side must never receive this attempt.
  if (current === null || !sameSessionBinding(current.binding, job.binding)) return drift('route_drift');
  if (!sameSessionBinding(input.binding, job.binding)) return drift('route_drift');

  const { capabilities } = input;
  if (capabilities === null || !supportedRoute(capabilities, job.binding, input.allowExperimentalAgentListener ?? false)) {
    return drift('route_drift');
  }
  const observed = routeSnapshot(capabilities, job.binding, snapshot.modeAtClaim, snapshot.evidenceRevision);
  if (observed === null || !sameSnapshot(observed, snapshot)) return drift('route_drift');

  if (job.events.length > capabilities.limits.maxSelectionEvents || input.payloadBytes > capabilities.limits.maxPayloadBytes) {
    return drift('boundary_limit');
  }

  tx.put({ ...record, state: 'dispatching' });
  return { kind: 'dispatching' };
}

/** A new queued record. Enqueueing reserves nothing. */
export function queuedRecord(job: UnverifiedReleasedJob, seq: number): DispatchRecord {
  return {
    releaseId: job.releaseId,
    seq,
    job,
    state: 'queued',
    reason: null,
    attemptId: null,
    workerId: null,
    claimedAt: null,
    receipts: [],
    abandonedBy: null,
    snapshot: null,
    reserved: false,
  };
}
