// U1: the approved-policy eligibility predicate. Pure: every fact it needs is an
// argument, so the same inputs always produce the same decision. It never picks a
// retention horizon itself: a null cutoff means the owner has not decided that
// class, and the class is kept.

import type { Decoded } from '@khala/contracts/delivery/decode';
import {
  booleanValue, decodeWith, fail, nullable, object, safeInteger, utcTimestamp,
} from '@khala/contracts/delivery/decode';
import type { EventId } from '@khala/contracts/delivery/ids';

/**
 * An explicit owner/product retention decision (G-RETENTION). There is no default:
 * each cutoff is either an approved UTC instant or null, and null keeps that class.
 * Content is eligible only when its timestamp is strictly before the cutoff.
 */
export type RetentionPolicy = Readonly<{
  version: number;
  /** When the control plane evaluated this policy. Every cutoff is at or before it. */
  evaluatedAt: string;
  /** Pending (never released) content received before this instant may be deleted. */
  pendingBefore: string | null;
  /** Released content released before this instant may be deleted. */
  releasedBefore: string | null;
  /** Pending content is deleted only when the owner explicitly allowed it. */
  allowPendingDeletion: boolean;
  /**
   * Receipt/dedup tombstones created before this instant may be forgotten. The owner
   * sets it within the substrate's replay horizon, so replay cannot recreate an old
   * event as new. Null keeps every tombstone.
   */
  dedupBefore: string | null;
}>;

/**
 * Non-content facts about one ledger record as last read. `revision` is the
 * ledger's compare-and-set token: any claim, approval or release changes it.
 */
export type RetentionRecord = Readonly<{
  recordId: string;
  revision: string;
  eventId: EventId;
  /**
   * `pending`: bytes held for owner review. `released`: bytes approved and handed
   * to dispatch. `tombstone`: bytes already deleted; only the minimal identity
   * that suppresses replay and duplicate dispatch remains.
   */
  state: 'pending' | 'released' | 'tombstone';
  receivedAt: string;
  releasedAt: string | null;
  tombstonedAt: string | null;
  /** A recovery or backup the owner approved still depends on these bytes. */
  backupHold: boolean;
}>;

/**
 * The dispatch side's view of one record. `outcome_unknown` means a dispatch may
 * have reached the harness; its evidence is kept so it is never dispatched again
 * automatically. `unavailable` means the claim store could not answer.
 */
export type ClaimStatus = 'none' | 'active' | 'outcome_unknown' | 'unavailable';

export type RetentionAction = 'delete_payload' | 'delete_tombstone';

export type DeleteReason = 'pending_expired' | 'released_expired' | 'dedup_expired';

export type DeferReason =
  | 'policy_undecided'
  | 'pending_deletion_not_allowed'
  | 'not_yet_eligible'
  | 'clock_skew'
  | 'backup_dependency'
  | 'active_claim'
  | 'dispatch_unknown'
  | 'unresolved_outcome'
  | 'invalid_record';

export type RetentionDecision =
  | Readonly<{ kind: 'delete'; action: RetentionAction; reason: DeleteReason }>
  | Readonly<{ kind: 'defer'; reason: DeferReason }>;

const defer = (reason: DeferReason): RetentionDecision => ({ kind: 'defer', reason });
const remove = (action: RetentionAction, reason: DeleteReason): RetentionDecision => ({ kind: 'delete', action, reason });

/**
 * Validates a policy read from the control contract. A cutoff after `evaluatedAt`
 * would delete content the policy could not have seen, so it is rejected rather
 * than clamped.
 */
export function decodeRetentionPolicy(input: unknown): Decoded<RetentionPolicy> {
  return decodeWith(() => {
    const r = object(input, '', [
      'version', 'evaluatedAt', 'pendingBefore', 'releasedBefore', 'allowPendingDeletion', 'dedupBefore',
    ]);
    const version = safeInteger(r.field('version'), r.at('version'));
    if (version < 1) fail(r.at('version'), 'invalid_field');
    const evaluatedAt = utcTimestamp(r.field('evaluatedAt'), r.at('evaluatedAt'));
    const cutoff = (key: 'pendingBefore' | 'releasedBefore' | 'dedupBefore'): string | null =>
      nullable(r.field(key), value => {
        const at = utcTimestamp(value, r.at(key));
        if (Date.parse(at) > Date.parse(evaluatedAt)) fail(r.at(key), 'invalid_field');
        return at;
      });
    return {
      version,
      evaluatedAt,
      pendingBefore: cutoff('pendingBefore'),
      releasedBefore: cutoff('releasedBefore'),
      allowPendingDeletion: booleanValue(r.field('allowPendingDeletion'), r.at('allowPendingDeletion')),
      dedupBefore: cutoff('dedupBefore'),
    };
  });
}

const before = (at: string, cutoff: string): boolean => Date.parse(at) < Date.parse(cutoff);

const wellFormed = (at: string | null): boolean => at === null || decodeWith(() => utcTimestamp(at, '')).ok;

/**
 * Decides one record against a validated policy at `now`. Reference facts win over
 * age: a record held by a backup, an active dispatch claim, an unanswerable claim
 * store or an unresolved dispatch outcome is kept whatever the policy says.
 *
 * This is advisory. The ledger re-checks revision, policy and references in the
 * deletion transaction, because a claim or approval can land after this ran.
 */
export function evaluateRecord(
  policy: RetentionPolicy, record: RetentionRecord, claim: ClaimStatus, now: string,
): RetentionDecision {
  const nowMs = Date.parse(now);
  if (![record.receivedAt, record.releasedAt, record.tombstonedAt].every(wellFormed)) return defer('invalid_record');
  const stamps = [record.receivedAt, record.releasedAt, record.tombstonedAt].filter((at): at is string => at !== null);
  // A record from the future means one of the clocks is wrong; its age is unknown.
  if (stamps.some(at => Date.parse(at) > nowMs)) return defer('clock_skew');

  if (record.backupHold) return defer('backup_dependency');
  if (claim === 'active') return defer('active_claim');
  if (claim === 'unavailable') return defer('dispatch_unknown');
  if (claim === 'outcome_unknown') return defer('unresolved_outcome');

  switch (record.state) {
    case 'pending':
      if (!policy.allowPendingDeletion) return defer('pending_deletion_not_allowed');
      if (policy.pendingBefore === null) return defer('policy_undecided');
      return before(record.receivedAt, policy.pendingBefore) ? remove('delete_payload', 'pending_expired') : defer('not_yet_eligible');
    case 'released':
      if (record.releasedAt === null) return defer('invalid_record');
      if (policy.releasedBefore === null) return defer('policy_undecided');
      return before(record.releasedAt, policy.releasedBefore) ? remove('delete_payload', 'released_expired') : defer('not_yet_eligible');
    case 'tombstone':
      if (record.tombstonedAt === null) return defer('invalid_record');
      if (policy.dedupBefore === null) return defer('policy_undecided');
      return before(record.tombstonedAt, policy.dedupBefore) ? remove('delete_tombstone', 'dedup_expired') : defer('not_yet_eligible');
  }
}
