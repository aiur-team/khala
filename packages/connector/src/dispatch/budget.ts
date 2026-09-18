// Finite automation limits, evaluated inside the claim transaction. Counters are keyed by the
// release's trusted causal root, which the releaser sets from connector metadata; nothing the model
// authors reaches this module, and nothing here resets or refunds a reservation.

import { decodeWith, utcTimestamp } from '@khala/contracts/delivery/decode';
import type { HarnessCapabilities, SessionBinding } from '@khala/contracts/delivery/index';
import type { BlockCode, DispatchPolicy, DispatchRecord, DispatchTx } from './types';

const POLICY_KEYS = ['busy', 'expiresAt', 'maxConcurrentJobs', 'maxJobsPerCausalRoot', 'paused', 'version'];
const BUSY_POLICIES: readonly unknown[] = ['queue', 'wait', 'reject'];

const positive = (value: unknown): boolean => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/**
 * A policy is usable only with exactly the known fields, an explicit pause flag, finite limits and
 * a strict UTC expiry. Anything else, including a missing field, blocks dispatch.
 */
export function usablePolicy(policy: DispatchPolicy | null): policy is DispatchPolicy {
  if (typeof policy !== 'object' || policy === null) return false;
  const keys = Object.keys(policy).sort();
  if (keys.length !== POLICY_KEYS.length || keys.some((key, index) => key !== POLICY_KEYS[index])) return false;
  if (typeof policy.paused !== 'boolean') return false;
  if (!Number.isSafeInteger(policy.version) || policy.version < 0) return false;
  if (!positive(policy.maxJobsPerCausalRoot) || !positive(policy.maxConcurrentJobs)) return false;
  if (policy.expiresAt !== null && !decodeWith(() => utcTimestamp(policy.expiresAt, 'expiresAt')).ok) return false;
  return BUSY_POLICIES.includes(policy.busy);
}

export function expired(policy: DispatchPolicy, now: Date): boolean {
  return policy.expiresAt !== null && now.getTime() >= Date.parse(policy.expiresAt);
}

/**
 * Whether the harness route may receive this binding's job at all. Delivery must resume the existing
 * session (KD1) on a supported route for the bound harness, and the route's busy behavior must be
 * known not to steer a turn already running.
 */
export function supportedRoute(capabilities: HarnessCapabilities, binding: SessionBinding): boolean {
  return capabilities.support !== 'unsupported'
    && capabilities.existingSession === 'khala_hosted_resume'
    && capabilities.harness === binding.harness
    && (capabilities.busy === 'queue' || capabilities.busy === 'reject');
}

/**
 * The limit check for one queued record. `null` means the record may reserve; `terminal` marks a
 * refusal that no later pass can change. Without `harnessBusy` (a precheck before the harness was
 * inspected) a `queue` policy behind active work is left to the claim to decide.
 */
export function checkLimits(
  tx: DispatchTx,
  policy: DispatchPolicy,
  record: DispatchRecord,
  harnessBusy: HarnessCapabilities['busy'] | null,
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
    if (policy.busy === 'wait' || (harnessBusy !== null && harnessBusy !== 'queue')) return { code: 'busy', terminal: false };
  }
  return null;
}

/** Reserves one attempt under the record's causal root. Call only in the claiming transaction. */
export function reserve(tx: DispatchTx, record: DispatchRecord): void {
  const root = record.job.causalRootId;
  tx.setCausalCount(root, tx.causalCount(root) + 1);
}
