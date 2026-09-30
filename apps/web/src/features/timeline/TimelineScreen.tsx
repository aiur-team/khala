// The route panel: attributed rows, pagination that preserves the reader's
// anchor, a jump-to-latest affordance, and a composer that reconciles each
// local send against its durable event. App-owned controls (the optional
// review-action slot) render outside the message-content renderer, so
// message syntax can never create them (KTD4).

import { Fragment, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { RoomId } from '@khala/contracts/messaging/ids';
import type { EventRef, ParticipantView, ChannelPort, TimelineItem } from '@khala/contracts/messaging/index';
import type { ReceiptEvidenceController, ReceiptEvidenceView } from '../receipt-evidence/controller';
import { type EvidenceUnit, isInlineUnit } from '../receipt-evidence/model';
import { EvidenceAccess, EvidenceAnnouncer, EvidenceGroup, InlineEvidence } from '../receipt-evidence/ReceiptEvidence';
import { attributionFor, buildDisplayNameResolver, ownershipLabel } from './attribution';
import type { TimelineController } from './controller';
import { renderMessageContent } from './message-renderer';
import { anchorToTopVisible, restoreScrollTop } from './scroll-anchor';
import { isReconciled, retrySend, sendDraft, type PendingSend } from './send';
import type { ReaderAnchor } from './model';
import { ChatComposer, ChatMessage } from '../../ui/conversation';
import { ChatSystemEvent } from '../../ui/conversation';
import { projectTimelineNames } from './names';
import type { NameParticipant } from '@khala/contracts/messaging/agent-names';

export interface TimelineScreenProps {
  controller: TimelineController;
  roomPort: Pick<ChannelPort, 'send'>;
  roomId: RoomId;
  /** The signed-in human whose composer this is; used only for the local echo's byline. */
  viewer: ParticipantView;
  extraParticipants?: readonly NameParticipant[];
  /** Rendered per row, outside the message-content renderer, keyed by exact `EventRef`. */
  renderReviewAction?: (ref: EventRef) => ReactNode;
  /**
   * Why sending is paused (for example, the transport is reconnecting). The draft
   * stays editable; Send and Retry stay disabled until this is `null` again.
   */
  sendBlockedReason?: string | null;
  /** Keeps unreconciled sends across a reload so a retry reuses the same `clientTxnId`. */
  pendingStore?: PendingSendStore;
  /** The owner's durable receipt evidence for this channel; absent means none is shown. */
  evidence?: ReceiptEvidenceController;
  composerPlaceholder?: string;
  /** The room index has encrypted activity that this device cannot preview. */
  unreadableActivity?: boolean;
}

/** A per-row DOM id for the link that opened an evidence group, so back can return to it. */
function evidenceLinkId(unit: EvidenceUnit, eventId: string): string {
  return `${unit.id}-from-${eventId.replace(/[^A-Za-z0-9-]/g, character => `_${character.charCodeAt(0).toString(16)}_`)}`;
}

const EVIDENCE_RETURN = 'khalaEvidenceReturn';

type EvidenceLayout = Readonly<{
  inline: ReadonlyMap<string, EvidenceUnit>;
  /** Groups rendered before their earliest loaded member row. */
  groupsBefore: ReadonlyMap<string, readonly EvidenceUnit[]>;
  /** Every loaded member row's non-inline groups. */
  memberOf: ReadonlyMap<string, readonly EvidenceUnit[]>;
}>;

/**
 * Places each unit against the loaded rows. A group is anchored before its
 * earliest loaded member, so loading an older page moves it rather than losing
 * it, and a member link is only exposed while its target is rendered.
 */
function layoutEvidence(units: readonly EvidenceUnit[], loaded: readonly string[]): EvidenceLayout {
  const position = new Map(loaded.map((eventId, index) => [eventId, index]));
  const inline = new Map<string, EvidenceUnit>();
  const groupsBefore = new Map<string, EvidenceUnit[]>();
  const memberOf = new Map<string, EvidenceUnit[]>();
  for (const unit of units) {
    const members = unit.eventIds.filter(eventId => position.has(eventId));
    if (members.length === 0) continue;
    if (isInlineUnit(unit)) {
      inline.set(members[0]!, unit);
      continue;
    }
    const first = members.reduce((earliest, eventId) => (position.get(eventId)! < position.get(earliest)! ? eventId : earliest));
    groupsBefore.set(first, [...(groupsBefore.get(first) ?? []), unit]);
    for (const eventId of members) memberOf.set(eventId, [...(memberOf.get(eventId) ?? []), unit]);
  }
  return { inline, groupsBefore, memberOf };
}

const NO_EVIDENCE: ReceiptEvidenceView = { status: 'ready', units: [], announcement: null };
const noEvidenceSubscribe = () => () => undefined;

export interface PendingSendStore {
  load(): readonly PendingSend[];
  save(pending: readonly PendingSend[]): void;
}

/** A send interrupted by a reload may have landed; only a retry of the same transaction can tell. */
function restored(entry: PendingSend): PendingSend {
  return entry.phase === 'pending' ? { ...entry, phase: 'outcome_unknown' } : entry;
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
 * Narrows a `TimelineItem` to its decryptable branch. `ChannelPort.timeline`/`observe` never
 * yield an `unavailable` item today (KHA-105 landed the contract shape; KHA-123 renders
 * text only), but a future producer may, and an `UnavailableEventRef` cannot reach
 * `renderReviewAction`, which is keyed by `EventRef`.
 */
function isReadableItem(item: TimelineItem): item is Extract<TimelineItem, { content: { kind: 'text' } }> {
  return item.content.kind === 'text';
}

export function TimelineScreen({
  controller, roomPort, roomId, viewer, extraParticipants = [], renderReviewAction, sendBlockedReason = null, pendingStore, evidence,
  composerPlaceholder = '', unreadableActivity = false,
}: TimelineScreenProps) {
  const data = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const rows = useMemo(() => data.rows ?? data.items.map(item => ({ kind: 'message' as const, item })), [data.rows, data.items]);
  const evidenceView = useSyncExternalStore(
    evidence?.subscribe ?? noEvidenceSubscribe,
    evidence?.getSnapshot ?? (() => NO_EVIDENCE),
    evidence?.getSnapshot ?? (() => NO_EVIDENCE),
  );
  const evidenceLayout = useMemo(
    () => layoutEvidence(evidenceView.units, rows.flatMap(row => row.kind === 'message' ? [row.item.ref.eventId] : [])),
    [rows, evidenceView.units],
  );

  useEffect(() => {
    void evidence?.refresh();
  }, [evidence]);

  // Back from an evidence group returns focus to the exact row link that opened it.
  useEffect(() => {
    if (!evidence) return undefined;
    const onPopState = (event: PopStateEvent) => {
      const state: unknown = event.state;
      const returnTo = typeof state === 'object' && state !== null ? (state as Record<string, unknown>)[EVIDENCE_RETURN] : undefined;
      const target = typeof returnTo === 'string' ? document.getElementById(returnTo) : null;
      if (target) {
        target.scrollIntoView({ block: 'nearest' });
        target.focus();
      }
    };
    addEventListener('popstate', onPopState);
    return () => removeEventListener('popstate', onPopState);
  }, [evidence]);

  function openEvidence(unit: EvidenceUnit, linkId: string): void {
    const current: unknown = history.state;
    history.replaceState({ ...(typeof current === 'object' && current !== null ? current : {}), [EVIDENCE_RETURN]: linkId }, '');
    history.pushState(null, '', `#${unit.id}`);
    const heading = document.getElementById(`${unit.id}-heading`);
    heading?.scrollIntoView({ block: 'start' });
    heading?.focus();
  }
  const [draft, setDraft] = useState('');
  // Every send keeps its own row by `clientTxnId` until reconciled: a later
  // send never silently replaces an earlier failed/outcome_unknown one (R3).
  const [pendingList, setPendingList] = useState<readonly PendingSend[]>(() => pendingStore?.load().map(restored) ?? []);
  const pendingListRef = useRef(pendingList);
  const [atLatest, setAtLatest] = useState(true);
  const [isLoadingOlder, setIsLoadingOlder] = useState(false);
  const listRef = useRef<HTMLOListElement | null>(null);
  const anchorRef = useRef<ReaderAnchor>({ atLatest: true });

  const canCompose = data.membership === null || CAN_COMPOSE.has(data.membership);
  const sendBlocked = sendBlockedReason !== null;

  const updatePending = useCallback((update: (list: readonly PendingSend[]) => readonly PendingSend[]) => {
    const next = update(pendingListRef.current);
    if (next === pendingListRef.current) return;
    pendingListRef.current = next;
    // A reload may happen before React's next effect. Persist each accepted
    // event ID before publishing the state change to the UI.
    pendingStore?.save(next);
    setPendingList(next);
  }, [pendingStore]);

  useEffect(() => {
    pendingStore?.save(pendingListRef.current);
  }, [pendingStore]);

  useEffect(() => {
    controller.setReaderAtLatest(atLatest);
  }, [atLatest, controller]);

  // Requests the first history page once on mount so a fresh channel has a
  // cursor to page from; pagination-request state otherwise stays local.
  useEffect(() => {
    void controller.loadOlder().then(() => controller.scanNameHistory?.());
  }, [controller]);

  useEffect(() => {
    const reconciled = pendingList.filter(entry => isReconciled(entry, data.items));
    if (reconciled.length === 0) return;
    updatePending(list => list.filter(entry => !isReconciled(entry, data.items)));
  }, [data.items, pendingList, updatePending]);

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
    if (!body || !canCompose || sendBlocked || pendingListRef.current.some(entry =>
      entry.phase !== 'accepted' && !isReconciled(entry, data.items))) return;
    const content = { v: 1 as const, kind: 'text' as const, body };
    const clientTxnId = newClientTxnId();
    updatePending(list => [...list, { clientTxnId, content, phase: 'pending' as const }]);
    setDraft('');
    const result = await sendDraft(roomPort as ChannelPort, roomId, clientTxnId, content);
    updatePending(list => list.map(entry => (entry.clientTxnId === clientTxnId ? result : entry)));
  }

  async function handleRetry(entry: PendingSend): Promise<void> {
    if ((entry.phase !== 'failed' && entry.phase !== 'outcome_unknown') || sendBlocked) return;
    updatePending(list => list.map(item => (item.clientTxnId === entry.clientTxnId ? { ...item, phase: 'pending' } : item)));
    const result = await retrySend(roomPort as ChannelPort, roomId, entry);
    updatePending(list => list.map(item => (item.clientTxnId === entry.clientTxnId ? result : item)));
  }

  const names = projectTimelineNames(data.nameHistory ?? data.items, viewer, extraParticipants);
  const attributed = new Map(names.events.map(event => [event.eventId, event]));
  const resolveDisplayName = buildDisplayNameResolver([...data.items.map(item => ({
    ...item.participant,
    displayName: data.namesReady === false && item.participant.kind === 'agent' ? 'Agent name unavailable'
      : attributed.get(item.ref.eventId)?.kind === 'message'
      ? (attributed.get(item.ref.eventId) as Extract<typeof names.events[number], { kind: 'message' }>).authorName
      : item.participant.displayName,
  })), viewer]);
  // A `failed` or `outcome_unknown` send keeps its body in the pending row, but
  // Send must stay disabled while it's unresolved: otherwise the reader could
  // submit the same text again under a fresh `clientTxnId`, duplicating a
  // send that may already have gone through (AE2). Only Retry — which reuses
  // the original `clientTxnId` — may resolve it.
  const visiblePending = pendingList.filter(entry => !isReconciled(entry, data.items));
  const anySendUnresolved = visiblePending.some(entry => entry.phase !== 'accepted');

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
      {data.nameScan === 'checking' || data.nameScan === undefined && data.namesReady === false
        ? <p className="timeline__status" role="status">Checking agent names in encrypted history…</p> : null}
      {data.nameScan === 'retryable' ? <p className="timeline__status" role="alert">
        Agent names could not be checked because history did not load. You can retry while continuing this conversation.
      </p> : null}
      {data.nameScan === 'unavailable' ? <p className="timeline__status" role="alert">
        Some older encrypted messages and agent names are unavailable on this device. If you changed browser profiles, open the original profile. If its keys are gone, those messages cannot be recovered. You can still send new messages.
      </p> : null}
      {(data.nameScan === 'retryable' || data.nameScan === 'unavailable')
        ? <button type="button" onClick={() => { void controller.loadOlder().then(() => controller.scanNameHistory?.()); }}>Retry history</button> : null}
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
      {evidence && (data.items.length > 0 || evidenceView.units.length > 0) ? (
        <>
          <EvidenceAccess status={evidenceView.status} onRetry={() => void evidence.refresh()} />
          <EvidenceAnnouncer text={evidenceView.announcement?.text ?? null} />
        </>
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
        {rows.length === 0 && data.phase === 'ready' ? <li className="timeline__empty">
          {unreadableActivity ? 'Messages in this channel are unavailable on this device.' : 'No messages yet.'}
        </li> : null}
        {rows.map((row, index) => {
          if (row.kind === 'unavailable') return <li key={row.eventId} data-event-id={row.eventId}
            className="timeline__row message-content__unavailable">Message unavailable on this device.</li>;
          const item = row.item;
          const previous = rows[index - 1];
          const nameEvent = attributed.get(item.ref.eventId);
          if (item.content.kind === 'agent_name_snapshot') return null;
          if (item.content.kind === 'agent_rename') return data.namesReady !== false && nameEvent?.kind === 'agent_rename'
            ? <ChatSystemEvent key={item.ref.eventId} id={item.ref.eventId} actor={nameEvent.actorName}>
                {nameEvent.previousName} is now called {nameEvent.name}
              </ChatSystemEvent>
            : null;

          const attribution = attributionFor(item.participant, viewer.ownerId);
          const inlineEvidence = evidence ? evidenceLayout.inline.get(item.ref.eventId) : undefined;
          const groups = evidence ? evidenceLayout.groupsBefore.get(item.ref.eventId) ?? [] : [];
          const memberOf = evidence ? evidenceLayout.memberOf.get(item.ref.eventId) ?? [] : [];
          return (
            <Fragment key={item.ref.eventId}>
              {groups.map(unit => (
                <li key={unit.id} className="timeline__evidence-group">
                  <EvidenceGroup unit={unit} status={evidenceView.status} />
                </li>
              ))}
              <ChatMessage id={item.ref.eventId} author={resolveDisplayName({ ...item.participant,
                displayName: data.namesReady === false && item.participant.kind === 'agent' ? 'Agent name unavailable'
                  : nameEvent?.kind === 'message' ? nameEvent.authorName : item.participant.displayName })} time={item.receivedAt}
                mine={attribution.isViewerOwned} grouped={previous?.kind === 'message' && previous.item.participant.participantId === item.participant.participantId}
                kindLabel={ownershipLabel(attribution)} className="timeline__row">
                {isReadableItem(item) ? (
                  <>
                    <div className="timeline__body">{renderMessageContent(item.content)}</div>
                    {renderReviewAction ? <div className="timeline__review-slot">{renderReviewAction(item.ref)}</div> : null}
                  </>
                ) : (
                  <p className="timeline__body message-content__unavailable">Content unavailable.</p>
                )}
                {inlineEvidence ? <InlineEvidence unit={inlineEvidence} status={evidenceView.status} /> : null}
                {memberOf.map(unit => {
                  const linkId = evidenceLinkId(unit, item.ref.eventId);
                  return (
                    <a
                      key={unit.id}
                      id={linkId}
                      className="timeline__evidence-link"
                      href={`#${unit.id}`}
                      onClick={event => {
                        event.preventDefault();
                        openEvidence(unit, linkId);
                      }}
                    >
                      View batch evidence
                    </a>
                  );
                })}
              </ChatMessage>
            </Fragment>
          );
        })}
        {visiblePending.map(entry => (
          <ChatMessage key={entry.clientTxnId} id={entry.clientTxnId} author={resolveDisplayName(viewer)} mine live
            kindLabel={ownershipLabel(attributionFor(viewer, viewer.ownerId, { isLocalEcho: true }))}
            status={sendStateLabel(entry.phase)} className="timeline__row timeline__row--pending">
            <div className="timeline__body">{renderMessageContent(entry.content)}</div>
            {entry.phase === 'outcome_unknown' ? (
              <button type="button" disabled={sendBlocked} onClick={() => void handleRetry(entry)}>
                Check delivery
              </button>
            ) : null}
            {entry.phase === 'failed' ? (
              <button type="button" disabled={sendBlocked} onClick={() => void handleRetry(entry)}>
                Retry
              </button>
            ) : null}
          </ChatMessage>
        ))}
      </ol>
      {!atLatest && data.newMessageCount > 0 ? (
        <button
          type="button"
          className="timeline__jump-latest aiur-action"
          onClick={() => {
            setAtLatest(true);
            const list = listRef.current;
            if (list) list.scrollTop = list.scrollHeight;
          }}
        >
          {data.newMessageCount} new message{data.newMessageCount === 1 ? '' : 's'}
        </button>
      ) : null}
      <ChatComposer value={draft} onChange={setDraft} onSend={() => void handleSend()}
        placeholder={composerPlaceholder}
        disabled={!canCompose} sendDisabled={anySendUnresolved || sendBlocked}
        {...(sendBlocked ? { sendDescriptionId: 'timeline-send-blocked' } : {})} />
      {sendBlocked ? <p id="timeline-send-blocked" className="timeline__status" role="status">{sendBlockedReason}</p> : null}
    </section>
  );
}
