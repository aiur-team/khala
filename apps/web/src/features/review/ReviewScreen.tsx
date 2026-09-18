// The review panel: full inert preview per pending message, exact-selection
// checkboxes, filter chips, and one explicit release action. Density/filter-
// chip/detail-panel layout is informed by Aiur's decision-inbox pattern
// (KTD4), but "Hide" only collapses a row from local view — it never touches
// selection or submission, so closing/hiding/keeping a review item can never
// authorize delivery. Hiding a selected item also deselects it, so what is
// released is always exactly what is visible.

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { MessageContent, TimelineItem, UnavailableReason } from '@khala/contracts/messaging/index';
import { sameEventRef } from '@khala/contracts/messaging/index';
import { buildDisplayNameResolver, ownershipLabel } from './attribution';
import type { ReviewController } from './controller';
import type { ReviewAccessState, SubmissionState } from './model';
import { latestReceiptFor, receiptLabel } from './receipt-labels';
import { ReviewItem, type ReadableTimelineItem } from './ReviewItem';

export interface ReviewScreenProps {
  controller: ReviewController;
  /** Display-only label for the recipient agent binding this releases to. */
  recipientLabel: string;
  /** Injected inert content renderer (mirrors timeline's `renderReviewAction` symmetry); this feature imports no timeline internals (KTD3). */
  renderContent: (content: MessageContent) => ReactNode;
}

function isReadable(item: TimelineItem): item is ReadableTimelineItem {
  return item.content.kind === 'text';
}

const FILTERS = ['all', 'selected'] as const;
type Filter = (typeof FILTERS)[number];

function submissionStatusLabel(phase: SubmissionState['phase']): string {
  switch (phase) {
    case 'submitting':
      return 'Releasing…';
    case 'released':
      return 'Released';
    case 'rejected':
      return 'Not released';
    case 'unknown':
      return 'Release status unknown';
    default:
      return '';
  }
}

const UNAVAILABLE_REASON_LABELS: Readonly<Record<UnavailableReason, string>> = {
  missing_keys: 'Content unavailable: decryption keys have not arrived yet.',
  withheld_unverified: 'Content withheld: the sender requires a verified device.',
  withheld: 'Content withheld by the sender.',
  decrypt_failed: 'Content could not be decrypted.',
  unsupported: 'Content uses an unsupported format.',
};

export function ReviewScreen({ controller, recipientLabel, renderContent }: ReviewScreenProps) {
  const data = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [filter, setFilter] = useState<Filter>('all');
  // Local-only "hidden" set: collapses a row from this view without ever
  // touching selection or submission (KTD4 — see module header).
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [arrivalAnnouncement, setArrivalAnnouncement] = useState('');
  const previousPendingCount = useRef(0);
  // Distinguishes a genuine live arrival while already `ready` (must
  // announce, even into a queue that had drained to empty) from a population
  // of `pending` that just accompanied recovering into `ready` — the initial
  // mount, or any return from `loading`/`unavailable`/`revoked` — which must
  // never announce however many items arrive with it.
  const previousAccess = useRef<ReviewAccessState | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const releaseStatusRef = useRef<HTMLParagraphElement>(null);

  const { view, selection, submission } = data;

  useEffect(() => {
    const previous = previousPendingCount.current;
    if (previousAccess.current === 'ready' && view.access === 'ready' && view.pending.length > previous) {
      const added = view.pending.length - previous;
      setArrivalAnnouncement(`${added} new pending message${added > 1 ? 's' : ''} arrived.`);
    }
    previousAccess.current = view.access;
    previousPendingCount.current = view.pending.length;
  }, [view.access, view.pending.length]);

  useEffect(() => {
    if (submission.phase === 'released') releaseStatusRef.current?.focus();
  }, [submission.phase]);

  const visible = view.pending.filter(item => !hidden.has(item.ref.eventId));
  const readableVisible = visible.filter(isReadable);
  const shown = filter === 'selected' ? visible.filter(item => isReadable(item) && selection.refs.some(ref => sameEventRef(ref, item.ref))) : visible;
  const resolveDisplayName = buildDisplayNameResolver(view.pending.map(item => item.participant));

  const canAct = view.access === 'ready';
  const submissionInFlight = submission.phase === 'submitting' || submission.phase === 'unknown';
  // Release must be computed from visible, selected, readable items only — a
  // selected ref that somehow is no longer visible never counts, and never
  // reaches the submit path (defense in depth alongside Hide deselecting).
  const visibleSelectedRefs = selection.refs.filter(ref => readableVisible.some(item => sameEventRef(item.ref, ref)));
  const selectedCount = visibleSelectedRefs.length;
  // A selected ref can go invisible without being deselected whenever
  // `toggleSelect` no-ops on Hide — not only while a submission is in flight
  // (already reflected in `hideDisabled`), but also whenever access is not
  // `ready` (`controller.ts`'s own guard). Treat that desync exactly like a
  // stale selection: Release stays disabled and Reselect is offered, rather
  // than leaving a phantom selected-but-invisible count with no way back.
  const selectionDesynced = selection.phase === 'selected' && visibleSelectedRefs.length !== selection.refs.length;
  const canSubmit = canAct && selection.phase === 'selected' && !submissionInFlight && !selectionDesynced;

  function hide(eventId: string): void {
    setHidden(current => new Set(current).add(eventId));
  }

  function handleHide(item: ReadableTimelineItem): void {
    hide(item.ref.eventId);
    // Hiding a selected item must deselect it — what is approved must be
    // exactly what remains visible.
    if (selection.refs.some(ref => sameEventRef(ref, item.ref))) controller.toggleSelect(item.ref, false);
  }

  function handleReselect(): void {
    controller.clearSelection();
    listRef.current?.focus();
  }

  return (
    <section className="review" aria-label="Pending recipient review">
      <header className="review__header">
        <h2 className="review__title">Pending release</h2>
        <span className="review__recipient">To: {recipientLabel}</span>
        <span className="review__count">{selectedCount} selected</span>
      </header>

      <p className="review__sr-only" role="status" aria-live="polite">
        {arrivalAnnouncement}
      </p>

      {view.access === 'loading' ? (
        <p className="review__status" role="status">
          Loading pending messages…
        </p>
      ) : null}
      {view.access === 'unavailable' ? (
        <p className="review__status" role="alert">
          Pending messages are unavailable right now.
        </p>
      ) : null}
      {view.access === 'revoked' ? (
        <p className="review__status review__status--revoked" role="alert">
          You no longer have authority to release to this agent.
        </p>
      ) : null}

      {selection.phase === 'stale' || selectionDesynced ? (
        <p className="review__status review__status--stale" role="alert">
          Your selection changed underneath you and can no longer be released.{' '}
          <button type="button" onClick={handleReselect}>
            Reselect
          </button>
        </p>
      ) : null}

      <div className="review__filters" role="group" aria-label="Filter pending messages">
        {FILTERS.map(candidate => (
          <button
            key={candidate}
            type="button"
            className={`review__filter-chip${filter === candidate ? ' review__filter-chip--active' : ''}`}
            aria-pressed={filter === candidate}
            onClick={() => setFilter(candidate)}
          >
            {candidate === 'all' ? 'All' : 'Selected'}
          </button>
        ))}
      </div>

      <ol className="review__list" aria-label="Pending messages" ref={listRef} tabIndex={-1}>
        {shown.length === 0 ? <li className="review__empty">No pending messages{filter === 'selected' ? ' selected' : ''}.</li> : null}
        {shown.map(item =>
          isReadable(item) ? (
            <ReviewItem
              key={item.ref.eventId}
              item={item}
              resolvedDisplayName={resolveDisplayName(item.participant)}
              ownerLabel={ownershipLabel(item.participant, view.viewerOwnerId)}
              selected={selection.refs.some(ref => sameEventRef(ref, item.ref))}
              disabled={!canAct || selection.phase === 'stale' || submissionInFlight}
              onToggle={checked => controller.toggleSelect(item.ref, checked)}
              renderContent={renderContent}
              onHide={() => handleHide(item)}
              hideDisabled={submissionInFlight}
            />
          ) : (
            <li key={item.ref.eventId} className="review-item review-item--unavailable" data-event-id={item.ref.eventId} aria-disabled="true">
              <header className="review-item__header">
                <span className="review-item__kind">Unavailable</span>
                <time className="review-item__timestamp" dateTime={item.receivedAt}>
                  {item.receivedAt}
                </time>
                <button
                  type="button"
                  className="review__hide"
                  aria-label={`Hide message ${item.ref.eventId} from this list`}
                  onClick={() => hide(item.ref.eventId)}
                  disabled={submissionInFlight}
                >
                  Hide
                </button>
              </header>
              <p className="review-item__unavailable-reason">{UNAVAILABLE_REASON_LABELS[item.content.reason]}</p>
            </li>
          ),
        )}
      </ol>

      <div className="review__action-bar">
        <button type="button" className="review__release" disabled={!canSubmit} onClick={() => void controller.submit()}>
          Release{selectedCount > 0 ? ` ${selectedCount} selected` : ''}
        </button>
        {submission.phase !== 'idle' ? (
          <p className="review__submission-status" role="status" tabIndex={-1} ref={releaseStatusRef}>
            {submissionStatusLabel(submission.phase)}
            {submission.phase === 'rejected' && submission.error && selection.phase !== 'stale' ? `: ${submission.error}` : ''}
            {submission.phase === 'unknown' ? (
              <button type="button" onClick={() => void controller.reconcileUnknown()}>
                Check release status
              </button>
            ) : null}
          </p>
        ) : null}
        {submission.phase === 'released' && submission.releaseIds ? (
          <ul className="review__receipts" aria-label="Delivery evidence">
            {submission.releaseIds.map(releaseId => {
              const latest = latestReceiptFor(releaseId, view.receipts);
              return (
                <li key={releaseId}>
                  {releaseId}: {latest ? receiptLabel(latest) : 'Awaiting delivery evidence'}
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
