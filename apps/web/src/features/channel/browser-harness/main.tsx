import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Participant } from '@khala/contracts/m1/participants';
import type { OwnerId, ParticipantId, RoomId } from '@khala/contracts/messaging/ids';
import '../../../brand/fonts.css';
import '../../../brand/tokens.css';
import '../../../shell/shell.css';
import '../channel.css';
import type { ThemeChoice } from '../../../shell/types';
import { insertMention } from '../../../ui/conversation';
import { KhalaApp } from '../../../ui/khala/KhalaApp';
import { createChannelController } from '../controller';
import type { AgentPresence, AgentPresenceSnapshot, ChannelUiPort } from '../ports';
import { ChannelScreen } from '../ChannelScreen';
import { ChannelAddAgent, ChannelInvite } from '../ChannelSharePanel';

// Synthetic content only: no real channel, credential or person.
const roomId = 'room_harness' as RoomId;
const mira = 'owner_mira' as OwnerId;
const theo = 'owner_theo' as OwnerId;
const params = new URLSearchParams(location.search);
const agentOf = (participantId: string, ownerId: OwnerId | undefined, displayName: string): AgentPresence => ({
  participantId: participantId as ParticipantId, ...(ownerId ? { ownerId } : {}), displayName, ownerDisplayName: '',
  connection: 'unknown', routeLabel: 'Channel agent', lastReceipt: null, acknowledgement: 'unknown',
});
const base = [agentOf('agent_scout', mira, 'Scout'), agentOf('agent_builder', theo, 'Builder')];
const crowd = [...base, agentOf('agent_scout_2', mira, 'Scout'), agentOf('agent_atlas', theo, 'Atlas'),
  agentOf('agent_orbit', 'owner_zed' as OwnerId, 'Orbit')];
const harnesses: Record<string, 'claude' | 'codex'> = { agent_scout: 'claude', agent_scout_2: 'claude', agent_builder: 'codex', agent_atlas: 'codex', agent_orbit: 'claude' };
const ownerLabels: Record<string, string> = { [mira]: 'Mira', [theo]: 'Theo', owner_zed: 'Zed' };

let listeners: Array<(snapshot: AgentPresenceSnapshot) => void> = [];
let snapshot: AgentPresenceSnapshot = { generation: 1, agents: params.has('crowd') ? crowd : base };
function publish(agents: readonly AgentPresence[]): void {
  snapshot = { generation: 1, agents };
  for (const listener of listeners) listener(snapshot);
}
const port: ChannelUiPort = {
  agents: async () => snapshot,
  subscribeAgents: (_roomId, listener) => {
    listeners = [...listeners, listener];
    return () => { listeners = listeners.filter(candidate => candidate !== listener); };
  },
  installCommand: async () => { throw new Error('unused'); },
};
const controller = createChannelController(port, { roomId, generation: 1 });
const describeParticipant = (participantId: string): Participant | undefined => {
  if (participantId === 'p_theo') return { kind: 'human', matrixUserId: '@theo:khala.example', participantId, ownerId: theo,
    displayName: 'Theo Park', email: 'theo.park@example.com' };
  const agent = snapshot.agents.find(item => item.participantId === participantId);
  if (!agent || !harnesses[participantId]) return undefined;
  return { kind: 'agent', matrixUserId: `@${participantId}:khala.example`, participantId, ownerId: agent.ownerId ?? '',
    displayName: agent.displayName, ownerLabel: ownerLabels[agent.ownerId ?? ''] ?? 'Owner', harness: harnesses[participantId]! };
};
const admission = { share: async () => ({ kind: 'ok' as const, value: { inviteRef: 'visual', shareUrl: 'https://khala.example/c/release', expiresAt: null } }) };
declare global { interface Window { __copied: string[] } }
window.__copied = [];
const onCopy = async (url: string) => {
  if (params.has('copyfail')) return { ok: false as const, reason: 'denied' as const };
  window.__copied.push(url);
  return { ok: true as const };
};

function Harness() {
  const [theme, setTheme] = useState<ThemeChoice>(params.get('theme') === 'light' ? 'light' : 'dark');
  const [names, setNames] = useState<ReadonlyMap<ParticipantId, string>>(new Map());
  const [draft, setDraft] = useState('');
  const [chipsClosed, setChipsClosed] = useState(0);
  const [humans, setHumans] = useState(params.has('crowd')
    ? [{ participantId: 'p_theo' as ParticipantId, ownerId: theo, displayName: 'Theo Park' },
      { participantId: 'p_kai' as ParticipantId, ownerId: 'owner_kai' as OwnerId, displayName: 'Kai' }]
    : [{ participantId: 'p_theo' as ParticipantId, ownerId: theo, displayName: 'Theo Park' }]);
  return <KhalaApp theme={theme} onThemeChange={setTheme} inThread
    list={<p className="kh-cv-empty">Release channel</p>}
    main={<ChannelScreen title="Release channel" controller={controller}
      viewerOwnerId={mira} viewerName="Mira" viewerEmail="mira@example.com" viewerParticipantId={'p_mira' as ParticipantId}
      humanParticipants={humans} currentNames={names} describeParticipant={describeParticipant}
      renameScope={roomId}
      renameAgent={async (participantId, name) => {
        if (participantId !== 'agent_scout') return 'rejected';
        setNames(new Map([[participantId, name]]));
        return 'accepted';
      }}
      recentActivity={participantId => participantId === 'agent_scout'
        ? [{ id: 'e2', at: '2026-10-01T16:52:00Z', body: 'The release build is green.' }, { id: 'e1', at: '2026-10-01T16:40:00Z', body: 'Starting the build.' }]
        : []}
      agentJoinedAt={participantId => participantId === 'agent_scout' ? '2026-10-01T16:30:00Z' : undefined}
      onMention={label => setDraft(current => insertMention(current, label))}
      onRosterOpen={() => setChipsClosed(count => count + 1)}
      onBack={() => { document.title = 'back'; }}
      renderShare={() => <ChannelInvite admission={admission} roomId={roomId} onCopy={onCopy} />}
      renderAddAgent={() => <ChannelAddAgent admission={admission} roomId={roomId} onCopy={onCopy} />}
      renderTimeline={openParticipant => <section className="harness-thread" aria-label="Thread"
        style={{ display: 'flex', flexWrap: 'wrap', alignContent: 'flex-start', gap: '.5rem', padding: '1rem' }}>
        <p><button type="button" onClick={() => openParticipant('agent_scout')}>@Scout</button> The release build is green.</p>
        <p id="chips-closed">{chipsClosed}</p>
        <label>Message <textarea value={draft} onChange={event => setDraft(event.currentTarget.value)} /></label>
        <button type="button" onClick={() => publish(crowd)}>Show crowd</button>
        <button type="button" onClick={() => publish(base.filter(agent => agent.participantId !== 'agent_builder'))}>Builder leaves</button>
        <button type="button" onClick={() => setHumans(current => [...current,
          { participantId: 'p_kai' as ParticipantId, ownerId: 'owner_kai' as OwnerId, displayName: 'Kai' }])}>Kai joins</button>
      </section>} />} />;
}

createRoot(document.getElementById('root')!).render(<Harness />);
