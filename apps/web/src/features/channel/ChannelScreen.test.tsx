import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Participant } from '@khala/contracts/m1/participants';
import type { OwnerId, ParticipantId } from '@khala/contracts/messaging/ids';
import { KhalaApp } from '../../ui/khala/KhalaApp';
import { renderMessageContent } from '../timeline/message-renderer';
import { ChannelScreen, Recent, type ChannelScreenProps } from './ChannelScreen';
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
    expect(render({ phase: 'ready', agents: [] }, { onBack: () => {} })).toContain('class="kh-back" aria-label="All channels"');
  });

  it('keeps Matrix routing IDs and proof-key labels out of names', () => {
    const html = render({ phase: 'ready', agents: [agent('agent_1', mira, '@khala_a:matrix.example.test'), agent('agent_2', mira, 'proof-key:abc')] },
      { viewerName: '@mira:matrix.example.test' });
    expect(html).not.toContain('matrix.example.test');
    expect(html).not.toContain('proof-key');
  });
});

describe('ChannelScreen human emails', () => {
  it('shows each human’s username and email in the roster', () => {
    const describe_ = (participantId: string): Participant | undefined => participantId === 'p_theo'
      ? { kind: 'human', matrixUserId: '@t:x', participantId, ownerId: theo, displayName: 'Theo Park', email: 'theo@example.com' }
      : undefined;
    const html = render({ phase: 'ready', agents: [] }, { describeParticipant: describe_, viewerEmail: 'mira@example.com' });
    const roster = html.slice(html.indexOf('id="kh-roster"'), html.indexOf('class="kh-channel-thread"'));
    expect(roster).toContain('<b>You</b><em class="kh-email" title="mira@example.com">mira@example.com</em>');
    expect(roster).toContain('<b>Theo Park</b><em class="kh-email" title="theo@example.com">theo@example.com</em><em>Owner of 0 agents</em>');
  });

  it('omits the email line when control has not recorded one', () => {
    const html = render({ phase: 'ready', agents: [] });
    expect(html).not.toContain('kh-email');
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

  const modes: Record<string, 'steer' | 'sync' | 'async'> = { agent_own: 'steer', agent_theo: 'async' };
  const liveHtml = render({ phase: 'ready', agents: [agent('agent_own', mira, 'Claude'), agent('agent_theo', theo, 'Codex')] },
    { describeParticipant: describe_, modeFor: id => modes[id] ?? 'sync', onSetMode: async () => 'sent' });
  const liveRoster = liveHtml.slice(liveHtml.indexOf('id="kh-roster"'), liveHtml.indexOf('class="kh-channel-thread"'));
  const liveRow = (id: string) => liveRoster.slice(liveRoster.indexOf(`data-kh-agent="${id}"`),
    liveRoster.indexOf('</div>', liveRoster.indexOf(`data-kh-agent="${id}"`)));

  it('makes the viewer’s agent modes live, on the reported mode', () => {
    const own = liveRow('agent_own');
    expect(own).toContain('class="kh-seg ic" role="radiogroup" aria-label="Listening mode for Claude"');
    expect(own.match(/role="radio"/g)).toHaveLength(3);
    expect(own).not.toContain('disabled');
    expect(own).not.toContain('title="Coming soon"');
    expect(own).toMatch(/aria-checked="true" class="on" data-v="steer"/);
    expect(own).toContain('class="kh-ib sm kh-mode-btn" data-tip="Steer · interrupts" aria-haspopup="menu" aria-expanded="false"');
  });

  it('locks the modes, without Coming soon, when no mode port is wired', () => {
    const own = row('agent_own');
    expect(own).toContain('class="kh-seg ic lock" role="radiogroup"');
    expect(own.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(3);
    expect(own).not.toContain('Coming soon');
    expect(own).toMatch(/aria-checked="true" class="on" data-v="sync"/);
  });

  it('shows another person’s agent’s actual mode read-only', () => {
    expect(liveRow('agent_theo')).toContain('class="kh-mode-ro" role="img" data-tip="Async · on demand" aria-label="Async · on demand"');
    expect(liveRow('agent_theo')).not.toContain('kh-seg');
    expect(row('agent_theo')).toContain('class="kh-mode-ro" role="img" data-tip="Sync · next turn"');
  });

  it('puts Add agent on the viewer’s row only', () => {
    expect(roster.match(/aria-label="Add agent"/g)).toHaveLength(1);
    expect(roster.indexOf('aria-label="Add agent"')).toBeLessThan(roster.indexOf('<b>Theo Park</b>'));
  });

  it('omits every M2 roster element', () => {
    for (const absent of ['kh-keb', 'Requests', 'kh-crw', 'kh-confirm', 'class="kh-st ', 'kh-rai-p', 'kh-badge']) expect(html).not.toContain(absent);
  });

  it('offers Rename on the viewer’s own agent row only, when renaming is available', () => {
    const renaming = render({ phase: 'ready', agents: [agent('agent_own', mira, 'Claude'), agent('agent_theo', theo, 'Codex')] },
      { describeParticipant: describe_, renameAgent: async (_participantId, name) => ({ kind: 'ok', name }) });
    const list = renaming.slice(renaming.indexOf('id="kh-roster"'), renaming.indexOf('class="kh-channel-thread"'));
    expect(list.match(/aria-label="Rename [^"]*"/g)).toEqual(['aria-label="Rename Claude"']);
    expect(roster).not.toContain('aria-label="Rename');
  });

  it('shows the agent’s Matrix display name over an older in-channel rename', () => {
    const renamed = render({ phase: 'ready', agents: [agent('agent_own', mira, 'Claude')] },
      { describeParticipant: describe_, currentNames: new Map([['agent_own' as ParticipantId, 'Old name']]) });
    expect(renamed).toContain('<b>Claude</b><em>Claude Code</em>');
    expect(renamed).not.toContain('Old name');
  });
});

describe('ChannelScreen Recent in Khala', () => {
  const roster = [{ label: 'Theo', participantId: 'p_theo', kind: 'human' as const, hue: 210 },
    { label: 'Scout', participantId: 'agent_scout', kind: 'agent' as const, hue: 30 }];

  it('draws @mentions as the timeline\u2019s mention chips', () => {
    const body = renderMessageContent({ v: 1, kind: 'text', body: 'Ready for @Theo, ping @Scout or @nobody' }, { mentions: roster });
    const html = renderToStaticMarkup(<Recent entries={[{ id: 'e1', at: '2026-10-01T16:52:00Z', body }]} timeOptions={{ timeZone: 'UTC' }} />);
    const log = html.slice(html.indexOf('class="kh-d-log"'));
    expect(log).toContain('<span class="kh-mention kh-hm" style="--mh:210" role="button" tabindex="0">@Theo</span>');
    expect(log).toContain('<span class="kh-mention" style="--mh:30" role="button" tabindex="0">@Scout</span>');
    expect(log).toContain(' or @nobody');
  });

  it('hands the thread a mention roster callback', () => {
    let received: unknown;
    render({ phase: 'ready', agents: [] }, { renderTimeline: (_open, _invite, onMentionRoster) => { received = onMentionRoster; return null; } });
    expect(typeof received).toBe('function');
  });
});
