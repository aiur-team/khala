// The review panel: full inert preview per pending message, exact-selection
// checkboxes, filter chips, and one explicit release action. Density/filter-
// chip/detail-panel layout is informed by Aiur's decision-inbox pattern
// (KTD4), but "Hide" only collapses a row from local view — it never touches
// selection or submission, so closing/hiding/keeping a review item can never
// authorize delivery.

import { useState, useSyncExternalStore, type ReactNode } from 'react';
import type { MessageContent, TimelineItem } from '@khala/contracts/messaging/index';
import { sameEventRef } from '@khala/contracts/messaging/index';
import type { ReviewController } from './controller';
import type { SubmissionState } from './model';
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

export function ReviewScreen({ controller, recipientLabel, renderContent }: ReviewScreenProps) {
  const data = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [filter, setFilter] = useState<Filter>('all');
  // Local-only "hidden" set: collapses a row from this view without ever
  // touching selection or submission (KTD4 — see module header).
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());

  const { view, selection, submission } = data;
  const readable = view.pending.filter(isReadable);
  const visible = readable.filter(item => !hidden.has(item.ref.eventId));
  const shown = filter === 'selected' ? visible.filter(item => selection.refs.some(ref => sameEventRef(ref, item.ref))) : visible;

  const canAct = view.access === 'ready';
  const submissionInFlight = submission.phase === 'submitting' || submission.phase === 'unknown';
  const selectedCount = selection.refs.length;
  const canSubmit = canAct && selection.phase === 'selected' && !submissionInFlight;

  return (
    <section className="review" aria-label="Pending recipient review">
      <header className="review__header">
        <h2 className="review__title">Pending release</h2>
        <span className="review__recipient">To: {recipientLabel}</span>
        <span className="review__count">{selectedCount} selected</span>
      </header>

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

      {selection.phase === 'stale' ? (
        <p className="review__status review__status--stale" role="alert">
          Your selection changed underneath you and can no longer be released.{' '}
          <button type="button" onClick={() => controller.clearSelection()}>
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

      <ol className="review__list" aria-label="Pending messages">
        {shown.length === 0 ? <li className="review__empty">No pending messages{filter === 'selected' ? ' selected' : ''}.</li> : null}
        {shown.map(item => (
          <ReviewItem
            key={item.ref.eventId}
            item={item}
            selected={selection.refs.some(ref => sameEventRef(ref, item.ref))}
            disabled={!canAct || selection.phase === 'stale' || submissionInFlight}
            onToggle={checked => controller.toggleSelect(item.ref, checked)}
            renderContent={renderContent}
            onHide={() => setHidden(current => new Set(current).add(item.ref.eventId))}
          />
        ))}
      </ol>

      <div className="review__action-bar">
        <button type="button" className="review__release" disabled={!canSubmit} onClick={() => void controller.submit()}>
          Release{selectedCount > 0 ? ` ${selectedCount} selected` : ''}
        </button>
        {submission.phase !== 'idle' ? (
          <p className="review__submission-status" role="status">
            {submissionStatusLabel(submission.phase)}
            {submission.phase === 'rejected' && submission.error ? `: ${submission.error}` : ''}
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
