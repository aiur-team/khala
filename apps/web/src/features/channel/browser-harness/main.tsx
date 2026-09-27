import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ParticipantId, RoomId } from '@khala/contracts/messaging/ids';
import '../../../brand/fonts.css';
import '../../../brand/tokens.css';
import '../../../shell/shell.css';
import '../channel.css';
import { createChannelController } from '../controller';
import type { AgentPresenceSnapshot, ChannelUiPort } from '../ports';
import { ChannelScreen } from '../ChannelScreen';

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
    acknowledgement: 'unknown',
  }],
};

const port: ChannelUiPort = {
  agents: async () => snapshot,
  subscribeAgents: (_roomId, listener) => {
    listeners = [...listeners, listener];
    return () => { listeners = listeners.filter(candidate => candidate !== listener); };
  },
  installCommand: async () => 'khala connect https://khala.example/channels/release-channel',
};

const controller = createChannelController(port, { roomId, generation: 1 });

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
      acknowledgement: 'batch_token_next_call',
    }],
  };
  for (const listener of listeners) listener(snapshot);
  setTimeout(() => {
    snapshot = {
      ...snapshot,
      agents: snapshot.agents.map(agent => ({ ...agent, connection: 'stale' as const })),
    };
    for (const listener of listeners) listener(snapshot);
  }, 1_000);
}

function Harness() {
  const [draft, setDraft] = useState('');
  const [messages, setMessages] = useState<readonly Readonly<{ body: string; pending: boolean }>[]>([
    { body: 'Can you check the deployment?', pending: false },
  ]);

  function sendMessage(): void {
    const body = draft.trim();
    if (!body) return;
    setMessages(current => [...current, { body, pending: true }]);
    setDraft('');
    setTimeout(() => setMessages(current => [
      ...current.map(message => message.body === body ? { ...message, pending: false } : message),
      { body: 'Deployment is healthy.', pending: false },
    ]), 50);
  }

  return (
    <ChannelScreen
      title="Release channel"
      description="Coordinate the launch with people and their agents."
      controller={controller}
      renderTimeline={() => (
        <section aria-label="Live timeline">
          <h2>Conversation</h2>
          <p><strong>Mira</strong> Human</p>
          {messages.map((message, index) => (
            <p key={`${index}-${message.body}`}>{message.body} {message.pending ? <span>Sending…</span> : null}</p>
          ))}
          <label>Message <textarea value={draft} onChange={event => setDraft(event.currentTarget.value)} /></label>
          <button type="button" onClick={sendMessage}>Send message</button>
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
