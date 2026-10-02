import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { createChannelController } from '../../features/channel/controller';
import type { ChannelUiPort } from '../../features/channel/ports';
import { ChannelScreen } from '../../features/channel/ChannelScreen';
import { createTimelineController } from '../../features/timeline/controller';
import { TimelineScreen } from '../../features/timeline/TimelineScreen';
import { projectTimelineNames } from '../../features/timeline/names';
import type { ParticipantView } from '@khala/contracts/messaging/index';
import { Panel } from '../../shell/Panel';
import type { HumanRoomRenderer } from './mount';
import { ChannelSharePanel } from '../../features/channel/ChannelSharePanel';
import { useConversationIndex } from './ConversationIndexRoute';
import type { HumanRouteCodec } from './routes';
import { createHumanPendingSendStore } from './pending-send-store';

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
  const currentNames = viewer ? projectTimelineNames(timelineData.nameHistory ?? timelineData.items, viewer, extraParticipants).currentNames : undefined;
  if (context.conversations && conversations === undefined) {
    return <Panel heading="Loading conversation"><p role="status">Checking channel access…</p></Panel>;
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

  return (
    <ChannelScreen
      embedded={Boolean(context.conversations && routes && navigate)}
      title={selectedConversation?.title ?? 'Encrypted conversation'}
      controller={room}
      viewerOwnerId={viewer.ownerId}
      viewerName={viewer.displayName}
      {...(participantRoster?.scope === participantScope ? { humanParticipants: participantRoster.participants
        .filter(participant => participant.kind === 'human' && participant.participantId !== viewer.participantId) } : {})}
      namesPending={timelineData.namesReady === false}
      {...(currentNames ? { currentNames } : {})}
      renderShare={() => context.admission ? <ChannelSharePanel key={`${context.principal.ownerId}:${context.generation}:${roomId}`}
        admission={context.admission} roomId={roomId}
        {...(context.channelLinks ? { channelLinks: context.channelLinks } : {})} /> : null}
      renderTimeline={() => (
        <TimelineScreen key={JSON.stringify([context.principal.ownerId, deviceId, context.generation, roomId])}
          controller={timeline} roomPort={context.room} roomId={roomId} viewer={viewer}
          extraParticipants={extraParticipants}
          {...(pendingStore ? { pendingStore } : {})}
          unreadableActivity={selectedConversation?.preview === null && selectedConversation.timestamp !== null} />
      )}
    />
  );
}
