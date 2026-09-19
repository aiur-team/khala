import { useEffect, useMemo } from 'react';
import { createRoomController } from '../../features/room/controller';
import type { RoomUiPort } from '../../features/room/ports';
import { RoomScreen } from '../../features/room/RoomScreen';
import { createTimelineController } from '../../features/timeline/controller';
import { TimelineScreen } from '../../features/timeline/TimelineScreen';
import { Panel } from '../../shell/Panel';
import type { HumanRoomRenderer } from './mount';

const unavailablePresence: RoomUiPort = {
  async agents() { throw new Error('agent presence unavailable'); },
  subscribeAgents: () => () => undefined,
  async installCommand() { throw new Error('agent onboarding unavailable'); },
};

export const renderHumanRoom: HumanRoomRenderer = (context, route) => (
  <HumanRoom context={context} roomId={route.roomId} />
);

function HumanRoom({ context, roomId }: {
  context: Parameters<HumanRoomRenderer>[0];
  roomId: Parameters<HumanRoomRenderer>[1]['roomId'];
}) {
  const timeline = useMemo(
    () => createTimelineController(context.room, roomId, { generation: context.generation, pageSize: 50 }),
    [context.generation, context.room, roomId],
  );
  const room = useMemo(
    () => createRoomController(unavailablePresence, { roomId, generation: context.generation }),
    [context.generation, roomId],
  );
  useEffect(() => () => {
    timeline.dispose();
    room.dispose();
  }, [room, timeline]);
  const viewer = context.participant?.() ?? null;
  if (viewer === null) {
    return (
      <Panel heading="Conversation unavailable">
        <p role="alert">Participant attribution is unavailable for this session.</p>
      </Panel>
    );
  }

  return (
    <RoomScreen
      title="Khala conversation"
      description="Encrypted messages shared by admitted participants."
      controller={room}
      renderTimeline={() => (
        <TimelineScreen controller={timeline} roomPort={context.room} roomId={roomId} viewer={viewer} />
      )}
      renderReview={() => (
        <Panel heading="Recipient review">
          <p role="status">Connector review is not available for this room yet.</p>
        </Panel>
      )}
      renderControls={() => (
        <Panel heading="Agent controls">
          <p role="status">Agent controls are not available for this room yet.</p>
        </Panel>
      )}
    />
  );
}
