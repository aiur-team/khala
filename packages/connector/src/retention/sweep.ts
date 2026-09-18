// U2: bounded, resumable sweep. Deletion goes through the ledger's
// reference-aware compare-and-set, which decides every race with approval,
// release and dispatch. The sweep only proposes; the ledger transaction disposes.

import {
  type ClaimStatus, type RetentionAction, type RetentionPolicy, type RetentionRecord,
  decodeRetentionPolicy, evaluateRecord,
} from './eligibility';
import { type CryptoMaintenanceOutcome, type RetentionReport, ReportBuilder, refusedReport } from './report';

export type Clock = Readonly<{ now: () => string }>;

/** Where an interrupted sweep resumes. Tied to one policy version. */
export type SweepCursor = Readonly<{ policyVersion: number; after: string | null }>;

/**
 * Records strictly after `after` in ascending `recordId` order, at most `limit`.
 * `exhausted` is true when no record follows this page.
 */
export type RecordPage =
  | Readonly<{ kind: 'page'; records: readonly RetentionRecord[]; exhausted: boolean }>
  | Readonly<{ kind: 'unavailable' }>;

export type RetentionOperation = Readonly<{
  /** Deterministic, so a retry after a lost response is recognised, not repeated. */
  operationId: string;
  recordId: string;
  expectedRevision: string;
  policyVersion: number;
  action: RetentionAction;
}>;

/**
 * - `applied`: bytes (or the tombstone) are gone and every pending approval that
 *   referenced them was invalidated in the same transaction.
 * - `already_applied`: this operation, or an equivalent one, already landed.
 * - `conflict`: the revision moved; nothing was deleted.
 * - `referenced`: an approval, release or dispatch claim owns the bytes now.
 * - `stale_policy`: the ledger holds a newer retention policy.
 * - `unavailable` / `outcome_unknown`: storage failed; the deletion may not have landed.
 */
export type ApplyResult =
  | Readonly<{ kind: 'applied'; invalidatedApprovals: number }>
  | Readonly<{ kind: 'already_applied' }>
  | Readonly<{ kind: 'conflict' }>
  | Readonly<{ kind: 'referenced' }>
  | Readonly<{ kind: 'stale_policy' }>
  | Readonly<{ kind: 'unavailable' }>
  | Readonly<{ kind: 'outcome_unknown' }>;

/**
 * The connector ledger's retention seam (KHA-115 owns the implementation).
 *
 * `apply` must be one local transaction that compares `expectedRevision`, the
 * current policy version and every active reference (pending approval in progress,
 * release, dispatch claim) before it deletes anything. `delete_payload` removes the
 * bytes, keeps a tombstone with the minimal identity that suppresses replay and
 * duplicate dispatch, and marks every pending approval that referenced the bytes
 * content-unavailable, so the approval cannot authorise replacement bytes. Reads of
 * a deleted payload return that tombstone, never an empty message.
 * `delete_tombstone` forgets that identity.
 */
export interface RetentionRecordPort {
  page(input: Readonly<{ after: string | null; limit: number }>): Promise<RecordPage>;
  readCursor(): Promise<Readonly<{ kind: 'cursor'; cursor: SweepCursor | null }> | Readonly<{ kind: 'unavailable' }>>;
  writeCursor(cursor: SweepCursor | null): Promise<Readonly<{ kind: 'written' }> | Readonly<{ kind: 'unavailable' }>>;
  apply(operation: RetentionOperation): Promise<ApplyResult>;
}

/** Dispatch claims (KHA-121). Answers `unavailable` rather than guessing. */
export interface ActiveClaimPort {
  status(recordId: string): Promise<ClaimStatus>;
}

/**
 * Only the selected SDK's documented maintenance. It never deletes ratchet or
 * session state to satisfy an application horizon; `unsupported` is a valid answer.
 */
export interface SupportedCryptoMaintenancePort {
  maintain(input: Readonly<{ policyVersion: number }>): Promise<Readonly<{ kind: 'completed' | 'unsupported' | 'failed' }>>;
}

export type RetentionPorts = Readonly<{
  records: RetentionRecordPort;
  claims: ActiveClaimPort;
  crypto: SupportedCryptoMaintenancePort;
  clock: Clock;
}>;

export type SweepInput = Readonly<{
  /** The approved policy as read from the control contract. Null: nothing is decided. */
  policy: unknown;
  /** Records read per page. */
  batchSize: number;
  /** Records examined per call; the next call resumes. */
  maxRecords: number;
}>;

export const retentionOperationId = (policyVersion: number, record: RetentionRecord, action: RetentionAction): string =>
  `retention/${policyVersion}/${action}/${record.recordId}/${record.revision}`;

/** A thrown port error is a storage failure, never a success. */
async function attempt<T>(call: () => Promise<T>, failed: T): Promise<T> {
  try {
    return await call();
  } catch {
    return failed;
  }
}

function positive(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${field} must be a positive integer`);
}

/**
 * Runs one bounded pass of the approved policy over the local ledger.
 *
 * The cursor advances only past a record whose result is settled (deleted, kept
 * or already gone). The first storage failure stops the pass and reports
 * `interrupted`; the next call resumes at that record. Operation IDs are
 * deterministic, so resuming after a lost response cannot delete twice.
 */
export async function sweepRetention(input: SweepInput, ports: RetentionPorts): Promise<RetentionReport> {
  positive(input.batchSize, 'batchSize');
  positive(input.maxRecords, 'maxRecords');
  if (input.policy === null || input.policy === undefined) return refusedReport(null, 'policy_absent');
  const decoded = decodeRetentionPolicy(input.policy);
  if (!decoded.ok) return refusedReport(null, 'policy_invalid');
  const policy: RetentionPolicy = decoded.value;

  const now = ports.clock.now();
  const nowMs = Date.parse(now);
  // A local clock behind the policy cannot tell what the policy made eligible.
  if (Number.isNaN(nowMs) || nowMs < Date.parse(policy.evaluatedAt)) return refusedReport(policy.version, 'clock_skew');

  const stored = await attempt(() => ports.records.readCursor(), { kind: 'unavailable' } as const);
  if (stored.kind === 'unavailable') return refusedReport(policy.version, 'cursor_unavailable');
  // A cursor from another policy version is meaningless: start over.
  let after = stored.cursor?.policyVersion === policy.version ? stored.cursor.after : null;

  const report = new ReportBuilder(policy.version);
  const finish = async (outcome: 'complete' | 'budget_exhausted' | 'interrupted'): Promise<RetentionReport> => {
    let crypto: CryptoMaintenanceOutcome = 'not_run';
    if (outcome === 'complete') {
      crypto = (await attempt(() => ports.crypto.maintain({ policyVersion: policy.version }), { kind: 'failed' } as const)).kind;
    }
    return report.build(outcome, crypto);
  };

  for (;;) {
    const remaining = input.maxRecords - report.examined;
    if (remaining === 0) return finish('budget_exhausted');
    const page = await attempt(
      () => ports.records.page({ after, limit: Math.min(input.batchSize, remaining) }),
      { kind: 'unavailable' } as const,
    );
    if (page.kind === 'unavailable') return finish('interrupted');
    if (
      page.records.length > Math.min(input.batchSize, remaining)
      || (page.records.length === 0 && !page.exhausted)
      || page.records.some((record, index) => {
        const previous = index === 0 ? after : page.records[index - 1]!.recordId;
        return previous !== null && record.recordId <= previous;
      })
    ) {
      // A ledger that repeats or reorders records could loop or skip; stop honestly.
      report.fail('invalid_ledger_answer');
      return finish('interrupted');
    }

    for (const record of page.records) {
      const claim = await attempt(() => ports.claims.status(record.recordId), 'unavailable' as const);
      const decision = evaluateRecord(policy, record, claim, now);
      if (decision.kind === 'defer') {
        report.defer(decision.reason);
      } else {
        const result = await attempt(() => ports.records.apply({
          operationId: retentionOperationId(policy.version, record, decision.action),
          recordId: record.recordId,
          expectedRevision: record.revision,
          policyVersion: policy.version,
          action: decision.action,
        }), { kind: 'unavailable' } as const);
        switch (result.kind) {
          case 'applied':
            report.delete(decision.reason, result.invalidatedApprovals);
            break;
          case 'already_applied':
            report.delete('already_deleted', 0);
            break;
          case 'conflict':
            report.defer('revision_conflict');
            break;
          case 'referenced':
            report.defer('referenced');
            break;
          case 'stale_policy':
            report.fail('stale_policy');
            return finish('interrupted');
          case 'unavailable':
          case 'outcome_unknown':
            report.fail(result.kind);
            return finish('interrupted');
        }
      }
      after = record.recordId;
      const written = await attempt(
        () => ports.records.writeCursor({ policyVersion: policy.version, after }),
        { kind: 'unavailable' } as const,
      );
      if (written.kind === 'unavailable') return finish('interrupted');
    }

    if (page.exhausted) {
      const reset = await attempt(() => ports.records.writeCursor(null), { kind: 'unavailable' } as const);
      return finish(reset.kind === 'written' ? 'complete' : 'interrupted');
    }
  }
}
