import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ListeningMode } from '@khala/contracts/m1/listening-mode';
import type { ParticipantId } from '@khala/contracts/messaging/ids';
import type { TimelineComposerHandle } from '../../features/timeline/TimelineScreen';
import { renderMessageContent } from '../../features/timeline/message-renderer';
import type { RenameAgentResult } from '../../features/channel/AgentPresencePanel';
import { createChannelController, type ChannelController } from '../../features/channel/controller';
import type { ChannelUiPort } from '../../features/channel/ports';
import { ChannelScreen } from '../../features/channel/ChannelScreen';
import { createTimelineController } from '../../features/timeline/controller';
import { TimelineScreen } from '../../features/timeline/TimelineScreen';
import { projectTimelineNames } from '../../features/timeline/names';
import type { ParticipantView } from '@khala/contracts/messaging/index';
import { Panel } from '../../shell/Panel';
import { LoadingSpinner } from '../../ui/khala/LoadingSpinner';
import type { HumanRoomRenderer } from './mount';
import { ChannelAddAgent, ChannelInvite } from '../../features/channel/ChannelSharePanel';
import { useConversationIndex } from './ConversationIndexRoute';
import type { HumanRouteCodec } from './routes';
import { createHumanPendingSendStore } from './pending-send-store';
import { guardedListeningModeSetter } from './listening-modes';

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
 * Renames one of the viewer's agents in this channel through the global rename
 * API, which also sets the agent's Matrix display name in every room.
 */
export async function renameChannelAgent(context: Pick<Parameters<HumanRoomRenderer>[0], 'agentNames' | 'describeParticipant'>,
  room: Pick<ChannelController, 'getSnapshot'>, viewer: ParticipantView, participantId: ParticipantId, name: string,
): Promise<RenameAgentResult> {
  const target = room.getSnapshot().agents.find(agent => agent.participantId === participantId);
  if (viewer.kind !== 'human' || target?.ownerId !== viewer.ownerId) return { kind: 'error', code: 'not_owner' };
  const detail = context.describeParticipant?.(participantId);
  if (!context.agentNames || detail?.kind !== 'agent') return { kind: 'error', code: 'unavailable' };
  return context.agentNames.rename(detail.matrixUserId, name);
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
  const viewer = context.participant?.() ?? null;
  const timelineData = useSyncExternalStore(timeline.subscribe, timeline.getSnapshot, timeline.getSnapshot);
  const presence = useSyncExternalStore(room.subscribe, room.getSnapshot, room.getSnapshot);
  const extraParticipants = presence.agents.flatMap(agent => agent.ownerId ? [{
    participantId: agent.participantId, ownerId: agent.ownerId, kind: 'agent' as const,
    initialName: agent.displayName,
  }] : []);
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
  const projectedNames = viewer ? projectTimelineNames(timelineData.nameHistory ?? timelineData.items, viewer, extraParticipants).currentNames : undefined;
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
    return <Panel heading="Conversation unavailable"><p role="alert">You no longer have access to this encrypted conversation.</p></Panel>;
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
  return (
    <ChannelScreen
      title={selectedConversation?.title ?? 'Encrypted conversation'}
      controller={room}
      viewerOwnerId={viewer.ownerId}
      viewerName={viewer.displayName}
      viewerEmail={context.principal.verifiedEmail}
      viewerParticipantId={viewer.participantId}
      {...(participantRoster?.scope === participantScope ? { humanParticipants: participantRoster.participants
        .filter(participant => participant.kind === 'human' && participant.participantId !== viewer.participantId) } : {})}
      {...(currentNames ? { currentNames } : {})}
      {...(describeParticipant ? { describeParticipant } : {})}
      modeFor={modeFor}
      {...(context.setListeningMode ? { onSetMode: guardedListeningModeSetter({ roomId, viewer, matrixUserId,
        ownerOf: participantId => room.getSnapshot().agents.find(agent => agent.participantId === participantId)?.ownerId,
        joined: () => timeline.getSnapshot().membership === 'joined', send: context.setListeningMode }) } : {})}
      {...(context.agentNames ? { renameAgent: async (participantId: ParticipantId, name: string) => {
        const result = await renameChannelAgent(context, room, viewer, participantId, name);
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
          controller={timeline} roomPort={context.room} roomId={roomId} viewer={viewer} composerRef={composer}
          extraParticipants={extraParticipants} onOpenParticipant={openParticipant} onMentionRoster={onMentionRoster}
          {...(participantRoster?.scope === participantScope ? { members: participantRoster.participants } : {})}
          {...(openInvite ? { onInvite: openInvite } : {})}
          {...(describeParticipant ? { describeParticipant } : {})}
          {...(pendingStore ? { pendingStore } : {})}
          unreadableActivity={selectedConversation?.preview === null && selectedConversation.timestamp !== null} />
      )}
    />
  );
}
