// The channel's main pane (RECREATION-SPEC §5, §6, §11): the thread header,
// the roster disclosure over the thread, the header actions and the
// participant detail pane, which renders into the card's `.kh-detail`.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
  type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Participant } from '@khala/contracts/m1/participants';
import type { OwnerId, ParticipantId } from '@khala/contracts/messaging/ids';
import type { ThemeChoice } from '../../shell/types';
import { ParticipantDetail } from '../../ui/conversation/ParticipantDetail';
import { Avatar } from '../../ui/khala/Avatar';
import { clockLabel, dayLabel, type TimeOptions } from '../../ui/khala/format-time';
import { ChevronDownIcon, ChevronLeftIcon, ShareIcon } from '../../ui/khala/icons';
import { useDetailHost } from '../../ui/khala/KhalaApp';
import { Popover } from '../../ui/khala/Popover';
import type { ListeningMode } from '@khala/contracts/m1/listening-mode';
import { AgentName, ChannelRoster, harnessName, MemberAvatar, RenameAgent, type RenameAgentHandler, type SetModeHandler } from './AgentPresencePanel';
import type { ChannelController } from './controller';
import { agentsOwnedBy, resolveMembers, type AgentMember, type ChannelMembers, type HumanMember } from './members';
import { memberCountLabel, ownerOfLabel } from './roster-model';

/** One loaded message for the detail pane's "Recent in Khala". */
export type RecentEntry = Readonly<{ id: string; at: string; body: ReactNode }>;
/** The thread's `@mention` roster: the timeline's `MentionCandidate`s. */
export type MentionRoster = readonly Readonly<{ label: string; participantId: string; kind: 'human' | 'agent'; hue: number }>[];
/** How a Recent in Khala body renders, as the timeline's `RenderOptions`. */
export type RecentRender = Readonly<{ mentions: MentionRoster; onOpenParticipant: (participantId: string) => void }>;

export interface ChannelScreenProps {
  title: string;
  /** @deprecated The design header has no description line. */
  description?: string;
  /** @deprecated The surrounding `KhalaApp` owns the theme. */
  theme?: ThemeChoice;
  controller: ChannelController;
  viewerOwnerId?: OwnerId;
  viewerName?: string;
  /** The viewer's verified sign-in email, shown beside their name in the roster and detail pane. */
  viewerEmail?: string;
  viewerParticipantId?: ParticipantId;
  /** Other humans in member order. */
  humanParticipants?: readonly Readonly<{ participantId: ParticipantId; displayName: string; ownerId?: OwnerId }>[];
  currentNames?: ReadonlyMap<ParticipantId, string>;
  /** Renames one of the viewer's agents; the roster's Rename buttons and the detail pane's Rename section need it. */
  renameAgent?: RenameAgentHandler;
  /** An agent's reported listening mode; read-only rows show it. */
  modeFor?: (participantId: string) => ListeningMode;
  /** Sends a listening-mode change for one of the viewer's agents. Without it the control stays locked. */
  onSetMode?: SetModeHandler;
  /** C3 participant details: an agent's harness and owner label. */
  describeParticipant?: (participantId: string) => Participant | undefined;
  /**
   * A participant's last loaded messages, newest first. Render each body with
   * `render`, so its `@mentions` are the timeline's chips and open their detail.
   */
  recentActivity?: (participantId: string, render: RecentRender) => readonly RecentEntry[];
  /** When an agent joined, if known (RFC 3339). */
  agentJoinedAt?: (participantId: string) => string | undefined;
  /**
   * The thread; `openParticipant` opens (or, if open, closes) a participant's detail.
   * `openInvite` opens the Invite popover, and is absent when Invite is hidden.
   * Pass `onMentionRoster` to the timeline so Recent in Khala matches its `@mentions`.
   */
  renderTimeline: (openParticipant: (participantId: string) => void, openInvite: (() => void) | undefined,
    onMentionRoster: (roster: MentionRoster) => void) => ReactNode;
  /** The Invite popover body. Invite shows only when this is supplied (the admin path, R2). */
  renderShare?: () => ReactNode;
  /** The Add agent popover body on the viewer's roster row. */
  renderAddAgent?: () => ReactNode;
  /** `@ Mention` in the detail pane: inserts `@{label} ` into the composer. */
  onMention?: (label: string) => void;
  /** Opening the roster closes the composer's chips grid. */
  onRosterOpen?: () => void;
  onBack?: () => void;
  /** Fixtures and tests pass UTC; the product uses the viewer's local time. */
  timeOptions?: TimeOptions;
  /** @deprecated The screen always renders inside `KhalaApp`. */
  embedded?: boolean;
}

/** @deprecated Use `ChannelScreenProps`. Kept through the first tagged release containing #163. */
export type RoomScreenProps = ChannelScreenProps;

function timeLabel(at: string): string {
  const date = new Date(at);
  const now = new Date();
  return dayLabel(date, now) === 'Today' ? clockLabel(date) : dayLabel(date, now);
}

/** The detail pane's "Recent in Khala" list. */
export function Recent({ entries, timeOptions }: Readonly<{ entries: readonly RecentEntry[]; timeOptions: TimeOptions }>) {
  return <div className="kh-d-sec"><span className="kh-d-lbl">Recent in Khala</span>
    {entries.length > 0 ? <div className="kh-d-log">{entries.map(entry => <div key={entry.id}>
      <time dateTime={entry.at}>{clockLabel(new Date(entry.at), timeOptions)}</time><span>{entry.body}</span>
    </div>)}</div> : <p className="kh-d-none">No recent messages.</p>}
  </div>;
}

function HumanDetail({ human, members, recent, timeOptions, onOpen, onMention, onClose }: Readonly<{
  human: HumanMember; members: ChannelMembers; recent: readonly RecentEntry[];
  onOpen(participantId: string): void; onMention: ((label: string) => void) | undefined; onClose(): void; timeOptions: TimeOptions;
}>) {
  const agents = agentsOwnedBy(members, human.ownerId);
  const openAgent = (agent: AgentMember) => onOpen(agent.participantId);
  return <ParticipantDetail name={`${human.isViewer ? 'Your' : `${human.name}’s`} details`} kind="Human" onClose={onClose}>
    <div className="kh-d-hero"><MemberAvatar member={human} /><b>{human.isViewer ? `${human.name} (you)` : human.name}</b>
      {human.email ? <span className="kh-email" title={human.email}>{human.email}</span> : null}
      <span>{ownerOfLabel(agents.length)}</span></div>
    {agents.length > 0 ? <div className="kh-d-sec"><span className="kh-d-lbl">Agents · {agents.length}</span>
      <div className="kh-d-agents">{agents.map(agent => <div key={agent.participantId} role="button" tabIndex={0} className="kh-d-agent"
        data-kh-agent={agent.participantId} onClick={() => openAgent(agent)}
        onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openAgent(agent); } }}>
        <MemberAvatar member={agent} /><span><AgentName agent={agent} /><em>{harnessName(agent)}</em></span>
      </div>)}</div></div> : null}
    <Recent entries={recent} timeOptions={timeOptions} />
    {!human.isViewer && onMention ? <div className="kh-d-act">
      <button type="button" className="pri" onClick={() => onMention(human.short)}>@ Mention {human.short}</button>
    </div> : null}
  </ParticipantDetail>;
}

function AgentDetail({ agent, members, recent, timeOptions, joinedAt, rename, onOpen, onMention, onClose }: Readonly<{
  agent: AgentMember; members: ChannelMembers; recent: readonly RecentEntry[]; joinedAt: string | undefined;
  rename: ReactNode; onOpen(participantId: string): void; onMention: ((label: string) => void) | undefined; onClose(): void; timeOptions: TimeOptions;
}>) {
  const owner = [members.viewer, ...members.humans].find(human => human.ownerId === agent.ownerId);
  const pill = <><i>{agent.ownerInitials}</i>
    {agent.isViewerOwned ? <span>Your agent</span> : <span>Owned by <b>{agent.ownerName}</b></span>}</>;
  const pillStyle = { '--oh': agent.ownerHue } as CSSProperties;
  return <ParticipantDetail name={`${agent.name} details`} kind="Agent" onClose={onClose}>
    <div className="kh-d-hero"><MemberAvatar member={agent} /><AgentName agent={agent} /><span>{harnessName(agent)}</span>
      {owner ? <button type="button" className="kh-d-owner" data-kh-human={owner.participantId} style={pillStyle}
        onClick={() => onOpen(owner.participantId)}>{pill}</button>
        : <span className="kh-d-owner" style={pillStyle}>{pill}</span>}</div>
    <div className="kh-d-sec"><dl className="kh-d-kv">
      <dt>Harness</dt><dd>{harnessName(agent)}</dd>
      <dt>Owner</dt><dd>{agent.isViewerOwned ? 'You' : agent.ownerName}</dd>
      {joinedAt ? <><dt>Joined</dt><dd>{timeLabel(joinedAt)}</dd></> : null}
    </dl></div>
    <Recent entries={recent} timeOptions={timeOptions} />
    {onMention ? <div className="kh-d-act"><button type="button" className="pri" onClick={() => onMention(agent.name)}>@ Mention</button></div> : null}
    {rename ? <div className="kh-d-sec"><span className="kh-d-lbl">Rename</span>{rename}</div> : null}
  </ParticipantDetail>;
}

/** `--kh-head-h` and `--kh-roster-max` (§6.3), on `.kh-main`. */
function measureRoster(main: HTMLElement, head: HTMLElement): void {
  const headHeight = head.offsetHeight;
  main.style.setProperty('--kh-head-h', `${headHeight}px`);
  main.style.setProperty('--kh-roster-max', `${Math.max(160, Math.round((main.clientHeight - headHeight) * 0.7))}px`);
}

export function ChannelScreen({ title, controller, viewerOwnerId, viewerName, viewerEmail, viewerParticipantId, humanParticipants, currentNames,
  renameAgent, modeFor, onSetMode, describeParticipant, recentActivity, agentJoinedAt, renderTimeline, renderShare,
  renderAddAgent, onMention, onRosterOpen, onBack, timeOptions = {} }: ChannelScreenProps) {
  const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const members = useMemo(() => resolveMembers({
    viewer: { ...(viewerParticipantId ? { participantId: viewerParticipantId } : {}), ...(viewerOwnerId ? { ownerId: viewerOwnerId } : {}),
      ...(viewerName ? { name: viewerName } : {}), ...(viewerEmail ? { email: viewerEmail } : {}) },
    humans: humanParticipants ?? [], agents: view.agents, currentNames, describeParticipant,
  }), [describeParticipant, currentNames, humanParticipants, view.agents, viewerEmail, viewerName, viewerOwnerId, viewerParticipantId]);

  const room = useRef<HTMLDivElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const headButton = useRef<HTMLButtonElement>(null);
  const rosterList = useRef<HTMLDivElement>(null);
  const invite = useRef<HTMLButtonElement>(null);
  const [rosterOpen, setRosterOpen] = useState(false);
  const [more, setMore] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [mentionRoster, setMentionRoster] = useState<MentionRoster>([]);

  const closeRoster = useCallback((returnFocus: boolean) => {
    setRosterOpen(false);
    if (returnFocus) headButton.current?.focus();
  }, []);
  function toggleRoster(): void {
    if (rosterOpen) { closeRoster(false); return; }
    setRosterOpen(true);
    onRosterOpen?.();
  }

  useLayoutEffect(() => {
    const roomElement = room.current;
    const headElement = head.current;
    if (!rosterOpen || !roomElement || !headElement) return undefined;
    const main = roomElement.closest<HTMLElement>('.kh-main') ?? roomElement;
    const update = () => {
      measureRoster(main, headElement);
      const list = rosterList.current;
      if (list) setMore(list.scrollHeight - list.scrollTop - list.clientHeight >= 4);
    };
    update();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(update);
    observer.observe(main);
    observer.observe(headElement);
    return () => observer.disconnect();
  }, [rosterOpen, members.groups.length, members.agents.length]);

  // Re-selecting the open participant closes the pane (§11).
  const toggleParticipant = useCallback((participantId: string) => {
    setSelected(current => current === participantId ? null : participantId);
  }, []);
  const openFromRoster = useCallback((participantId: string) => {
    toggleParticipant(participantId);
  }, [toggleParticipant]);
  // A roster Rename opens the agent's pane with the rename field focused; each press refocuses it.
  const [renameFocus, setRenameFocus] = useState<Readonly<{ participantId: string; request: number }> | null>(null);
  const renameFromRoster = useCallback((participantId: string) => {
    setSelected(participantId);
    setRenameFocus(current => ({ participantId, request: (current?.request ?? 0) + 1 }));
  }, []);
  const selectedMember = selected === null ? undefined : members.byId.get(selected);
  // The pane closes when its participant leaves the channel.
  useEffect(() => {
    if (selected !== null && !selectedMember && view.phase === 'ready') setSelected(null);
  }, [selected, selectedMember, view.phase]);
  useEffect(() => {
    if (renameFocus && renameFocus.participantId !== selected) setRenameFocus(null);
  }, [renameFocus, selected]);

  const detailHost = useDetailHost(selectedMember !== undefined);
  const closeDetail = () => setSelected(null);
  let detail: ReactNode = null;
  const recent = (participantId: string) => recentActivity?.(participantId, { mentions: mentionRoster, onOpenParticipant: setSelected }) ?? [];
  if (selectedMember?.kind === 'human') {
    detail = <HumanDetail key={selectedMember.participantId} human={selectedMember} members={members}
      recent={recent(selectedMember.participantId)} onOpen={setSelected} onMention={onMention} onClose={closeDetail} timeOptions={timeOptions} />;
  } else if (selectedMember?.kind === 'agent') {
    const focus = renameFocus?.participantId === selectedMember.participantId ? renameFocus : null;
    detail = <AgentDetail key={selectedMember.participantId} agent={selectedMember} members={members}
      recent={recent(selectedMember.participantId)} joinedAt={agentJoinedAt?.(selectedMember.participantId)}
      rename={selectedMember.isViewerOwned && renameAgent ? <RenameAgent key={focus?.request ?? 0}
        participantId={selectedMember.participantId} name={selectedMember.name} renameAgent={renameAgent} autoFocus={focus !== null} /> : null}
      onOpen={setSelected} onMention={onMention} onClose={closeDetail} timeOptions={timeOptions} />;
  }

  const others = [...members.humans, ...members.agents];
  const humanCount = 1 + members.humans.length;
  const counts = view.phase === 'ready' ? memberCountLabel(humanCount, members.agents.length)
    : view.phase === 'loading' ? 'Checking participants…' : 'Participants unavailable';

  function onRosterKeyDown(event: KeyboardEvent<HTMLElement>): void {
    if (event.key !== 'Escape' || !rosterOpen) return;
    // A popover opened from the roster closes first (§6.3).
    if (event.target instanceof Element && event.target.closest('.kh-pop')) return;
    event.preventDefault();
    closeRoster(true);
  }

  return <div ref={room} className={`kh-channel${rosterOpen ? ' roster-open' : ''}`}>
    <h1 className="sr-only" id="khala-channel-title" dir="auto">{title}</h1>
    <div ref={head} className="kh-head" onKeyDown={onRosterKeyDown}>
      {onBack ? <button type="button" className="kh-back" aria-label="All channels" onClick={onBack}><ChevronLeftIcon /></button> : null}
      <div className="kh-stack">
        {others.slice(0, 4).map(member => <MemberAvatar key={member.participantId} member={member} interactive
          onClick={() => toggleParticipant(member.participantId)} />)}
        {others.length > 4 ? <Avatar kind="more" count={others.length - 4} /> : null}
      </div>
      <button ref={headButton} type="button" className="kh-head-t" id="kh-head-btn" aria-expanded={rosterOpen} aria-controls="kh-roster"
        onClick={toggleRoster}>
        <b><span dir="auto">{title}</span><span className="kh-chev" aria-hidden="true"><ChevronDownIcon /></span></b>
        <span>{['You', ...members.humans.map(human => human.short)].join(', ')} · <span className="on">{counts}</span></span>
      </button>
      <div className="kh-hacts">
        {renderShare ? <button ref={invite} type="button" className="kh-ib" data-tip="Invite" aria-label="Invite" aria-expanded={inviteOpen}
          onClick={() => setInviteOpen(open => !open)}><ShareIcon /></button> : null}
      </div>
    </div>
    {renderShare ? <Popover anchor={invite} open={inviteOpen} onClose={() => setInviteOpen(false)}>{renderShare()}</Popover> : null}
    <div className={`kh-roster${rosterOpen ? ' is-open' : ''}`} id="kh-roster" inert={!rosterOpen} onKeyDown={onRosterKeyDown}>
      <div ref={rosterList} className={`kh-roster-in${more ? ' more' : ''}`} role="group" aria-label="Channel members"
        onScroll={event => { const list = event.currentTarget; setMore(list.scrollHeight - list.scrollTop - list.clientHeight >= 4); }}>
        <ChannelRoster members={members} phase={view.phase} onOpen={openFromRoster}
          {...(renameAgent ? { onRename: renameFromRoster } : {})}
          {...(renderAddAgent ? { renderAddAgent } : {})} {...(modeFor ? { modeFor } : {})} {...(onSetMode ? { onSetMode } : {})} />
      </div>
    </div>
    <div className="kh-channel-thread" onPointerDown={() => { if (rosterOpen) closeRoster(false); }}>
      {renderTimeline(toggleParticipant, renderShare ? () => setInviteOpen(true) : undefined, setMentionRoster)}
    </div>
    {detail && detailHost ? createPortal(detail, detailHost) : null}
  </div>;
}

/** @deprecated Use `ChannelScreen`. Kept through the first tagged release containing #163. */
export const RoomScreen = ChannelScreen;
