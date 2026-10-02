import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { OwnerId, ParticipantId } from '@khala/contracts/messaging/ids';
import { ChannelRoster, RenameAgent } from './AgentPresencePanel';
import type { ChannelAgentView } from './controller';
import { resolveMembers } from './members';

const mira = 'owner_mira' as OwnerId;
const scout: ChannelAgentView = {
  participantId: 'agent_scout' as ParticipantId, ownerId: mira, displayName: 'Scout', ownerDisplayName: 'Mira',
  connection: 'unknown', routeLabel: 'Channel agent', acknowledgement: 'unknown', lastReceipt: null,
  installCommand: null, installCommandError: false,
};
const members = (agents: readonly ChannelAgentView[]) => resolveMembers({ viewer: { participantId: 'p_mira', ownerId: mira, name: 'Mira' },
  humans: [], agents });

describe('ChannelRoster', () => {
  it('badges names that collide across owners with the thread owner suffix', () => {
    const theosScout = { ...scout, participantId: 'agent_other' as ParticipantId, ownerId: 'owner_theo' as OwnerId };
    const html = renderToStaticMarkup(<ChannelRoster phase="ready" onOpen={() => {}} members={members([scout, theosScout])} />);
    expect(html).toContain('Scout<span class="kh-id" style="--h:');
    expect(html).toContain('>#mira</span>');
    expect(html).toContain('>#theo</span>');
    expect(html).toContain('aria-label="Listening mode for Scout #mira"');
  });

  it('does not badge same-named agents of one owner, as the thread does not', () => {
    const html = renderToStaticMarkup(<ChannelRoster phase="ready" onOpen={() => {}}
      members={members([scout, { ...scout, participantId: 'agent_other' as ParticipantId }])} />);
    expect(html).not.toContain('kh-id');
  });

  it('counts the agents on each human row', () => {
    const one = renderToStaticMarkup(<ChannelRoster phase="ready" onOpen={() => {}} members={members([scout])} />);
    expect(one).toContain('</span><i>1 agent</i></button>');
    const two = renderToStaticMarkup(<ChannelRoster phase="ready" onOpen={() => {}}
      members={members([scout, { ...scout, participantId: 'agent_other' as ParticipantId }])} />);
    expect(two).toContain('<i>2 agents</i>');
    expect(renderToStaticMarkup(<ChannelRoster phase="ready" onOpen={() => {}} members={members([])} />)).not.toContain('<i>');
  });

  it('announces loading and failed presence reads distinctly', () => {
    expect(renderToStaticMarkup(<ChannelRoster phase="loading" onOpen={() => {}} members={members([])} />)).toContain('Checking participants…');
    expect(renderToStaticMarkup(<ChannelRoster phase="unavailable" onOpen={() => {}} members={members([])} />))
      .toContain('Agent presence is unavailable right now.');
  });

  it('shows no connection diagnostics', () => {
    const html = renderToStaticMarkup(<ChannelRoster phase="ready" onOpen={() => {}} members={members([{ ...scout, connection: 'offline' }])} />);
    for (const diagnostic of ['Connected', 'Unavailable', 'Channel agent', 'install']) expect(html).not.toContain(diagnostic);
  });
});

describe('RenameAgent', () => {
  it('renders the restyled rename field prefilled with the current name', () => {
    const html = renderToStaticMarkup(<RenameAgent participantId={scout.participantId} name="Scout" storageKey="k"
      renameAgent={async () => 'accepted'} />);
    expect(html).toContain('class="kh-txt" aria-label="Name for Scout" maxLength="80" value="Scout"');
    expect(html).toContain('class="kh-btn pri"');
    expect(html).toContain('>Rename</button>');
  });
});
