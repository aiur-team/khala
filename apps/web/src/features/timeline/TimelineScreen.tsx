// The route panel: attributed rows, pagination that preserves the reader's
// anchor, a jump-to-latest affordance, and a composer that reconciles one
// local send against its durable event. App-owned controls (the optional
// review-action slot) render outside the message-content renderer, so
// message syntax can never create them (KTD4).

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { RoomId } from '@khala/contracts/messaging/ids';
import type { EventRef, ParticipantView, RoomPort } from '@khala/contracts/messaging/index';
import { attributionFor, ATTRIBUTION_KIND_LABEL } from './attribution';
import type { TimelineController } from './controller';
import { renderMessageContent } from './message-renderer';
import { anchorToTopVisible, restoreScrollTop } from './scroll-anchor';
import { isReconciled, resolveOutcomeUnknown, sendDraft, type PendingSend } from './send';
import type { ReaderAnchor } from './model';

export interface TimelineScreenProps {
  controller: TimelineController;
  roomPort: Pick<RoomPort, 'send'>;
  roomId: RoomId;
  /** The signed-in human whose composer this is; used only for the local echo's byline. */
  viewer: ParticipantView;
  /** Rendered per row, outside the message-content renderer, keyed by exact `EventRef`. */
  renderReviewAction?: (ref: EventRef) => ReactNode;
}

const NEAR_BOTTOM_PX = 24;

function newClientTxnId(): string {
  return `txn_${crypto.randomUUID()}`;
}

function sendStateLabel(phase: PendingSend['phase']): string {
  switch (phase) {
    case 'pending':
      return 'Sending…';
    case 'accepted':
      return 'Sent';
    case 'failed':
      return 'Not delivered';
    case 'outcome_unknown':
      return 'Delivery unknown';
    default:
      return '';
  }
}

export function TimelineScreen({ controller, roomPort, roomId, viewer, renderReviewAction }: TimelineScreenProps) {
  const data = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<PendingSend | null>(null);
  const [atLatest, setAtLatest] = useState(true);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const listRef = useRef<HTMLOListElement | null>(null);
  const anchorRef = useRef<ReaderAnchor>({ atLatest: true });

  useEffect(() => {
    controller.setReaderAtLatest(atLatest);
  }, [atLatest, controller]);

  // Requests the first history page once on mount so a fresh room has a
  // cursor to page from; pagination-request state otherwise stays local.
  useEffect(() => {
    void controller.loadOlder();
  }, [controller]);

  useEffect(() => {
    if (pending && isReconciled(pending, data.items)) setPending(null);
  }, [pending, data.items]);

  useEffect(() => {
    const list = listRef.current;
    const anchor = anchorRef.current;
    if (!list || 'atLatest' in anchor) return;
    const newTop = restoreScrollTop(anchor, eventId => {
      const row = list.querySelector<HTMLElement>(`[data-event-id="${CSS.escape(eventId)}"]`);
      return row ? row.offsetTop : null;
    });
    if (newTop !== null) list.scrollTop = newTop;
    anchorRef.current = { atLatest: true };
  }, [data.items]);

  const handleLoadOlder = useCallback(async () => {
    const list = listRef.current;
    const topItem = data.items[0];
    if (list && topItem) {
      const row = list.querySelector<HTMLElement>(`[data-event-id="${CSS.escape(topItem.ref.eventId)}"]`);
      anchorRef.current = anchorToTopVisible(topItem.ref.eventId, row ? row.getBoundingClientRect().top - list.getBoundingClientRect().top : 0);
    }
    setIsLoadingOlder(true);
    try {
      await controller.loadOlder();
    } finally {
      setIsLoadingOlder(false);
    }
  }, [controller, data.items]);

  async function handleSend(): Promise<void> {
    const body = draft.trim();
    if (!body || (pending && pending.phase === 'pending')) return;
    const content = { v: 1 as const, kind: 'text' as const, body: draft };
    const clientTxnId = newClientTxnId();
    setDraft('');
    setPending({ clientTxnId, content, phase: 'pending' });
    const result = await sendDraft(roomPort as RoomPort, roomId, clientTxnId, content);
    setPending(result);
  }

  async function handleRetryUnknown(): Promise<void> {
    if (!pending || pending.phase !== 'outcome_unknown') return;
    const result = await resolveOutcomeUnknown(roomPort as RoomPort, roomId, pending);
    setPending(result);
  }

  const showPendingRow = pending !== null && !isReconciled(pending, data.items);

  return (
    <section className="timeline" aria-label="Conversation">
      {data.phase === 'unavailable' ? (
        <p className="timeline__status" role="alert">
          Conversation history is unavailable right now.
        </p>
      ) : null}
      {data.phase === 'loading' ? (
        <p className="timeline__status" role="status">
          Loading conversation…
        </p>
      ) : null}
      {data.phase === 'partial' ? (
        <p className="timeline__status" role="status">
          Showing part of the conversation.
        </p>
      ) : null}
      {data.nextCursor !== null ? (
        <button type="button" className="timeline__load-older" disabled={isLoadingOlder} onClick={() => void handleLoadOlder()}>
          Load earlier messages
        </button>
      ) : null}
      <ol
        className="timeline__list"
        ref={listRef}
        aria-label="Messages"
        onScroll={event => {
          const el = event.currentTarget;
          setAtLatest(el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX);
        }}
      >
        {data.items.length === 0 && data.phase === 'ready' ? <li className="timeline__empty">No messages yet.</li> : null}
        {data.items.map(item => {
          const attribution = attributionFor(item.participant);
          return (
            <li key={item.ref.eventId} data-event-id={item.ref.eventId} className="timeline__row">
              <header className="timeline__row-header">
                <span className="timeline__author" dir="auto">
                  {attribution.displayName}
                </span>
                <span className="timeline__kind">{ATTRIBUTION_KIND_LABEL[attribution.kind]}</span>
                <time className="timeline__timestamp" dateTime={item.receivedAt}>
                  {item.receivedAt}
                </time>
              </header>
              <div className="timeline__body">{renderMessageContent(item.content)}</div>
              {renderReviewAction ? <div className="timeline__review-slot">{renderReviewAction(item.ref)}</div> : null}
            </li>
          );
        })}
        {showPendingRow ? (
          <li className="timeline__row timeline__row--pending" aria-live="polite">
            <header className="timeline__row-header">
              <span className="timeline__author" dir="auto">
                {viewer.displayName}
              </span>
              <span className="timeline__send-state">{sendStateLabel(pending!.phase)}</span>
            </header>
            <div className="timeline__body">{renderMessageContent(pending!.content)}</div>
            {pending!.phase === 'outcome_unknown' ? (
              <button type="button" onClick={() => void handleRetryUnknown()}>
                Check delivery
              </button>
            ) : null}
          </li>
        ) : null}
      </ol>
      {!atLatest && data.newMessageCount > 0 ? (
        <button
          type="button"
          className="timeline__jump-latest"
          onClick={() => {
            setAtLatest(true);
            const list = listRef.current;
            if (list) list.scrollTop = list.scrollHeight;
          }}
        >
          {data.newMessageCount} new message{data.newMessageCount === 1 ? '' : 's'}
        </button>
      ) : null}
      <form
        className="timeline__composer"
        onSubmit={event => {
          event.preventDefault();
          void handleSend();
        }}
      >
        <label htmlFor="timeline-draft" className="timeline__composer-label">
          Message
        </label>
        <textarea
          id="timeline-draft"
          className="timeline__composer-input"
          value={draft}
          onChange={event => setDraft(event.currentTarget.value)}
          disabled={pending !== null && pending.phase === 'pending'}
        />
        <button type="submit" disabled={!draft.trim() || (pending !== null && pending.phase === 'pending')}>
          Send
        </button>
      </form>
    </section>
  );
}
