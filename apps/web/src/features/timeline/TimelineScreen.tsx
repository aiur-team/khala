// The route panel: attributed rows, pagination that preserves the reader's
// anchor, a jump-to-latest affordance, and a composer that reconciles each
// local send against its durable event. App-owned controls (the optional
// review-action slot) render outside the message-content renderer, so
// message syntax can never create them (KTD4).

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { RoomId } from '@khala/contracts/messaging/ids';
import type { EventRef, MessageContent, ParticipantView, RoomPort, TimelineItem } from '@khala/contracts/messaging/index';
import { attributionFor, buildDisplayNameResolver, ownershipLabel } from './attribution';
import type { TimelineController } from './controller';
import { renderMessageContent } from './message-renderer';
import { anchorToTopVisible, restoreScrollTop } from './scroll-anchor';
import { isReconciled, retrySend, sendDraft, type PendingSend } from './send';
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

const CAN_COMPOSE: ReadonlySet<string> = new Set(['joining', 'joined']);

/**
 * Narrows a `TimelineItem` to its decryptable branch. `RoomPort.timeline`/`observe` never
 * yield an `unavailable` item today (KHA-105 landed the contract shape; KHA-123 renders
 * text only), but a future producer may, and an `UnavailableEventRef` cannot reach
 * `renderReviewAction`, which is keyed by `EventRef`.
 */
function isReadableItem(item: TimelineItem): item is Extract<TimelineItem, { content: MessageContent }> {
  return item.content.kind === 'text';
}

export function TimelineScreen({ controller, roomPort, roomId, viewer, renderReviewAction }: TimelineScreenProps) {
  const data = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [draft, setDraft] = useState('');
  // Every send keeps its own row by `clientTxnId` until reconciled: a later
  // send never silently replaces an earlier failed/outcome_unknown one (R3).
  const [pendingList, setPendingList] = useState<readonly PendingSend[]>([]);
  const [atLatest, setAtLatest] = useState(true);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const listRef = useRef<HTMLOListElement | null>(null);
  const anchorRef = useRef<ReaderAnchor>({ atLatest: true });

  const canCompose = data.membership === null || CAN_COMPOSE.has(data.membership);

  useEffect(() => {
    controller.setReaderAtLatest(atLatest);
  }, [atLatest, controller]);

  // Requests the first history page once on mount so a fresh room has a
  // cursor to page from; pagination-request state otherwise stays local.
  useEffect(() => {
    void controller.loadOlder();
  }, [controller]);

  useEffect(() => {
    setPendingList(list => {
      const reconciled = list.filter(entry => isReconciled(entry, data.items));
      if (reconciled.length === 0) return list;
      // The draft is kept until a send is durably accepted (KTD3/AE2); once
      // it reconciles, clear it — but only if the reader hasn't already
      // started composing something new on top of it.
      setDraft(current => (reconciled.some(entry => entry.content.body === current.trim()) ? '' : current));
      return list.filter(entry => !isReconciled(entry, data.items));
    });
  }, [data.items]);

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
    if (!body || !canCompose) return;
    const content = { v: 1 as const, kind: 'text' as const, body };
    const clientTxnId = newClientTxnId();
    setPendingList(list => [...list, { clientTxnId, content, phase: 'pending' }]);
    const result = await sendDraft(roomPort as RoomPort, roomId, clientTxnId, content);
    setPendingList(list => list.map(entry => (entry.clientTxnId === clientTxnId ? result : entry)));
  }

  async function handleRetry(entry: PendingSend): Promise<void> {
    if (entry.phase !== 'failed' && entry.phase !== 'outcome_unknown') return;
    setPendingList(list => list.map(item => (item.clientTxnId === entry.clientTxnId ? { ...item, phase: 'pending' } : item)));
    const result = await retrySend(roomPort as RoomPort, roomId, entry);
    setPendingList(list => list.map(item => (item.clientTxnId === entry.clientTxnId ? result : item)));
  }

  const resolveDisplayName = buildDisplayNameResolver([...data.items.map(item => item.participant), viewer]);
  // A `failed` or `outcome_unknown` send keeps its draft text on screen, but
  // Send must stay disabled while it's unresolved: otherwise the reader could
  // submit the same text again under a fresh `clientTxnId`, duplicating a
  // send that may already have gone through (AE2). Only Retry — which reuses
  // the original `clientTxnId` — may resolve it.
  const anySendUnresolved = pendingList.some(entry => entry.phase !== 'accepted');

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
          Showing part of the conversation. Some history could not be loaded.
        </p>
      ) : null}
      {data.membership === 'revoked' || data.membership === 'left' ? (
        <p className="timeline__status timeline__status--membership" role="alert">
          You no longer have access to this conversation.
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
          const attribution = attributionFor(item.participant, viewer.ownerId);
          return (
            <li key={item.ref.eventId} data-event-id={item.ref.eventId} className="timeline__row">
              <header className="timeline__row-header">
                <span className="timeline__author" dir="auto">
                  {resolveDisplayName(item.participant)}
                </span>
                <span className="timeline__kind">{ownershipLabel(attribution)}</span>
                <time className="timeline__timestamp" dateTime={item.receivedAt}>
                  {item.receivedAt}
                </time>
              </header>
              {isReadableItem(item) ? (
                <>
                  <div className="timeline__body">{renderMessageContent(item.content)}</div>
                  {renderReviewAction ? <div className="timeline__review-slot">{renderReviewAction(item.ref)}</div> : null}
                </>
              ) : (
                <p className="timeline__body message-content__unavailable">Content unavailable.</p>
              )}
            </li>
          );
        })}
        {pendingList.map(entry => (
          <li key={entry.clientTxnId} className="timeline__row timeline__row--pending" aria-live="polite">
            <header className="timeline__row-header">
              <span className="timeline__author" dir="auto">
                {resolveDisplayName(viewer)}
              </span>
              <span className="timeline__kind">{ownershipLabel(attributionFor(viewer, viewer.ownerId, { isLocalEcho: true }))}</span>
              <span className="timeline__send-state">{sendStateLabel(entry.phase)}</span>
            </header>
            <div className="timeline__body">{renderMessageContent(entry.content)}</div>
            {entry.phase === 'outcome_unknown' ? (
              <button type="button" onClick={() => void handleRetry(entry)}>
                Check delivery
              </button>
            ) : null}
            {entry.phase === 'failed' ? (
              <button type="button" onClick={() => void handleRetry(entry)}>
                Retry
              </button>
            ) : null}
          </li>
        ))}
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
          disabled={!canCompose}
        />
        <button type="submit" disabled={!canCompose || !draft.trim() || anySendUnresolved}>
          Send
        </button>
      </form>
    </section>
  );
}
