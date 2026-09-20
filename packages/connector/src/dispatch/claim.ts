// The dispatch linearization point. One local transaction rechecks effective controls, reserves
// budget and persists the dispatch intent. A control applied to the ledger before this transaction
// blocks the job; one applied after it cannot recall the submission that follows.

import {
  type HarnessCapabilities, type ReleasedJob, type UnverifiedReleasedJob, sameEventRef, sameSessionBinding,
} from '@khala/contracts/delivery/index';
import { checkLimits, currentRelease, expired, reserve, supportedRoute, usablePolicy } from './budget';
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
 * Effective controls for one queued record, all read from the release's own binding. Without
 * `capabilities` (a precheck before the harness was inspected) the route is not checked yet.
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
  if (expired(policy, now)) return { code: 'expired', terminal: false };
  if (capabilities !== null && !supportedRoute(capabilities, job.binding, allowExperimentalAgentListener)) {
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
 * Runs inside `DispatchLedger.transact` before any verification. It records why a queued job
 * cannot claim now, so a paused or exhausted job is not re-verified on every wake. Returns the
 * record when it may go on to verification and the claim, which checks everything again.
 */
export function precheck(tx: DispatchTx, releaseId: DispatchRecord['releaseId'], now: Date): DispatchRecord | null {
  const record = tx.record(releaseId);
  if (record?.state !== 'queued') return null;
  const refused = refusal(tx, record, now, null);
  if (refused === null) return record;
  block(tx, record, refused);
  return null;
}

/** Runs inside `DispatchLedger.transact`. Never performs an external effect. */
export function claim(tx: DispatchTx, input: ClaimInput): ClaimResult {
  const { job } = input;
  const record = tx.record(job.releaseId);
  if (record === null || record.state !== 'queued' || !sameRelease(record.job, job)) {
    return { kind: 'blocked', code: 'claimed_elsewhere' };
  }

  const refused = refusal(tx, record, input.now, input.capabilities, input.allowExperimentalAgentListener ?? false);
  if (refused !== null) return block(tx, record, refused);

  reserve(tx, record);
  tx.put({
    ...record,
    state: 'dispatching',
    reason: null,
    attemptId: input.attemptId,
    workerId: input.workerId,
    claimedAt: input.now.toISOString(),
  });
  return { kind: 'claimed', attemptId: input.attemptId, job };
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
  };
}
