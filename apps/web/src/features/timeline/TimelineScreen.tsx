import type { Participant } from '@khala/contracts/m1/participants';
import { dedupeByKey } from '@khala/contracts/m1/channel-event';
import { ChannelEventPill } from './ChannelEventPill';
// The route panel: attributed rows, pagination that preserves the reader's
// anchor, a jump-to-latest affordance, and a composer that reconciles each
// local send against its durable event. App-owned controls (the optional
// review-action slot) render outside the message-content renderer, so
// message syntax can never create them (KTD4).

import { Fragment, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode, type Ref } from 'react';
import type { EventId, ParticipantId, RoomId } from '@khala/contracts/messaging/ids';
import type { EventRef, ParticipantView, ChannelPort, TimelineItem } from '@khala/contracts/messaging/index';
import type { ReceiptEvidenceController, ReceiptEvidenceView } from '../receipt-evidence/controller';
import { type EvidenceUnit, isInlineUnit } from '../receipt-evidence/model';
import { EvidenceAccess, EvidenceAnnouncer, EvidenceGroup, InlineEvidence } from '../receipt-evidence/ReceiptEvidence';
import { attributionFor, ownershipLabel } from './attribution';
import type { TimelineController } from './controller';
import { renderMessageContent, type RenderOptions } from './message-renderer';
import type { MentionCandidate } from './mentions';
import { anchorToTopVisible, restoreScrollTop } from './scroll-anchor';
import { isReconciled, retrySend, sendDraft, type PendingSend } from './send';
import type { ReaderAnchor } from './model';
import { ChatComposer, ChatMessage, insertMention, type MentionTarget } from '../../ui/conversation';
import { ChatSystemEvent } from '../../ui/conversation';
import type { ThreadRowName } from '../../ui/conversation/ChatMessage';
import { Avatar } from '../../ui/khala/Avatar';
import { clockLabel, dayLabel, dayTime, type TimeOptions } from '../../ui/khala/format-time';
import { RestoreIcon, UserXIcon } from '../../ui/khala/icons';
import { buildIdBadgeResolver, harnessLogo, initials, ownerInitials, useParticipantHue } from '../../ui/khala/identity';
import { computeRuns, type RunInput, type RunPosition } from './runs';
import { projectTimelineNames } from './names';
import type { NameParticipant } from '@khala/contracts/messaging/agent-names';

export interface TimelineScreenProps {
  describeParticipant?: (participantId: ParticipantId) => Participant | undefined;
  controller: TimelineController;
  roomPort: Pick<ChannelPort, 'send'>;
  roomId: RoomId;
  /** The signed-in human whose composer this is; used only for the local echo's byline. */
  viewer: ParticipantView;
  extraParticipants?: readonly NameParticipant[];
  /** The channel's members in member order: the mention chips follow it, and owner badges name them (§3, §9). */
  members?: readonly ParticipantView[];
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
  /** The room index has encrypted activity that this device cannot preview. */
  unreadableActivity?: boolean;
  /** Lets the room's detail pane and roster reach the composer. */
  composerRef?: Ref<TimelineComposerHandle>;
  /** A name, avatar or `@mention` was activated. KM-183 opens the detail pane. */
  onOpenParticipant?: (participantId: string) => void;
  /** Receives the `@mention` roster on change, so the detail pane's Recent in Khala draws the same chips. */
  onMentionRoster?: (roster: readonly MentionCandidate[]) => void;
  /** The empty thread's Invite button. KM-183 opens the invite popover. */
  onInvite?: () => void;
  /** The clock for day separator labels; tests pin it. */
  now?: () => Date;
  /** Fixtures and tests pass UTC; the product uses the viewer's local time. */
  timeOptions?: TimeOptions;
}

export type TimelineComposerHandle = Readonly<{
  /** Inserts `@{label} ` into the draft (§9 `khInsert`). */
  insertMention(label: string): void;
  /** Collapses the mention chips grid. */
  closeChips(): void;
}>

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

/** The single §7.4 receipt after the viewer's last message. Never "Read". */
function receiptFor(phase: PendingSend['phase'] | 'reconciled'): Readonly<{ text: string; failed: boolean }> {
  switch (phase) {
    case 'pending':
      return { text: 'Sending…', failed: false };
    case 'failed':
      return { text: 'Not sent', failed: true };
    case 'outcome_unknown':
      return { text: 'Delivery unknown', failed: true };
    default:
      return { text: 'Delivered', failed: false };
  }
}

function lastIndexOf<T>(list: readonly T[], test: (value: T) => boolean): number {
  for (let index = list.length - 1; index >= 0; index -= 1) if (test(list[index]!)) return index;
  return -1;
}

const isUnresolved = (phase: PendingSend['phase']) => phase === 'failed' || phase === 'outcome_unknown';

/** `Claude · Kevin` → label `Claude`, owner `Kevin` (C4 display names). */
function splitAgentName(name: string): Readonly<{ label: string; owner: string | null }> {
  const at = name.indexOf(' · ');
  return at === -1 ? { label: name, owner: null } : { label: name.slice(0, at), owner: name.slice(at + 3) || null };
}

const firstName = (name: string) => name.trim().split(/\s+/u)[0] ?? name;

/** A calendar day key in the viewer's own time zone, or in `options.timeZone`. */
const dayKey = (date: Date, options: TimeOptions) => options.timeZone
  ? date.toLocaleDateString('en-CA', { timeZone: options.timeZone })
  : `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;

/** Everything the thread needs to draw one participant: name line, avatar and mention target. */
type Identity = Readonly<{
  participantId: string;
  ownerId: string;
  kind: 'human' | 'agent' | 'unknown';
  /** The full display name, before any collision suffix. */
  fullName: string;
  label: string;
  hue: number;
  idBadge: string | undefined;
  ownerLabel: string | null;
  ownerHue: number;
  harness: Extract<Participant, { kind: 'agent' }>['harness'] | undefined;
  isViewerOwned: boolean;
}>;

type ThreadEntry =
  | Readonly<{ type: 'message'; key: string; run: RunInput; render: (run: RunPosition) => ReactNode; receipt?: PendingSend['phase'] | 'reconciled' }>
  | Readonly<{ type: 'break'; key: string; node: ReactNode }>;

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
  describeParticipant, controller, roomPort, roomId, viewer, extraParticipants = [], members = [], renderReviewAction, sendBlockedReason = null, pendingStore, evidence,
  unreadableActivity = false, composerRef, onOpenParticipant, onMentionRoster, onInvite, now = () => new Date(), timeOptions = {},
}: TimelineScreenProps) {
  const hueFor = useParticipantHue();
  const data = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const rows = useMemo(() => dedupeByKey(data.rows ?? data.items.map(item => ({ kind: 'message' as const, item })),
    row => row.kind === 'channel_event' ? row.content.key : undefined), [data.rows, data.items]);
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
  const [chipsOpen, setChipsOpen] = useState(false);
  useImperativeHandle(composerRef, () => ({
    insertMention: label => setDraft(current => insertMention(current, label)),
    closeChips: () => setChipsOpen(false),
  }), []);
  // Every send keeps its own row by `clientTxnId` until reconciled: a later
  // send never silently replaces an earlier failed/outcome_unknown one (R3).
  const [pendingList, setPendingList] = useState<readonly PendingSend[]>(() => pendingStore?.load().map(restored) ?? []);
  const pendingListRef = useRef(pendingList);
  const [atLatest, setAtLatest] = useState(true);
  // `.pop` (§7.5) marks rows that arrive live while the reader is at latest,
  // once: each id is dropped again when its animation ends.
  const [popIds, setPopIds] = useState<ReadonlySet<string>>(() => new Set());
  const seenRef = useRef<Set<string> | null>(null);
  const dropPop = useCallback((id: string) => setPopIds(current => {
    if (!current.has(id)) return current;
    const next = new Set(current);
    next.delete(id);
    return next;
  }), []);
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

  // Before paint, so a live row never flashes in ahead of its pop.
  useLayoutEffect(() => {
    const ids = rows.map(row => row.kind === 'message'
      ? { id: row.item.ref.eventId as string, txn: row.item.clientTxnId }
      : { id: row.eventId as string, txn: null });
    const seen = seenRef.current;
    if (seen === null) {
      if (ids.length > 0) seenRef.current = new Set(ids.map(entry => entry.id));
      return;
    }
    // Older pages prepend; only rows after the newest already-seen one are live.
    const lastSeen = lastIndexOf(ids, entry => seen.has(entry.id));
    // A reconciled echo of the viewer's own send already popped as its pending row.
    const arrived = lastSeen === -1 ? [] : ids.slice(lastSeen + 1).filter(entry => !(entry.txn && seen.has(entry.txn)));
    for (const entry of ids) seen.add(entry.id);
    if (atLatest && arrived.length > 0) setPopIds(current => new Set([...current, ...arrived.map(entry => entry.id)]));
  }, [rows, atLatest]);

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
    seenRef.current?.add(clientTxnId);
    setPopIds(current => new Set(current).add(clientTxnId));
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
  // While encrypted history is still being scanned, the persisted participant
  // name is a better provisional label than implying that the key is missing.
  const namesUnavailable = data.namesReady === false && data.nameScan !== 'checking';
  const attributed = new Map(names.events.map(event => [event.eventId, event]));

  /** C3 details first, then the name replay at `eventId` (or the current name for the roster). */
  function fullNameFor(participant: Pick<ParticipantView, 'participantId' | 'kind' | 'displayName'>, eventId: string | null): string {
    const detail = describeParticipant?.(participant.participantId);
    if (detail?.kind === 'unknown') return 'Unknown';
    if (detail?.kind === 'agent') return detail.displayName;
    if (namesUnavailable && participant.kind === 'agent') return 'Agent name unavailable';
    if (eventId === null) return names.currentNames.get(participant.participantId) ?? participant.displayName;
    const event = attributed.get(eventId as EventId);
    return event?.kind === 'message' ? event.authorName : participant.displayName;
  }

  // Everyone the thread can name or mention: the viewer, channel members in member order, speakers and roster agents.
  const rosterParticipants = new Map<string, ParticipantView>();
  for (const participant of [viewer, ...members, ...data.items.map(item => item.participant)]) {
    if (!rosterParticipants.has(participant.participantId)) rosterParticipants.set(participant.participantId, participant);
  }
  for (const participant of extraParticipants) {
    if (!rosterParticipants.has(participant.participantId)) rosterParticipants.set(participant.participantId,
      { ...viewer, participantId: participant.participantId, ownerId: participant.ownerId, kind: participant.kind, displayName: participant.initialName });
  }
  const resolveIdBadge = buildIdBadgeResolver([
    ...data.items.map(item => ({ ...item.participant, displayName: fullNameFor(item.participant, item.ref.eventId) })),
    ...[...rosterParticipants.values()].map(participant => ({ ...participant, displayName: fullNameFor(participant, null) })),
  ]);

  const ownerCandidates = [...rosterParticipants.values()].filter(participant => participant.kind === 'human')
    .map(participant => ({ ownerId: participant.ownerId, displayName: fullNameFor(participant, null) }));
  /** The `.kh-own` badge: `YO` for the viewer's agents, else the owner's full-name initials (§3). */
  const ownerBadge = (identity: Identity) => identity.isViewerOwned ? 'YO'
    : identity.kind === 'agent' ? ownerInitials({ ownerId: identity.ownerId, label: identity.ownerLabel ?? '?' }, ownerCandidates)
    : initials(identity.label);

  function identityFor(participant: ParticipantView, fullName: string): Identity {
    const detail = describeParticipant?.(participant.participantId);
    const isViewerOwned = participant.ownerId === viewer.ownerId;
    const ownerHue = hueFor({ kind: 'human', ownerId: participant.ownerId, isViewer: isViewerOwned });
    const shared = { participantId: participant.participantId, ownerId: participant.ownerId, fullName, ownerHue, isViewerOwned };
    if (detail?.kind === 'unknown') {
      return { ...shared, kind: 'unknown', label: 'Unknown', hue: 0, idBadge: undefined, ownerLabel: null, harness: undefined };
    }
    // Names that collide across owners get the shared `.kh-id` owner suffix (roster and detail match).
    const idBadge = resolveIdBadge({ ownerId: participant.ownerId, displayName: fullName });
    if (participant.kind === 'human') {
      return { ...shared, kind: 'human', label: fullName, idBadge, ownerLabel: null, harness: undefined,
        hue: hueFor({ kind: 'human', ownerId: participant.ownerId, participantId: participant.participantId,
          isViewer: participant.participantId === viewer.participantId }) };
    }
    const split = splitAgentName(fullName);
    return { ...shared, kind: 'agent', label: split.label, idBadge, hue: hueFor({ kind: 'agent', participantId: participant.participantId }),
      ownerLabel: detail?.kind === 'agent' ? detail.ownerLabel : split.owner ?? (isViewerOwned ? firstName(viewer.displayName) : null),
      harness: detail?.kind === 'agent' ? detail.harness : undefined };
  }

  const open = (participantId: string) => () => onOpenParticipant?.(participantId);

  function nameLine(identity: Identity, participant: ParticipantView, time: string): ThreadRowName {
    const ownership = identity.kind === 'unknown' ? 'unknown participant' : ownershipLabel(attributionFor(participant, viewer.ownerId));
    const tag: ThreadRowName['tag'] = identity.kind === 'human' ? { kind: 'htag' }
      : identity.kind === 'agent' && (identity.isViewerOwned || identity.ownerLabel)
        ? { kind: 'otag', text: identity.isViewerOwned ? 'Your machine' : `${identity.ownerLabel}’s machine`, ownerHue: identity.ownerHue }
        : null;
    return {
      label: identity.label, hue: identity.hue, tag,
      ...(identity.idBadge ? { idBadge: identity.idBadge } : {}),
      ariaLabel: `${identity.label}${identity.idBadge ? ` ${identity.idBadge}` : ''}, ${ownership.charAt(0).toLocaleLowerCase('en-US')}${ownership.slice(1)}, ${clockLabel(new Date(time), timeOptions)}`,
      ...(identity.kind === 'unknown' ? {} : { onClick: open(identity.participantId) }),
    };
  }

  function avatarFor(identity: Identity, ghost: boolean): ReactNode {
    if (identity.kind === 'unknown') {
      return <span className={`kh-av${ghost ? ' ghost' : ''}`} style={{ '--h': identity.hue } as CSSProperties} aria-hidden="true">
        <span className="kh-ini">{initials(identity.label)}</span>
      </span>;
    }
    if (identity.kind === 'human') {
      return <Avatar kind="human" label={identity.label} hue={identity.hue} initials={initials(identity.label)} ghost={ghost}
        onClick={open(identity.participantId)} />;
    }
    return <Avatar kind="agent" label={`${identity.label} details`} hue={identity.hue} ownerHue={identity.ownerHue}
      ownerInitials={ownerBadge(identity)} logo={identity.harness ? harnessLogo(identity.harness) : null}
      initials={initials(identity.label)} ghost={ghost} onClick={open(identity.participantId)} />;
  }

  // The KM-184 chips and the renderer's `@mention` matching share one roster.
  const mentionTargets: MentionTarget[] = [...rosterParticipants.values()].flatMap(participant => {
    const identity = identityFor(participant, fullNameFor(participant, null));
    if (identity.kind === 'unknown') return [];
    const isViewer = participant.participantId === viewer.participantId;
    const label = identity.kind === 'agent' ? identity.label : firstName(identity.label);
    return [{
      id: identity.participantId, kind: identity.kind, label, display: identity.idBadge ? `${label} ${identity.idBadge}` : label,
      hue: identity.hue, ownerHue: identity.kind === 'agent' ? identity.ownerHue : identity.hue,
      ownerInitials: ownerBadge(identity),
      ...(identity.harness ? { harness: identity.harness } : {}), ownerId: identity.ownerId, isViewer,
    }];
  });
  const mentionKey = JSON.stringify(mentionTargets.map(target => [target.label, target.id, target.kind, target.hue]));
  // A stable array per roster, so `segmentMentions` compiles its matcher once.
  const mentionRoster = useMemo(() => (JSON.parse(mentionKey) as [string, string, 'human' | 'agent', number][])
    .map(([label, participantId, kind, hue]) => ({ label, participantId, kind, hue })), [mentionKey]);
  useEffect(() => { onMentionRoster?.(mentionRoster); }, [mentionRoster, onMentionRoster]);
  const renderOptions: RenderOptions = { mentions: mentionRoster, ...(onOpenParticipant ? { onOpenParticipant } : {}) };

  // A `failed` or `outcome_unknown` send keeps its body in the pending row, but
  // Send must stay disabled while it's unresolved: otherwise the reader could
  // submit the same text again under a fresh `clientTxnId`, duplicating a
  // send that may already have gone through (AE2). Only Retry — which reuses
  // the original `clientTxnId` — may resolve it.
  const visiblePending = pendingList.filter(entry => !isReconciled(entry, data.items));
  const anySendUnresolved = visiblePending.some(entry => entry.phase !== 'accepted');

  // Flatten rows into thread entries: day separators and events break runs (§7.1, §8).
  const today = now();
  const entries: ThreadEntry[] = [];
  let lastDay: string | null = null;
  const separateDay = (date: Date) => {
    const key = dayKey(date, timeOptions);
    if (key === lastDay) return;
    lastDay = key;
    entries.push({ type: 'break', key: `day-${entries.length}-${key}`, node: <li className="kh-day" role="separator">
      <b>{dayLabel(date, today, timeOptions)}</b> {dayTime(date, timeOptions)}
    </li> });
  };
  for (const row of rows) {
    if (row.kind === 'channel_event') {
      entries.push({ type: 'break', key: row.eventId, node: <ChannelEventPill id={row.eventId}
        content={row.content} senderName={row.participant.displayName} receivedAt={row.receivedAt} /> });
      continue;
    }
    if (row.kind === 'unavailable') {
      entries.push({ type: 'break', key: row.eventId, node: <li data-event-id={row.eventId}
        className="kh-ev kh-ev--static message-content__unavailable">Message unavailable on this device.</li> });
      continue;
    }
    const item = row.item;
    const eventId = item.ref.eventId;
    const nameEvent = attributed.get(eventId);
    if (item.content.kind === 'agent_name_snapshot') continue;
    if (item.content.kind === 'agent_rename') {
      if (data.namesReady !== false && nameEvent?.kind === 'agent_rename') {
        entries.push({ type: 'break', key: eventId, node: <ChatSystemEvent id={eventId} previousName={nameEvent.previousName}
          name={nameEvent.name} actor={nameEvent.actorName} time={item.receivedAt} timeOptions={timeOptions} /> });
      }
      continue;
    }
    for (const unit of evidence ? evidenceLayout.groupsBefore.get(eventId) ?? [] : []) {
      entries.push({ type: 'break', key: unit.id, node: <li className="timeline__evidence-group">
        <EvidenceGroup unit={unit} status={evidenceView.status} />
      </li> });
    }
    separateDay(new Date(item.receivedAt));
    // `.me` is the viewer's own human messages only; the viewer's agents are ordinary agent rows.
    const isViewer = item.participant.kind === 'human' && item.participant.participantId === viewer.participantId;
    const identity = identityFor(item.participant, fullNameFor(item.participant, eventId));
    const inlineEvidence = evidence ? evidenceLayout.inline.get(eventId) : undefined;
    const memberOf = evidence ? evidenceLayout.memberOf.get(eventId) ?? [] : [];
    entries.push({
      type: 'message', key: eventId, run: { kind: 'message', participantId: item.participant.participantId, isViewer },
      ...(isViewer ? { receipt: 'reconciled' as const } : {}),
      render: run => <ChatMessage id={eventId} run={run} sender={isViewer ? 'me' : identity.kind === 'human' ? 'human' : 'agent'}
        time={item.receivedAt} timeOptions={timeOptions} name={nameLine(identity, item.participant, item.receivedAt)} avatar={avatarFor(identity, run.ghost)}
        pop={popIds.has(eventId)} onPopEnd={() => dropPop(eventId)} className="timeline__row"
        after={<>
          {isReadableItem(item) && renderReviewAction ? <div className="timeline__review-slot">{renderReviewAction(item.ref)}</div> : null}
          {inlineEvidence ? <InlineEvidence unit={inlineEvidence} status={evidenceView.status} /> : null}
          {memberOf.map(unit => {
            const linkId = evidenceLinkId(unit, eventId);
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
        </>}>
        {isReadableItem(item) ? renderMessageContent(item.content, renderOptions)
          : <p className="message-content__unavailable">Content unavailable.</p>}
      </ChatMessage>,
    });
  }
  for (const entry of visiblePending) {
    separateDay(today);
    const retryLabel = entry.phase === 'outcome_unknown' ? 'Check delivery' : 'Retry';
    entries.push({
      type: 'message', key: entry.clientTxnId, receipt: entry.phase,
      run: { kind: 'message', participantId: viewer.participantId, isViewer: true },
      render: run => <ChatMessage id={entry.clientTxnId} run={run} sender="me" live pending={entry.phase === 'pending'}
        failed={isUnresolved(entry.phase)} pop={popIds.has(entry.clientTxnId)} onPopEnd={() => dropPop(entry.clientTxnId)}
        className="timeline__row timeline__row--pending"
        retry={isUnresolved(entry.phase) ? <button type="button" className="kh-ib sm kh-retry" aria-label={retryLabel}
          data-tip={retryLabel} disabled={sendBlocked} onClick={() => void handleRetry(entry)}><RestoreIcon /></button> : null}>
        {renderMessageContent(entry.content, renderOptions)}
      </ChatMessage>,
    });
  }
  const runs = computeRuns(entries.map(entry => entry.type === 'message' ? entry.run : { kind: 'break' as const }));
  const receiptAt = lastIndexOf(entries, entry => entry.type === 'message' && entry.receipt !== undefined);

  return (
    <section className="timeline" aria-label="Conversation">
      {data.phase === 'unavailable' ? (
        <div className="kh-state-c timeline__state" role="alert">
          <b>Conversation history is unavailable right now.</b>
          <button type="button" className="kh-btn" onClick={() => void controller.loadOlder()}>Retry</button>
        </div>
      ) : null}
      {data.phase === 'loading' ? (
        <div className="kh-state-c timeline__state" role="status">
          <span className="kh-spin" aria-hidden="true" /><b>Loading conversation…</b>
        </div>
      ) : null}
      {data.nameScan === 'checking' || data.nameScan === undefined && data.namesReady === false
        ? <p className="timeline__status" role="status">Checking agent names in encrypted history…</p> : null}
      {data.nameScan === 'retryable' ? <p className="timeline__status" role="alert">
        Agent names could not be checked because history did not load. You can retry while continuing this conversation.
      </p> : null}
      {(data.nameScan === 'retryable' || data.nameScan === 'unavailable')
        ? <button type="button" className="timeline__retry-history" onClick={() => { void controller.loadOlder().then(() => controller.scanNameHistory?.()); }}>Retry history</button> : null}
      {data.membership === 'revoked' || data.membership === 'left' ? (
        <div className="kh-state-c timeline__state timeline__status--membership" role="alert">
          <UserXIcon /><b>You no longer have access to this conversation.</b>
        </div>
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
        className="timeline__list kh-thread"
        ref={listRef}
        aria-label="Messages"
        onScroll={event => {
          const el = event.currentTarget;
          setAtLatest(el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX);
        }}
      >
        {rows.length === 0 && visiblePending.length === 0 && data.phase === 'ready' ? (unreadableActivity
          ? <li className="kh-empty">Messages in this channel are unavailable on this device.</li>
          : <li className="kh-empty"><b>No messages yet</b>
            {onInvite ? <button type="button" className="kh-btn pri" onClick={onInvite}>Invite</button> : null}</li>) : null}
        {entries.map((entry, index) => {
          const receipt = index === receiptAt && entry.type === 'message' && entry.receipt ? receiptFor(entry.receipt) : null;
          return <Fragment key={entry.key}>
            {entry.type === 'message' ? entry.render(runs[index]!) : entry.node}
            {receipt ? <li className={`kh-rcpt${receipt.failed ? ' kh-fail' : ''}`} role="status">{receipt.text}</li> : null}
          </Fragment>;
        })}
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
      <ChatComposer value={draft} onChange={setDraft} onSend={() => void handleSend()} chipsOpen={chipsOpen} onChipsOpenChange={setChipsOpen}
        disabled={!canCompose} sendDisabled={anySendUnresolved || sendBlocked} mentionTargets={mentionTargets}
        {...(sendBlocked ? { sendDescriptionId: 'timeline-send-blocked' } : {})} />
      {sendBlocked ? <p id="timeline-send-blocked" className="timeline__status" role="status">{sendBlockedReason}</p> : null}
    </section>
  );
}
