import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { OwnerId, ParticipantId } from '@khala/contracts/messaging/ids';
import { colorVariants, resolvedColor } from '../../ui/khala/human-colors';
import { ChannelColorsPicker, colorsKey, nextEnabled } from './ChannelColors';
import type { ChannelAgentView } from './controller';
import { resolveMembers } from './members';

const save = async () => 'sent' as const;
const agents = [
  { participantId: 'a1', matrixUserId: '@a1:hs', name: 'kevin-Claude', variant: 1 },
  { participantId: 'a2', matrixUserId: '@a2:hs', name: 'kevin-Codex', variant: 2 },
];

describe('ChannelColorsPicker (#1308)', () => {
  const html = renderToStaticMarkup(<ChannelColorsPicker save={save} channelColor="teal" profileColor="blue" taken={new Set(['red', 'teal'])} agents={agents} />);

  it('selects the channel colour, and disables a colour another human here chose but not the viewer\'s own', () => {
    expect(html).toMatch(/role="radio" class="kh-swatch" aria-checked="true" aria-label="Teal"/);
    expect(html).toContain('aria-disabled="true" aria-label="Red (taken)"');
    expect(html).toMatch(/aria-checked="false" aria-label="Blue"/);
    expect(html).toContain('Use profile color');
  });
  it('offers each agent the variants of the channel colour, disabling the ones its siblings use', () => {
    const shades = colorVariants(resolvedColor('teal', 0)).slice(1).map(variant => variant.tint);
    expect(html).toContain(`background:${shades[0]}`);
    expect(html).toMatch(/aria-checked="true" aria-label="Teal shade 1"/);
    expect(html).toContain('aria-disabled="true" aria-label="Teal shade 2 (taken)"');
    expect(html).toMatch(/aria-checked="true" aria-label="Teal shade 2"/);
    expect(html).toContain('aria-disabled="true" aria-label="Teal shade 1 (taken)"');
  });
  it('hides the reset without a channel colour', () => {
    const plain = renderToStaticMarkup(<ChannelColorsPicker save={save} channelColor={undefined} profileColor="blue" taken={new Set()} agents={[]} />);
    expect(plain).not.toContain('Use profile color');
    expect(plain).toMatch(/aria-checked="true" aria-label="Blue"/);
  });
});

describe('nextEnabled', () => {
  const options = [{ disabled: false }, { disabled: true }, { disabled: false }, { disabled: true }];
  it('skips disabled options and wraps', () => {
    expect(nextEnabled('ArrowRight', 0, options)).toBe(2);
    expect(nextEnabled('ArrowDown', 2, options)).toBe(0);
    expect(nextEnabled('ArrowLeft', 0, options)).toBe(2);
    expect(nextEnabled('Enter', 0, options)).toBeNull();
  });
});

describe('agent colours in the roster', () => {
  const kevin = 'owner_kevin' as OwnerId;
  const agent = (id: string): ChannelAgentView => ({ participantId: id as ParticipantId, ownerId: kevin, displayName: id, ownerDisplayName: 'Kevin',
    connection: 'unknown', routeLabel: 'Channel agent', acknowledgement: 'unknown', lastReceipt: null, installCommand: null, installCommandError: false });
  it('gives each agent its own colour while the owner badge keeps the owner\'s', () => {
    const base = resolvedColor('blue', 0);
    const variants = colorVariants(base);
    const members = resolveMembers({ viewer: { participantId: 'p_kevin', ownerId: kevin, name: 'Kevin' }, humans: [], agents: [agent('a1'), agent('a2')],
      colorFor: () => base, agentColorFor: id => variants[id === 'a1' ? 1 : 2] });
    expect(members.agents.map(member => member.color?.tint)).toEqual([variants[1]!.tint, variants[2]!.tint]);
    expect(members.agents.map(member => member.ownerColor?.tint)).toEqual([base.tint, base.tint]);
  });
});

describe('colorsKey', () => {
  it('ignores agent order and tells colours apart', () => {
    expect(colorsKey({ color: 'teal', agents: { '@b:hs': 2, '@a:hs': 1 } })).toBe(colorsKey({ color: 'teal', agents: { '@a:hs': 1, '@b:hs': 2 } }));
    expect(colorsKey({ agents: {} })).not.toBe(colorsKey({ color: 'teal', agents: {} }));
  });
});
