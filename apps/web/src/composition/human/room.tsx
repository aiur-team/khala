import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ListeningMode } from '@khala/contracts/m1/listening-mode';
import type { ParticipantId } from '@khala/contracts/messaging/ids';
import type { TimelineComposerHandle } from '../../features/timeline/TimelineScreen';
import { renderMessageContent } from '../../features/timeline/message-renderer';
import type { RenameAgentResult } from '../../features/channel/AgentPresencePanel';
import { createChannelController, type ChannelController, type ChannelView } from '../../features/channel/controller';
import type { NameParticipant } from '@khala/contracts/messaging/agent-names';
import type { ChannelNameResult, ChannelUiPort } from '../../features/channel/ports';
import { channelNamePrompts, nameAcknowledgements, type ChannelNameMember } from '../../features/channel/channel-names';
import { ChannelNameDialog, TAKEN_HERE, type ChannelNameSave } from '../../features/channel/ChannelNameDialog';
import { ChannelScreen } from '../../features/channel/ChannelScreen';
import { createTimelineController } from '../../features/timeline/controller';
import { TimelineScreen } from '../../features/timeline/TimelineScreen';
import { projectTimelineNames } from '../../features/timeline/names';
import type { ParticipantView, RoomId } from '@khala/contracts/messaging/index';
import { Panel } from '../../shell/Panel';
import { LoadingSpinner } from '../../ui/khala/LoadingSpinner';
import { useHumanAccount, type HumanRoomRenderer } from './mount';
import { ChannelAddAgent, ChannelInvite } from '../../features/channel/ChannelSharePanel';
import { useConversationIndex } from './ConversationIndexRoute';
import type { HumanRouteCodec } from './routes';
import { createHumanPendingSendStore } from './pending-send-store';
import { guardedListeningModeSetter } from './listening-modes';
import { useProfile } from '../../features/profile/ProfileProvider';

function hostedPresence(context: Parameters<HumanRoomRenderer>[0], onParticipants: (participants: readonly ParticipantView[]) => void): ChannelUiPort {
  let readEpoch = 0;
  const agents: ChannelUiPort['agents'] = async (roomId, signal) => {
    const epoch = ++readEpoch;
    const participants = await context.roomParticipants?.(roomId, signal);
    if (!participants) throw new Error('agent roster unavailable');
    if (!signal.aborted && epoch === readEpoch) onParticipants(participants);
    return { generation: context.generation, agents: participants.filter(item => item.kind === 'agent').map(item => ({
      participantId: item.participantId, ownerId: item.ownerId, displayName: item.displayName,
      ownerDisplayName: participants.find(owner => owner.kind === 'human' && owner.ownerId === item.ownerId)?.displayName ?? 'Channel member',
      connection: 'unknown' as const, routeLabel: 'Channel agent', lastReceipt: null, acknowledgement: 'unknown' as const,
    })) };
  };
  return {
    agents,
    subscribeAgents(roomId, listener) {
      let epoch = 0;
      let request: AbortController | null = null;
      const timer = setInterval(() => {
        request?.abort();
        request = new AbortController();
        const current = ++epoch;
        void agents(roomId, request.signal).then(snapshot => {
          if (current === epoch && !request?.signal.aborted) listener(snapshot);
        }).catch(() => {});
      }, 5_000);
      return () => { ++epoch; request?.abort(); clearInterval(timer); };
    },
    async installCommand() { throw new Error('agent onboarding unavailable'); },
  };
}


/**
 * The participants whose names outrank what older timeline events carry: roster agents, and every other human at
 * their current directory name, so a username change reaches the header, roster and mention chips without a reload.
 */
export function roomNameParticipants(agents: ChannelView['agents'], members: readonly ParticipantView[],
  viewerId: string | null): NameParticipant[] {
  return [...agents.flatMap(agent => agent.ownerId ? [{
    participantId: agent.participantId, ownerId: agent.ownerId, kind: 'agent' as const, initialName: agent.displayName,
  }] : []), ...members.filter(member => member.kind === 'human' && member.participantId !== viewerId).map(human => ({
    participantId: human.participantId, ownerId: human.ownerId, kind: 'human' as const, initialName: human.displayName,
  }))];
}

/**
 * Renames one of the viewer's agents. An agent is one member of one channel, so
 * this is its name in that channel; `roomId` keeps it unique there.
 */
export async function renameChannelAgent(context: Pick<Parameters<HumanRoomRenderer>[0], 'agentNames' | 'describeParticipant'>,
  room: Pick<ChannelController, 'getSnapshot'>, viewer: ParticipantView, participantId: ParticipantId, name: string,
  signal?: AbortSignal, roomId?: RoomId,
): Promise<RenameAgentResult> {
  const target = room.getSnapshot().agents.find(agent => agent.participantId === participantId);
  if (viewer.kind !== 'human' || target?.ownerId !== viewer.ownerId) return { kind: 'error', code: 'not_owner' };
  const detail = context.describeParticipant?.(participantId);
  if (!context.agentNames || detail?.kind !== 'agent') return { kind: 'error', code: 'unavailable' };
  return roomId === undefined ? context.agentNames.rename(detail.matrixUserId, name, signal)
    : context.agentNames.rename(detail.matrixUserId, name, signal, roomId);
}

/** The prompt's message for a failed save. */
export function channelNameSaveError(result: Extract<ChannelNameResult | RenameAgentResult, { kind: 'error' }>): string {
  if (result.code === 'name_taken') return TAKEN_HERE;
  if (result.code === 'signed_out') return 'You were signed out. Sign in again.';
  if (result.code === 'invalid_name') return 'Choose a different name.';
  return 'Couldn’t save. Try again.';
}

/** The channel's members as the name prompt sees them: this tab's just-saved names win over the roster. */
export function channelNameMembers(roster: readonly ParticipantView[], overrides: ReadonlyMap<string, string>,
  since: (participantId: string) => number | null): ChannelNameMember[] {
  return roster.map(member => ({ participantId: member.participantId, kind: member.kind, ownerId: member.ownerId,
    name: overrides.get(member.participantId) ?? member.displayName, since: since(member.participantId) }));
}

export const renderHumanRoom: HumanRoomRenderer = (context, route, navigate, routes) => (
  <HumanRoom key={`${context.principal.ownerId}:${context.generation}:${route.roomId}`} context={context} roomId={route.roomId}
    {...(navigate && routes ? { navigate, routes } : {})} />
);

function HumanRoom({ context, roomId, navigate, routes }: {
  context: Parameters<HumanRoomRenderer>[0];
  roomId: Parameters<HumanRoomRenderer>[1]['roomId'];
  navigate?: (path: string) => void;
  routes?: HumanRouteCodec;
}) {
  const conversations = useConversationIndex(context);
  // Updates the instant a Profile save succeeds, so the viewer sees their own choice at once.
  const { initials: viewerInitials, color: viewerColor, username } = useProfile();
  const selectedConversation = conversations?.find(item => item.id === roomId);
  const timeline = useMemo(
    () => createTimelineController(context.room, roomId, { generation: context.generation, pageSize: 50 }),
    [context.generation, context.room, roomId],
  );
  const deviceId = context.device.current().deviceId;
  const pendingStore = useMemo(() => deviceId === null ? undefined
    : createHumanPendingSendStore(context.principal.ownerId, deviceId, roomId),
  [context.principal.ownerId, deviceId, roomId]);
  const participantScope = JSON.stringify([context.principal.ownerId, context.generation, roomId]);
  const [participantRoster, setParticipantRoster] = useState<Readonly<{
    scope: string; participants: readonly ParticipantView[];
  }> | null>(null);
  const room = useMemo(
    () => createChannelController(hostedPresence(context, participants => setParticipantRoster({ scope: participantScope, participants })),
      { roomId, generation: context.generation }),
    [context, roomId, participantScope],
  );
  useEffect(() => () => {
    timeline.dispose();
    room.dispose();
  }, [room, timeline]);
  const account = useHumanAccount();
  const viewer = context.participant?.() ?? null;
  const timelineData = useSyncExternalStore(timeline.subscribe, timeline.getSnapshot, timeline.getSnapshot);
  const presence = useSyncExternalStore(room.subscribe, room.getSnapshot, room.getSnapshot);
  const extraParticipants = roomNameParticipants(presence.agents,
    participantRoster?.scope === participantScope ? participantRoster.participants : [], viewer?.participantId ?? null);
  // A membership pill (a rename, a join) means the directory changed: read it now rather than at the next poll.
  const memberEvents = (timelineData.rows ?? []).filter(row => row.kind === 'channel_event' && row.content.kind === 'member').length;
  const seenMemberEvents = useRef<number | null>(null);
  useEffect(() => {
    const previous = seenMemberEvents.current;
    seenMemberEvents.current = memberEvents;
    if (previous !== null && memberEvents !== previous) room.refresh?.();
  }, [memberEvents, room]);
  const matrixUserId = (participantId: string) => context.describeParticipant?.(participantId)?.matrixUserId;
  const modeFor = (participantId: string): ListeningMode => {
    const userId = matrixUserId(participantId);
    return userId && context.listeningMode ? context.listeningMode(roomId, userId) : 'sync';
  };
  const subscribeModes = useCallback((listener: () => void) => context.subscribeListeningModes?.(roomId, listener) ?? (() => undefined),
    [context, roomId]);
  // Re-renders the roster when any agent's reported mode changes.
  const modesSnapshot = () => presence.agents.map(agent => modeFor(agent.participantId)).join();
  useSyncExternalStore(subscribeModes, modesSnapshot, modesSnapshot);
  // Names this tab just set through the rename API. They show at once, ahead of
  // the participant directory and the agent's Matrix display name, and drop once
  // a presence read reports the same name.
  const [renamed, setRenamed] = useState<ReadonlyMap<ParticipantId, string>>(new Map());
  useEffect(() => {
    const participants = participantRoster?.participants;
    if (!participants || renamed.size === 0) return;
    const settled = [...renamed].filter(([participantId, name]) =>
      participants.some(item => item.participantId === participantId && item.displayName === name));
    if (settled.length > 0) setRenamed(current => new Map([...current].filter(([participantId]) => !settled.some(([id]) => id === participantId))));
  }, [participantRoster, renamed]);
  // The viewer's name in this channel, when it differs from their username: one they just saved here
  // (shown at once, dropped once the roster agrees), else the roster's channel-scoped name.
  const [ownName, setOwnName] = useState<string | null>(null);
  const roster = participantRoster?.scope === participantScope ? participantRoster.participants : null;
  const rosterSelf = viewer ? roster?.find(member => member.participantId === viewer.participantId) : undefined;
  useEffect(() => { if (ownName !== null && rosterSelf?.displayName === ownName) setOwnName(null); }, [ownName, rosterSelf?.displayName]);
  const channelName = ownName ?? (rosterSelf && username && rosterSelf.displayName !== username ? rosterSelf.displayName : null);
  const channelViewer = useMemo(() => viewer && channelName && channelName !== viewer.displayName ? { ...viewer, displayName: channelName } : viewer,
    [viewer, channelName]);
  const acknowledgements = useMemo(() => nameAcknowledgements(context.principal.ownerId, roomId), [context.principal.ownerId, roomId]);
  const [, setAcknowledged] = useState(0);
  const projectedNames = channelViewer ? projectTimelineNames(timelineData.nameHistory ?? timelineData.items, channelViewer, extraParticipants).currentNames : undefined;
  const currentNames = projectedNames && renamed.size > 0 ? new Map([...projectedNames, ...renamed]) : projectedNames;
  const baseDescribe = context.describeParticipant;
  const describeParticipant = useMemo(() => baseDescribe && ((participantId: string) => {
    const detail = baseDescribe(participantId);
    const name = renamed.get(participantId as ParticipantId);
    return detail?.kind === 'agent' && name !== undefined ? { ...detail, displayName: name } : detail;
  }), [baseDescribe, renamed]);
  const composer = useRef<TimelineComposerHandle>(null);
  if (context.conversations && conversations === undefined) {
    return <LoadingSpinner />;
  }
  if (context.conversations && conversations === null) {
    return <Panel heading="Conversation unavailable"><p role="alert">Channel access could not be checked. Try reloading.</p></Panel>;
  }
  if (context.conversations && conversations && !conversations.some(item => item.id === roomId)) {
    return <Panel heading="Conversation unavailable"><p role="alert">{account === 'local_owner' ? 'You no longer have access to this channel.' : 'You no longer have access to this encrypted conversation.'}</p></Panel>;
  }
  if (viewer === null) {
    return (
      <Panel heading="Conversation unavailable">
        <p role="alert">Participant attribution is unavailable for this session.</p>
      </Panel>
    );
  }

  const linkSource = context.admission ? { admission: context.admission, roomId,
    ...(context.channelLinks ? { channelLinks: context.channelLinks } : {}) } : null;
  // Only the viewer's own name, or their own agents', is ever prompted for, and only when it collides here.
  const sinceOf = (participantId: string) => {
    const userId = matrixUserId(participantId);
    return userId && context.memberSince ? context.memberSince(roomId, userId) : null;
  };
  const prompt = roster ? channelNamePrompts({
    members: channelNameMembers(roster, new Map([...renamed, ...(ownName ? [[viewer.participantId, ownName] as const] : [])]), sinceOf),
    viewerParticipantId: viewer.participantId, viewerOwnerId: viewer.ownerId, acknowledged: acknowledgements.has,
  }).find(item => item.kind === 'human' ? context.channelNames : context.agentNames) ?? null : null;
  const saveChannelName: ChannelNameSave = async (name, signal) => {
    if (!prompt) return { kind: 'ok' };
    if (prompt.kind === 'human') {
      const result: ChannelNameResult = await context.channelNames?.setOwnName(roomId, name, signal) ?? { kind: 'error', code: 'unavailable' };
      if (result.kind === 'error') return { kind: 'error', message: channelNameSaveError(result) };
      setOwnName(result.name);
      room.refresh?.();
      return { kind: 'ok' };
    }
    const participantId = prompt.participantId as ParticipantId;
    let saved = name;
    if (name !== prompt.name) {
      const result = await renameChannelAgent(context, room, viewer, participantId, name, signal, roomId);
      if (result.kind === 'error') return { kind: 'error', message: channelNameSaveError(result) };
      saved = result.name;
      setRenamed(current => new Map([...current, [participantId, saved]]));
      room.refresh?.();
    }
    acknowledgements.add(participantId, saved);
    setAcknowledged(count => count + 1);
    return { kind: 'ok' };
  };
  return (<>
    <ChannelScreen
      title={selectedConversation?.title ?? (account === 'local_owner' ? 'Channel' : 'Encrypted conversation')}
      controller={room}
      viewerOwnerId={viewer.ownerId}
      viewerName={channelViewer?.displayName ?? viewer.displayName}
      viewerEmail={context.principal.verifiedEmail}
      viewerInitials={viewerInitials}
      viewerParticipantId={viewer.participantId}
      viewerColor={viewerColor}
      {...(participantRoster?.scope === participantScope ? { humanParticipants: participantRoster.participants
        .filter(participant => participant.kind === 'human' && participant.participantId !== viewer.participantId) } : {})}
      {...(currentNames ? { currentNames } : {})}
      {...(describeParticipant ? { describeParticipant } : {})}
      modeFor={modeFor}
      {...(context.setListeningMode ? { onSetMode: guardedListeningModeSetter({ roomId, viewer, matrixUserId,
        ownerOf: participantId => room.getSnapshot().agents.find(agent => agent.participantId === participantId)?.ownerId,
        joined: () => timeline.getSnapshot().membership === 'joined', send: context.setListeningMode }) } : {})}
      {...(context.agentNames ? { renameAgent: async (participantId: ParticipantId, name: string, signal?: AbortSignal) => {
        const result = await renameChannelAgent(context, room, viewer, participantId, name, signal, roomId);
        if (result.kind === 'ok') {
          setRenamed(current => new Map([...current, [participantId, result.name]]));
          room.refresh?.();
        }
        return result;
      } } : {})}
      recentActivity={(participantId, render) => timelineData.items
        .flatMap(item => item.content.kind === 'text' && item.ref.authorParticipantId === participantId
          ? [{ id: item.ref.eventId, at: item.receivedAt, body: renderMessageContent(item.content, render) }] : [])
        .slice(-3).reverse()}
      onMention={label => composer.current?.insertMention(label)}
      onRosterOpen={() => composer.current?.closeChips()}
      {...(navigate && routes ? { onBack: () => navigate(routes.conversationsPath()) } : {})}
      {...(linkSource ? {
        renderShare: () => <ChannelInvite key={`${context.principal.ownerId}:${context.generation}:${roomId}`} {...linkSource} />,
        renderAddAgent: () => <ChannelAddAgent key={`${context.principal.ownerId}:${context.generation}:${roomId}`} {...linkSource} />,
      } : {})}
      renderTimeline={(openParticipant, openInvite, onMentionRoster) => (
        <TimelineScreen key={JSON.stringify([context.principal.ownerId, deviceId, context.generation, roomId])}
          controller={timeline} roomPort={context.room} roomId={roomId} viewer={channelViewer ?? viewer} viewerInitials={viewerInitials} composerRef={composer}
          extraParticipants={extraParticipants} onOpenParticipant={openParticipant} onMentionRoster={onMentionRoster}
          {...(participantRoster?.scope === participantScope ? { members: participantRoster.participants } : {})}
          {...(openInvite ? { onInvite: openInvite } : {})}
          {...(describeParticipant ? { describeParticipant } : {})}
          {...(pendingStore ? { pendingStore } : {})}
          unreadableActivity={selectedConversation?.preview === null && selectedConversation.timestamp !== null} />
      )}
    />
    {prompt ? <ChannelNameDialog key={JSON.stringify([prompt.participantId, prompt.name, prompt.reason])} prompt={prompt} onSave={saveChannelName} /> : null}
  </>);
}
