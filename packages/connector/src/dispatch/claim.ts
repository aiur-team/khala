// The dispatch linearization point. One local transaction rechecks effective controls, reserves
// budget and persists the dispatch intent. A control applied to the ledger before this transaction
// blocks the job; one applied after it cannot recall the submission that follows.

import {
  type HarnessCapabilities, type ReleasedJob, type UnverifiedReleasedJob, sameEventRef, sameSessionBinding,
} from '@khala/contracts/delivery/index';
import { checkLimits, expired, reserve, usablePolicy } from './budget';
import type { BlockCode, ClaimResult, DispatchRecord, DispatchTx } from './types';

export type ClaimInput = Readonly<{
  /** The stored release, already verified against its approval and payload digest. */
  job: ReleasedJob;
  harnessBusy: HarnessCapabilities['busy'];
  now: Date;
  attemptId: string;
  workerId: string;
}>;

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

/** Runs inside `DispatchLedger.transact`. Never performs an external effect. */
export function claim(tx: DispatchTx, input: ClaimInput): ClaimResult {
  const { job } = input;
  const record = tx.record(job.releaseId);
  if (record === null || record.state !== 'queued' || !sameRelease(record.job, job)) {
    return { kind: 'blocked', code: 'claimed_elsewhere' };
  }

  const block = (code: BlockCode, terminal: boolean): ClaimResult => {
    if (terminal) tx.put({ ...record, state: 'rejected', reason: code });
    else if (record.reason !== code) tx.put({ ...record, reason: code });
    return { kind: 'blocked', code };
  };

  const policy = tx.policy();
  if (!usablePolicy(policy)) return block('unconfigured', false);

  const current = tx.binding(job.binding.bindingId);
  if (current === null) return block('stale_binding', true);
  if (current.revoked) return block('revoked', true);
  if (!sameSessionBinding(current.binding, job.binding)) return block('stale_binding', true);
  if (job.policyVersion !== policy.version) return block('stale_policy', true);
  if (policy.paused) return block('paused', false);
  if (expired(policy, input.now)) return block('expired', false);

  const limited = checkLimits(tx, policy, record, input.harnessBusy);
  if (limited !== null) return block(limited.code, limited.terminal);

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
  };
}
