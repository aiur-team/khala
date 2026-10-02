import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ListeningMode } from '@khala/contracts/m1/listening-mode';
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
// Renames stick, like an agent's Matrix display name.
const renamed = new Map<string, string>();
function publish(agents: readonly AgentPresence[]): void {
  snapshot = { generation: 1, agents: agents.map(agent => ({ ...agent, displayName: renamed.get(agent.participantId) ?? agent.displayName })) };
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
  const [draft, setDraft] = useState('');
  const [chipsClosed, setChipsClosed] = useState(0);
  // Agents confirm a mode change 300 ms later; `?offline` agents never do.
  const [modes, setModes] = useState<Readonly<Record<string, ListeningMode>>>({ agent_builder: 'async' });
  const [humans, setHumans] = useState(params.has('crowd')
    ? [{ participantId: 'p_theo' as ParticipantId, ownerId: theo, displayName: 'Theo Park' },
      { participantId: 'p_kai' as ParticipantId, ownerId: 'owner_kai' as OwnerId, displayName: 'Kai' }]
    : [{ participantId: 'p_theo' as ParticipantId, ownerId: theo, displayName: 'Theo Park' }]);
  return <KhalaApp theme={theme} onThemeChange={setTheme} inThread
    list={<p className="kh-cv-empty">Release channel</p>}
    main={<ChannelScreen title="Release channel" controller={controller}
      viewerOwnerId={mira} viewerName="Mira" viewerEmail="mira@example.com" viewerParticipantId={'p_mira' as ParticipantId}
      humanParticipants={humans} describeParticipant={describeParticipant}
      modeFor={participantId => modes[participantId] ?? 'sync'}
      onSetMode={async (participantId, mode) => {
        if (!params.has('offline')) setTimeout(() => setModes(current => ({ ...current, [participantId]: mode })), 300);
        return 'sent';
      }}
      renameAgent={async (participantId, name) => {
        // Like the rename API: the agent's display name changes everywhere; names are unique.
        if (!snapshot.agents.some(agent => agent.participantId === participantId && agent.ownerId === mira)) return { kind: 'error', code: 'not_owner' };
        if (snapshot.agents.some(agent => agent.displayName.toLowerCase() === name.toLowerCase())) return { kind: 'error', code: 'name_taken' };
        renamed.set(participantId, name);
        publish(snapshot.agents);
        return { kind: 'ok', name };
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
