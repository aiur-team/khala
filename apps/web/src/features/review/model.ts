// Screen-local view types the review controller/selection layer project for
// presentation. Item data itself is `TimelineItem`/`EventRef`/`ParticipantView`
// from `@khala/contracts/messaging/index` (KHA-105) and
// `ApprovalCommand`/`ApprovalResult`/`DeliveryReceipt` from
// `@khala/contracts/delivery/index` (KHA-106); this module only adds the
// review-local view model layered on top (KTD1-KTD4).

import type { BindingId, CommandId, ReleaseId } from '@khala/contracts/delivery/ids';
import type { ApprovalErrorCode, DeliveryReceipt } from '@khala/contracts/delivery/index';
import type { EventRef, TimelineItem } from '@khala/contracts/messaging/index';

/**
 * Submission-local outcome for the last submitted command. Lives in the
 * controller, not the injected `ReviewUiPort`'s `ReviewView` — like the
 * timeline's draft/pending-send state, it is not part of the cached
 * port-supplied snapshot (KTD2 style).
 */
export type SubmissionState = Readonly<{
  phase: SubmissionPhase;
  commandId: CommandId | null;
  releaseIds: readonly ReleaseId[] | null;
  error: ApprovalErrorCode | null;
}>;

/**
 * The human's captured, exact intent: one local binding/policy version and the
 * exact event references chosen from it. Never row numbers or mutable rendered
 * text (KTD1). `bindingGeneration`/`expectedPolicyVersion` are the values the
 * selection was made under, not necessarily the view's current values — the
 * selection layer compares the two to detect staleness (AE1).
 */
export type SelectionSnapshot = Readonly<{
  bindingId: BindingId;
  bindingGeneration: number;
  expectedPolicyVersion: number;
  references: readonly EventRef[];
}>;

/** Lifecycle of the human's current selection, independent of submission. */
export type SelectionPhase = 'viewing' | 'selected' | 'stale';

/**
 * Lifecycle of a submitted command. `unknown` covers interrupted waiting; the
 * same `lastCommandId` must be reconciled before a further submission, never
 * replaced by a fresh command (KTD2, U3).
 */
export type SubmissionPhase = 'idle' | 'submitting' | 'released' | 'rejected' | 'unknown';

/**
 * Access/freshness of the whole review view, independent of one selection's
 * staleness. `revoked` clears protected preview and disables submission
 * (Failure boundaries); `unavailable` means the dependency backing the view
 * could not be reached, not that the room is empty.
 */
export type ReviewAccessState = 'loading' | 'ready' | 'revoked' | 'unavailable';

/**
 * Combines the current canonical binding, policy version, permitted pending
 * `TimelineItem`s and receipt facts with an access/freshness state. Exact
 * receipt/error enums follow KHA-106's read contract; this never invents an
 * ordinal progress bar over them. Supplied by the injected `ReviewUiPort` —
 * carries no selection or submission state, which stay controller-local.
 */
export type ReviewView = Readonly<{
  access: ReviewAccessState;
  bindingId: BindingId;
  bindingGeneration: number;
  policyVersion: number;
  pending: readonly TimelineItem[];
  receipts: readonly DeliveryReceipt[];
}>;
