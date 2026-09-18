// Finite automation limits, evaluated inside the claim transaction. Counters are keyed by the
// release's trusted causal root, which the releaser sets from connector metadata; nothing the model
// authors reaches this module, and nothing here resets or refunds a reservation.

import type { HarnessCapabilities } from '@khala/contracts/delivery/index';
import { ACTIVE_STATES, type BlockCode, type DispatchPolicy, type DispatchRecord, type DispatchTx } from './types';

const positive = (value: unknown): boolean => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/** A policy is usable only with explicit finite limits; anything else blocks dispatch. */
export function usablePolicy(policy: DispatchPolicy | null): policy is DispatchPolicy {
  if (policy === null) return false;
  if (!Number.isSafeInteger(policy.version) || policy.version < 0) return false;
  if (!positive(policy.maxJobsPerCausalRoot) || !positive(policy.maxConcurrentJobs)) return false;
  if (policy.expiresAt !== null && Number.isNaN(Date.parse(policy.expiresAt))) return false;
  return ['queue', 'wait', 'reject'].includes(policy.busy);
}

export function expired(policy: DispatchPolicy, now: Date): boolean {
  return policy.expiresAt !== null && now.getTime() >= Date.parse(policy.expiresAt);
}

/**
 * The limit check for one queued record. `null` means the record may reserve; `terminal` marks a
 * refusal that no later pass can change.
 */
export function checkLimits(
  tx: DispatchTx,
  policy: DispatchPolicy,
  record: DispatchRecord,
  harnessBusy: HarnessCapabilities['busy'],
): Readonly<{ code: BlockCode; terminal: boolean }> | null {
  const active = tx.active();
  if (tx.causalCount(record.job.causalRootId) >= policy.maxJobsPerCausalRoot) {
    return { code: 'budget_exhausted', terminal: false };
  }
  if (active.length >= policy.maxConcurrentJobs) return { code: 'at_capacity', terminal: false };
  if (active.some(other => other.job.binding.bindingId === record.job.binding.bindingId)) {
    if (policy.busy === 'reject') return { code: 'busy', terminal: true };
    // Queueing behind active work needs a harness route proven to queue. Without it the job waits;
    // it never starts a replacement turn.
    if (policy.busy === 'wait' || harnessBusy !== 'queue') return { code: 'busy', terminal: false };
  }
  return null;
}

/** Reserves one attempt under the record's causal root. Call only in the claiming transaction. */
export function reserve(tx: DispatchTx, record: DispatchRecord): void {
  const root = record.job.causalRootId;
  tx.setCausalCount(root, tx.causalCount(root) + 1);
}

export const isActive = (record: DispatchRecord): boolean => ACTIVE_STATES.includes(record.state);
