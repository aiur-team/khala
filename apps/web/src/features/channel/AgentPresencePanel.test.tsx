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
  it('tells same-named agents apart with an ordinal badge', () => {
    const html = renderToStaticMarkup(<ChannelRoster phase="ready" onOpen={() => {}}
      members={members([scout, { ...scout, participantId: 'agent_other' as ParticipantId }])} />);
    expect(html).toContain('Scout<span class="kh-id" style="--h:');
    expect(html).toContain('>#1</span>');
    expect(html).toContain('>#2</span>');
    expect(html).toContain('aria-label="Listening mode for Scout #2"');
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
