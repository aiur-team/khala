import { createRoot } from 'react-dom/client';
import type { ParticipantId, RoomId } from '@khala/contracts/messaging/ids';
import '../../../brand/fonts.css';
import '../../../brand/tokens.css';
import '../../../shell/shell.css';
import '../room.css';
import { createRoomController } from '../controller';
import type { AgentPresenceSnapshot, RoomUiPort } from '../ports';
import { RoomScreen } from '../RoomScreen';

const roomId = 'room_harness' as RoomId;
const scoutId = 'agent_scout' as ParticipantId;
let listeners: Array<(snapshot: AgentPresenceSnapshot) => void> = [];
let snapshot: AgentPresenceSnapshot = {
  generation: 1,
  agents: [{
    participantId: scoutId,
    displayName: 'Scout',
    ownerDisplayName: 'Mira',
    connection: 'offline',
    routeLabel: 'Khala skill',
    lastReceipt: null,
  }],
};

const port: RoomUiPort = {
  agents: async () => snapshot,
  subscribeAgents: (_roomId, listener) => {
    listeners = [...listeners, listener];
    return () => { listeners = listeners.filter(candidate => candidate !== listener); };
  },
  installCommand: async () => 'khala connect https://khala.example/rooms/release-room',
};

const controller = createRoomController(port, { roomId, generation: 1 });

function connectScout(): void {
  snapshot = {
    generation: 1,
    agents: [{
      participantId: scoutId,
      displayName: 'Scout',
      ownerDisplayName: 'Mira',
      connection: 'connected',
      routeLabel: 'Codex CLI',
      lastReceipt: { kind: 'context_consumed', observedAt: '2026-09-18T14:31:19.880Z' },
    }],
  };
  for (const listener of listeners) listener(snapshot);
}

function Harness() {
  return (
    <RoomScreen
      title="Release room"
      description="Coordinate the launch with people and their agents."
      controller={controller}
      renderTimeline={() => (
        <section aria-label="Live timeline">
          <h2>Conversation</h2>
          <p><strong>Mira</strong> Human</p>
          <p>Can you check the deployment?</p>
          <label>Message <textarea defaultValue="" /></label>
          <button type="button">Send message</button>
        </section>
      )}
      renderReview={() => (
        <section aria-label="Pending release">
          <h2>Pending release</h2>
          <p>No pending messages.</p>
        </section>
      )}
      renderControls={() => (
        <section aria-label="Agent controls">
          <h2>Agent controls</h2>
          <button type="button" onClick={connectScout}>Simulate agent connection</button>
        </section>
      )}
    />
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
