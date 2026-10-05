import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { OwnerId, ParticipantId, RoomId } from '@khala/contracts/messaging/ids';
import '../../../brand/fonts.css';
import '../../../brand/tokens.css';
import '../../../shell/shell.css';
import '../channel.css';
import type { ThemeChoice } from '../../../shell/types';
import { KhalaApp } from '../../../ui/khala/KhalaApp';
import { createChannelController } from '../controller';
import type { AgentPresenceSnapshot, ChannelUiPort } from '../ports';
import { ChannelScreen } from '../ChannelScreen';
import { ChannelNameDialog, TAKEN_HERE } from '../ChannelNameDialog';
import { channelNamePrompts, type ChannelNameMember } from '../channel-names';

// Synthetic content only: two people who both chose the username "alice" meet in one channel.
// `?as=first` views as the alice who was here first, who is never asked; `?gap` adds an alice2.
const params = new URLSearchParams(location.search);
const first = { participantId: 'p_first' as ParticipantId, ownerId: 'owner_first' as OwnerId };
const later = { participantId: 'p_later' as ParticipantId, ownerId: 'owner_later' as OwnerId };
const viewer = params.get('as') === 'first' ? first : later;
const other = viewer === first ? later : first;
const snapshot: AgentPresenceSnapshot = { generation: 1, agents: [{ participantId: 'agent_scout' as ParticipantId, ownerId: first.ownerId,
  displayName: 'alice-Claude', ownerDisplayName: 'alice', connection: 'unknown', routeLabel: 'Channel agent', lastReceipt: null,
  acknowledgement: 'unknown' }] };
const port: ChannelUiPort = { agents: async () => snapshot, subscribeAgents: () => () => undefined,
  installCommand: async () => { throw new Error('unused'); } };
const controller = createChannelController(port, { roomId: 'room_names' as RoomId, generation: 1 });
declare global { interface Window { __saved: string[] } }
window.__saved = [];

function Harness() {
  const [theme, setTheme] = useState<ThemeChoice>(params.get('theme') === 'light' ? 'light' : 'dark');
  const [names, setNames] = useState<Readonly<Record<string, string>>>({ [first.participantId]: 'alice', [later.participantId]: 'alice' });
  const [pills, setPills] = useState<readonly string[]>([]);
  const members: ChannelNameMember[] = [
    { participantId: first.participantId, kind: 'human', name: names[first.participantId]!, ownerId: first.ownerId, since: 10 },
    { participantId: later.participantId, kind: 'human', name: names[later.participantId]!, ownerId: later.ownerId, since: 20 },
    ...(params.has('gap') ? [{ participantId: 'p_gap', kind: 'human' as const, name: 'alice2', ownerId: 'owner_gap', since: 5 }] : []),
    { participantId: 'agent_scout', kind: 'agent', name: 'alice-Claude', ownerId: first.ownerId, since: 11 },
  ];
  const prompt = channelNamePrompts({ members, viewerParticipantId: viewer.participantId, viewerOwnerId: viewer.ownerId })[0];
  const humans = members.filter(member => member.kind === 'human' && member.participantId !== viewer.participantId)
    .map(member => ({ participantId: member.participantId as ParticipantId, ownerId: (member.ownerId ?? '') as OwnerId, displayName: member.name }));
  return <KhalaApp theme={theme} onThemeChange={setTheme} inThread
    list={<p className="kh-cv-empty">Launch plans</p>}
    main={<>
      <ChannelScreen title="Launch plans" controller={controller} viewerOwnerId={viewer.ownerId} viewerParticipantId={viewer.participantId}
        viewerName={names[viewer.participantId]!} viewerEmail="alice@example.com" humanParticipants={humans}
        renderTimeline={() => <section className="harness-thread" aria-label="Thread" style={{ padding: '1rem' }}>
          <p>{names[other.participantId]}: Shall we ship on Friday?</p>
          {pills.map(pill => <p key={pill} className="harness-pill" role="status">{pill}</p>)}
        </section>} />
      {prompt ? <ChannelNameDialog key={prompt.participantId + prompt.name} prompt={prompt} onSave={async name => {
        await new Promise(resolve => setTimeout(resolve, 50));
        // Like the homeserver: the name is set for this member in this channel only, announced as a rename.
        if (members.some(member => member.participantId !== viewer.participantId && member.name.toLowerCase() === name.toLowerCase())) {
          return { kind: 'error', message: TAKEN_HERE };
        }
        window.__saved.push(name);
        setPills(current => [...current, `${names[viewer.participantId]} is now ${name}`]);
        setNames(current => ({ ...current, [viewer.participantId]: name }));
        return { kind: 'ok' };
      }} /> : null}
    </>} />;
}

createRoot(document.getElementById('root')!).render(<Harness />);
