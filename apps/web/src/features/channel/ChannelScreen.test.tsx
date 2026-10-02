import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Participant } from '@khala/contracts/m1/participants';
import type { OwnerId, ParticipantId } from '@khala/contracts/messaging/ids';
import { KhalaApp } from '../../ui/khala/KhalaApp';
import { ChannelScreen, type ChannelScreenProps } from './ChannelScreen';
import type { ChannelAgentView, ChannelController, ChannelView } from './controller';

const mira = 'owner_mira' as OwnerId;
const theo = 'owner_theo' as OwnerId;

function agent(participantId: string, ownerId: OwnerId | undefined, displayName = 'Scout'): ChannelAgentView {
  return { participantId: participantId as ParticipantId, ...(ownerId ? { ownerId } : {}), displayName, ownerDisplayName: 'Mira',
    connection: 'unknown', routeLabel: 'Channel agent', acknowledgement: 'unknown', lastReceipt: null,
    installCommand: null, installCommandError: false };
}

function controller(view: ChannelView): ChannelController {
  return { getSnapshot: () => view, subscribe: () => () => {}, dispose: () => {} };
}

const theoHuman = { participantId: 'p_theo' as ParticipantId, ownerId: theo, displayName: 'Theo Park' };

function render(view: ChannelView, props: Partial<ChannelScreenProps> = {}): string {
  return renderToStaticMarkup(<KhalaApp theme="dark" main={<ChannelScreen title="Release channel" controller={controller(view)}
    viewerOwnerId={mira} viewerName="Mira" viewerParticipantId={'p_mira' as ParticipantId}
    humanParticipants={[theoHuman]} renderTimeline={() => <div data-slot="timeline">Timeline slot</div>} {...props} />} />);
}

describe('ChannelScreen header', () => {
  it('stacks four other members then +N', () => {
    const agents = Array.from({ length: 5 }, (_, index) => agent(`agent_${index}`, mira, `Agent ${index}`));
    const html = render({ phase: 'ready', agents });
    const stack = html.slice(html.indexOf('class="kh-stack"'), html.indexOf('id="kh-head-btn"'));
    expect(stack.match(/<button type="button" class="kh-av/g)).toHaveLength(4);
    expect(stack).toContain('<span class="kh-av kh-more">+2</span>');
  });

  it('names the humans and counts members in the subtitle', () => {
    const html = render({ phase: 'ready', agents: [agent('agent_1', mira)] });
    expect(html).toContain('You, Theo · <span class="on">2 humans · 1 agent</span>');
    expect(html).toContain('<h1 class="sr-only" id="khala-channel-title" dir="auto">Release channel</h1>');
    expect(html).toContain('aria-expanded="false" aria-controls="kh-roster"');
    expect(html).not.toContain('roster-open');
  });

  it('reports loading and unavailable presence instead of counts', () => {
    expect(render({ phase: 'loading', agents: [] })).toContain('<span class="on">Checking participants…</span>');
    expect(render({ phase: 'unavailable', agents: [] })).toContain('<span class="on">Participants unavailable</span>');
  });

  it('shows Invite only with a share body and never a settings gear', () => {
    expect(render({ phase: 'ready', agents: [] })).not.toContain('aria-label="Invite"');
    const html = render({ phase: 'ready', agents: [] }, { renderShare: () => 'share' });
    expect(html).toContain('data-tip="Invite" aria-label="Invite" aria-expanded="false"');
    expect(html).not.toMatch(/Settings|Channel settings/);
  });

  it('hands the thread an Invite opener only when Invite is shown', () => {
    const openers: unknown[] = [];
    const renderTimeline = (_open: unknown, openInvite: unknown) => { openers.push(openInvite); return null; };
    render({ phase: 'ready', agents: [] }, { renderTimeline });
    render({ phase: 'ready', agents: [] }, { renderTimeline, renderShare: () => 'share' });
    expect(openers.map(opener => typeof opener)).toEqual(['undefined', 'function']);
  });

  it('offers back only when the route can navigate', () => {
    expect(render({ phase: 'ready', agents: [] })).not.toContain('kh-back');
    expect(render({ phase: 'ready', agents: [] }, { onBack: () => {} })).toContain('class="kh-back" aria-label="All conversations"');
  });

  it('keeps Matrix routing IDs and proof-key labels out of names', () => {
    const html = render({ phase: 'ready', agents: [agent('agent_1', mira, '@khala_a:matrix.example.test'), agent('agent_2', mira, 'proof-key:abc')] },
      { viewerName: '@mira:matrix.example.test' });
    expect(html).not.toContain('matrix.example.test');
    expect(html).not.toContain('proof-key');
  });
});

describe('ChannelScreen roster', () => {
  const describe_ = (participantId: string): Participant | undefined => participantId === 'agent_own'
    ? { kind: 'agent', matrixUserId: '@a:x', participantId, ownerId: mira, displayName: 'Claude', ownerLabel: 'Mira', harness: 'claude' }
    : participantId === 'agent_theo'
      ? { kind: 'agent', matrixUserId: '@b:x', participantId, ownerId: theo, displayName: 'Codex', ownerLabel: 'Theo', harness: 'codex' }
      : undefined;
  const html = render({ phase: 'ready', agents: [agent('agent_own', mira, 'Claude'), agent('agent_theo', theo, 'Codex'),
    agent('agent_zed', 'owner_zed' as OwnerId, 'Helper')] }, { describeParticipant: describe_, renderAddAgent: () => 'add' });
  const roster = html.slice(html.indexOf('id="kh-roster"'), html.indexOf('class="kh-channel-thread"'));
  const row = (id: string) => roster.slice(roster.indexOf(`data-kh-agent="${id}"`), roster.indexOf('</div>', roster.indexOf(`data-kh-agent="${id}"`)));

  it('is inert and closed until opened', () => {
    expect(html).toContain('class="kh-roster" id="kh-roster" inert=""');
  });

  it('groups the viewer first, then other humans, then owners not in the channel', () => {
    expect(roster.indexOf('<b>You</b>')).toBeLessThan(roster.indexOf('<b>Theo Park</b>'));
    expect(roster).toContain('<b>Theo Park</b><em>Owner of 1 agent</em>');
    expect(roster.indexOf('<b>Theo Park</b>')).toBeLessThan(roster.indexOf('<em>Not in this channel</em>'));
    expect(roster).toContain('<b>Claude</b><em>Claude Code</em>');
    expect(roster).toContain('<b>Codex</b><em>Codex</em>');
  });

  it('locks the viewer’s agent modes on Sync', () => {
    const own = row('agent_own');
    expect(own).toContain('class="kh-seg ic lock" role="radiogroup"');
    expect(own.match(/role="radio"/g)).toHaveLength(3);
    expect(own.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(3);
    expect(own.match(/title="Coming soon"/g)?.length).toBeGreaterThanOrEqual(3);
    expect(own).toMatch(/aria-checked="true" class="on" data-v="sync"/);
    expect(own).toContain('data-tip="Steer · interrupts"');
    expect(own).toContain('kh-mode-btn');
  });

  it('shows another person’s agent mode read-only', () => {
    expect(row('agent_theo')).toContain('class="kh-mode-ro" role="img" data-tip="Sync · next turn"');
    expect(row('agent_theo')).not.toContain('kh-seg');
  });

  it('puts Add agent on the viewer’s row only', () => {
    expect(roster.match(/aria-label="Add agent"/g)).toHaveLength(1);
    expect(roster.indexOf('aria-label="Add agent"')).toBeLessThan(roster.indexOf('<b>Theo Park</b>'));
  });

  it('omits every M2 roster element', () => {
    for (const absent of ['kh-keb', 'Requests', 'kh-crw', 'kh-confirm', 'class="kh-st ', 'kh-rai-p', 'kh-badge']) expect(html).not.toContain(absent);
  });
});
