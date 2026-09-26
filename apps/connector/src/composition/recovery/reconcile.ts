// Reconciliation of a reopened or restored connector ledger (KHA-136). It decides from
// the storage inspection alone and never repairs: a release with any dispatch evidence
// keeps an unknown outcome and stays held, whatever an older snapshot says about it.

import type { ReleaseId, SessionBinding } from '@khala/contracts/delivery/index';
import type { RecoveryBlocker, RecoveryReport } from '@khala/connector/storage/recovery';

/**
 * Why dispatch stays blocked after a restore.
 *
 * - `integrity_failed` / `payload_damaged`: the ledger cannot be trusted to say what ran.
 * - `binding_revoked`: this binding, or its device, is revoked. Revocation is permanent.
 * - `stale_generation`: the ledger already holds a newer generation of this binding.
 */
export type RestoreBlockReason = 'integrity_failed' | 'payload_damaged' | 'binding_revoked' | 'stale_generation';

export type RestoreReconciliation = Readonly<{
  dispatch: 'allowed' | 'blocked';
  reasons: readonly RestoreBlockReason[];
  /** Dispatch began and no terminal receipt exists. Never redispatched automatically. */
  heldReleaseIds: readonly ReleaseId[];
  /** No dispatch evidence at all. Eligible only through the dispatcher's own checks. */
  undispatchedReleases: number;
  /** Pending records of an older generation. Kept, never adopted by this binding. */
  staleGenerationPending: number;
  quarantined: number;
}>;

const LEDGER_BLOCKERS: readonly (RecoveryBlocker & RestoreBlockReason)[] = ['integrity_failed', 'payload_damaged'];

/**
 * `ledgerGeneration` is the generation the ledger records for this binding ID, or null when it has
 * none. A ledger ahead of the running binding means a newer connection exists, so this one never
 * dispatches. Quarantine is per stream and already enforced by storage, so it is reported, not blocking.
 */
export function reconcileRestoredLedger(
  report: RecoveryReport,
  binding: SessionBinding,
  ledgerGeneration: number | null,
): RestoreReconciliation {
  const reasons: RestoreBlockReason[] = LEDGER_BLOCKERS.filter(blocker => report.blocked.includes(blocker));
  if (report.revokedBindings.includes(binding.bindingId)) reasons.push('binding_revoked');
  if (ledgerGeneration !== null && ledgerGeneration > binding.generation) reasons.push('stale_generation');
  return {
    dispatch: reasons.length === 0 ? 'allowed' : 'blocked',
    reasons,
    heldReleaseIds: [...report.outcomeUnknownReleases],
    undispatchedReleases: report.undispatchedReleases.length,
    staleGenerationPending: report.staleGenerationPending,
    quarantined: report.quarantined,
  };
}
