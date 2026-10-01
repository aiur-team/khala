import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { OwnerId, ParticipantId, RoomId } from '@khala/contracts/messaging/ids';
import '../../../brand/fonts.css';
import '../../../brand/tokens.css';
import '../../../shell/shell.css';
import '../channel.css';
import { createChannelController } from '../controller';
import type { AgentPresenceSnapshot, ChannelUiPort } from '../ports';
import { ChannelScreen } from '../ChannelScreen';
import { ChannelSharePanel } from '../ChannelSharePanel';

const roomId = 'room_harness' as RoomId;
const scoutId = 'agent_scout' as ParticipantId;
const builderId = 'agent_builder' as ParticipantId;
const miraId = 'owner_mira' as OwnerId;
const theoId = 'owner_theo' as OwnerId;
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

function Harness() {
  const [viewer, setViewer] = useState<OwnerId>(miraId);
  const [names, setNames] = useState<ReadonlyMap<ParticipantId, string>>(new Map());
  const [renamed, setRenamed] = useState(false);
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
    <div className="khala-content-root khala-owner-shell" data-theme="dark">
      <main className="khala-content-main"><div className="khala-content-actions"><div id="khala-channel-toolbar" /></div>
    <ChannelScreen embedded={!new URLSearchParams(location.search).has('standalone')}
      title="Release channel"
      description="Coordinate the launch with people and their agents."
      controller={controller}
      viewerOwnerId={viewer}
      viewerName={viewer === miraId ? 'Mira' : 'Theo'}
      renameScope={roomId}
      currentNames={names}
      renameAgent={async (participantId, name) => {
        if (viewer !== miraId || participantId !== scoutId) return 'rejected';
        setNames(new Map([[scoutId, name]]));
        setRenamed(true);
        return 'accepted';
      }}
      renderTimeline={() => (
        <section aria-label="Live timeline">
          <h2>Conversation</h2>
          <p><strong>Mira</strong> Human</p>
          {messages.map((message, index) => (
            <p key={`${index}-${message.body}`}>{message.body} {message.pending ? <span>Sending…</span> : null}</p>
          ))}
          {renamed ? <p>Scout is now called {names.get(scoutId)} · changed by Mira</p> : null}
          <label>Message <textarea value={draft} onChange={event => setDraft(event.currentTarget.value)} /></label>
          <button type="button" onClick={sendMessage}>Send message</button>
        </section>
      )}
      renderHeaderActions={() => (
        <section aria-label="Agent controls">
          <h2>Agent controls</h2>
          <button type="button" onClick={() => {
            snapshot = { generation: 1, agents: [
              { participantId: scoutId, ownerId: miraId, displayName: 'Scout', ownerDisplayName: 'Mira',
                connection: 'connected', routeLabel: 'Codex CLI', lastReceipt: null, acknowledgement: 'unknown' },
              { participantId: builderId, ownerId: theoId, displayName: 'Builder', ownerDisplayName: 'Theo',
                connection: 'connected', routeLabel: 'Codex CLI', lastReceipt: null, acknowledgement: 'unknown' },
            ] };
            for (const listener of listeners) listener(snapshot);
          }}>Show two agents</button>
          <button type="button" onClick={() => setViewer(viewer === miraId ? theoId : miraId)}>Switch human</button>
        </section>
      )}
      renderShare={() => <ChannelSharePanel roomId={roomId} admission={{ share: async () => ({
        kind: 'ok', value: { inviteRef: 'visual', shareUrl: 'https://khala.example/join/visual', expiresAt: null },
      }) }} onCopy={async () => ({ ok: true })} />}
    />
      </main>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
