// U3: the owner-facing sweep report. Counts and reason codes only: no content,
// no event identifiers. It is owner UI and operations data, never a model-facing
// hint about pending content.

import type { DeferReason, DeleteReason } from './eligibility';

export type FailureReason = 'unavailable' | 'outcome_unknown' | 'invalid_ledger_answer';

/** Why no record was examined. */
export type RefusalReason = 'policy_absent' | 'policy_invalid' | 'clock_skew' | 'cursor_unavailable';

export type RetentionReason =
  | DeleteReason
  | DeferReason
  | FailureReason
  | 'already_deleted'
  | 'revision_conflict'
  | 'referenced'
  | 'stale_policy';

/**
 * - `complete`: every record was examined under this policy version.
 * - `budget_exhausted`: the per-call bound was reached; the next call resumes.
 * - `interrupted`: a store failed. Nothing after the failure was examined, and the
 *   next call resumes from the last confirmed record.
 * - `refused`: nothing was examined; see `refusal`.
 */
export type SweepOutcome = 'complete' | 'budget_exhausted' | 'interrupted' | 'refused';

/** Result of the SDK's own documented maintenance facility, if it has one. */
export type CryptoMaintenanceOutcome = 'completed' | 'unsupported' | 'failed' | 'not_run';

/**
 * What a local sweep cannot do. Every report lists all of them, so the owner UI
 * never presents local cleanup as global erasure.
 */
export const RETENTION_LIMITS = [
  // Content already released into a model session stays in that session's context.
  'released_model_context_not_recalled',
  // Other participants and their devices keep their own copies.
  'participant_copies_not_deleted',
  // Ciphertext held by the transport service follows its own retention.
  'remote_ciphertext_not_deleted',
  // Provider, OS and SDK key backups are outside this sweep.
  'backups_not_deleted',
  // File-level deletion is not a forensic secure erase (SSD remnants, journals).
  'not_secure_erase',
  // Receipts and dedup tombstones outlive content so replay is not treated as new.
  'minimal_identity_retained',
] as const;

export type RetentionLimit = (typeof RETENTION_LIMITS)[number];

export type RetentionReport = Readonly<{
  policyVersion: number | null;
  outcome: SweepOutcome;
  refusal: RefusalReason | null;
  examined: number;
  deleted: number;
  deferred: number;
  failed: number;
  /** Stale approvals the ledger invalidated because their pending content was deleted. */
  invalidatedApprovals: number;
  reasons: Readonly<Partial<Record<RetentionReason, number>>>;
  cryptoMaintenance: CryptoMaintenanceOutcome;
  limits: readonly RetentionLimit[];
}>;

export class ReportBuilder {
  examined = 0;
  deleted = 0;
  deferred = 0;
  failed = 0;
  invalidatedApprovals = 0;
  private readonly reasons: Partial<Record<RetentionReason, number>> = {};

  constructor(private readonly policyVersion: number | null) {}

  private count(reason: RetentionReason): void {
    this.examined += 1;
    this.reasons[reason] = (this.reasons[reason] ?? 0) + 1;
  }

  delete(reason: RetentionReason, invalidatedApprovals: number): void {
    this.count(reason);
    this.deleted += 1;
    this.invalidatedApprovals += invalidatedApprovals;
  }

  defer(reason: RetentionReason): void {
    this.count(reason);
    this.deferred += 1;
  }

  fail(reason: RetentionReason): void {
    this.count(reason);
    this.failed += 1;
  }

  build(outcome: SweepOutcome, cryptoMaintenance: CryptoMaintenanceOutcome): RetentionReport {
    return {
      policyVersion: this.policyVersion,
      outcome,
      refusal: null,
      examined: this.examined,
      deleted: this.deleted,
      deferred: this.deferred,
      failed: this.failed,
      invalidatedApprovals: this.invalidatedApprovals,
      reasons: { ...this.reasons },
      cryptoMaintenance,
      limits: RETENTION_LIMITS,
    };
  }
}

export function refusedReport(policyVersion: number | null, refusal: RefusalReason): RetentionReport {
  return { ...new ReportBuilder(policyVersion).build('refused', 'not_run'), refusal };
}
