import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { OwnerId, ParticipantId } from '@khala/contracts/messaging/ids';
import { channelPalette, colorOf } from '../../ui/khala/human-colors';
import { ChannelColorsPicker, colorsKey, nextIndex } from './ChannelColors';
import type { ChannelAgentView } from './controller';
import { resolveMembers } from './members';

const save = async () => 'sent' as const;
const agents = [
  { participantId: 'a1', matrixUserId: '@a1:hs', name: 'kevin-Claude', color: 'red' as const },
  { participantId: 'a2', matrixUserId: '@a2:hs', name: 'kevin-Codex', color: 'teal.1' as const },
];

describe('ChannelColorsPicker', () => {
  const html = renderToStaticMarkup(<ChannelColorsPicker save={save} channelColor="teal" shownColor="blue" palette={channelPalette(10)} agents={agents} />);

  it('offers the whole palette to the viewer and each agent, with nothing disabled and no profile-colour reset', () => {
    expect(html.match(/role="radiogroup"/g)).toHaveLength(3);
    expect(html.match(/role="radio"/g)).toHaveLength(10 + 10 + 11);
    expect(html).not.toContain('aria-disabled');
    expect(html).not.toContain('Use profile color');
  });
  it('selects the channel colour and each agent\'s colour, listing a shade outside the palette', () => {
    expect(html).toMatch(/aria-checked="true" aria-label="Teal"/);
    expect(html).toMatch(/aria-checked="true" aria-label="Red"/);
    expect(html).toMatch(/aria-checked="true" aria-label="Teal shade 1"/);
    expect(html).toContain(`background:${colorOf('teal.1').tint}`);
  });
  it('shows the resolved colour without a channel colour', () => {
    const plain = renderToStaticMarkup(<ChannelColorsPicker save={save} channelColor={undefined} shownColor="blue" palette={channelPalette(10)} agents={[]} />);
    expect(plain).toMatch(/aria-checked="true" aria-label="Blue"/);
  });
});

describe('nextIndex', () => {
  it('moves by arrow keys and wraps', () => {
    expect(nextIndex('ArrowRight', 0, 4)).toBe(1);
    expect(nextIndex('ArrowDown', 3, 4)).toBe(0);
    expect(nextIndex('ArrowLeft', 0, 4)).toBe(3);
    expect(nextIndex('Enter', 0, 4)).toBeNull();
  });
});

describe('agent colours in the roster', () => {
  const kevin = 'owner_kevin' as OwnerId;
  const agent = (id: string): ChannelAgentView => ({ participantId: id as ParticipantId, ownerId: kevin, displayName: id, ownerDisplayName: 'Kevin',
    connection: 'unknown', routeLabel: 'Channel agent', acknowledgement: 'unknown', lastReceipt: null, installCommand: null, installCommandError: false });
  it('gives each agent its own colour while the owner badge keeps the owner\'s', () => {
    const base = colorOf('blue');
    const own = { a1: colorOf('red'), a2: colorOf('pink.2') };
    const members = resolveMembers({ viewer: { participantId: 'p_kevin', ownerId: kevin, name: 'Kevin' }, humans: [], agents: [agent('a1'), agent('a2')],
      colorFor: () => base, agentColorFor: id => own[id as 'a1' | 'a2'] });
    expect(members.agents.map(member => member.color?.tint)).toEqual([own.a1.tint, own.a2.tint]);
    expect(members.agents.map(member => member.ownerColor?.tint)).toEqual([base.tint, base.tint]);
  });
});

describe('colorsKey', () => {
  it('ignores agent order and tells colours apart', () => {
    expect(colorsKey({ color: 'teal', agents: { '@b:hs': 'red', '@a:hs': 'blue.1' } })).toBe(colorsKey({ color: 'teal', agents: { '@a:hs': 'blue.1', '@b:hs': 'red' } }));
    expect(colorsKey({ agents: {} })).not.toBe(colorsKey({ color: 'teal', agents: {} }));
  });
});
