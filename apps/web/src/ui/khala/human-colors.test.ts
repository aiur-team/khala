import { describe, expect, it } from 'vitest';
import { HUMAN_COLOR_IDS, defaultHumanColor, type ChannelColorKey } from '@khala/contracts/m1/colors';
import { HUMAN_PALETTE, channelPalette, colorOf, colorSwatch, humanColorStyle, resolveChannelColors, type ColorMember } from './human-colors';

const keysOf = (result: ReadonlyMap<string, { key: ChannelColorKey }>) => Object.fromEntries([...result].map(([id, color]) => [id, color.key]));
const human = (id: string, pick?: ChannelColorKey): ColorMember => ({ id, ownerId: id, pick });
const agent = (id: string, ownerId: string, pick?: ChannelColorKey): ColorMember => ({ id, ownerId, pick });

describe('channelPalette', () => {
  it('keeps the 10 base colours up to 10 members and adds a shade ring per further 10', () => {
    expect(channelPalette(0)).toEqual(HUMAN_COLOR_IDS);
    expect(channelPalette(10)).toEqual(HUMAN_COLOR_IDS);
    expect(channelPalette(11)).toEqual([...HUMAN_COLOR_IDS, ...HUMAN_COLOR_IDS.map(id => `${id}.1`)]);
    expect(channelPalette(20)).toHaveLength(20);
    expect(channelPalette(21)).toHaveLength(30);
    expect(channelPalette(1000)).toHaveLength(90);
  });
});

describe('resolveChannelColors', () => {
  it('shows everyone their chosen colour when nothing clashes', () => {
    expect(keysOf(resolveChannelColors('a', [human('a', 'blue'), human('b', 'red'), agent('x', 'b', 'teal.1')])))
      .toEqual({ a: 'blue', b: 'red', x: 'teal.1' });
  });

  it('lets the viewer take another human\'s colour on their own page only', () => {
    const members = [human('a', 'red'), agent('a1', 'a', 'teal'), human('b', 'red'), agent('b1', 'b', 'teal')];
    const fromA = keysOf(resolveChannelColors('a', members));
    const fromB = keysOf(resolveChannelColors('b', members));
    expect([fromA.a, fromA.a1]).toEqual(['red', 'teal']);
    expect([fromB.b, fromB.b1]).toEqual(['red', 'teal']);
    expect(fromA.b).not.toBe('red');
    expect(fromA.b1).not.toBe('teal');
    expect(fromB.a).not.toBe('red');
  });

  it('gives a clash between two others to the human, then the lower id; the loser takes the next free colour', () => {
    expect(keysOf(resolveChannelColors('v', [human('v', 'blue'), agent('m1', 'm', 'red'), human('z', 'red')])))
      .toEqual({ v: 'blue', z: 'red', m1: 'orange' });
    expect(keysOf(resolveChannelColors('v', [human('v', 'blue'), human('y', 'red'), human('x', 'red')])))
      .toEqual({ v: 'blue', x: 'red', y: 'orange' });
  });

  it('gives members with no pick their default colour when free', () => {
    expect(resolveChannelColors('v', [human('v', 'blue'), human('o-x')]).get('o-x')?.key)
      .toBe(defaultHumanColor('o-x') === 'blue' ? 'indigo' : defaultHumanColor('o-x'));
  });

  it('is the same for any input order', () => {
    const members = [human('a', 'red'), human('b', 'red'), agent('b1', 'b'), agent('b2', 'b', 'red'), human('c'), agent('c1', 'c', 'blue')];
    const expected = keysOf(resolveChannelColors('c', members));
    for (let shift = 1; shift < members.length; shift++) {
      expect(keysOf(resolveChannelColors('c', [...members.slice(shift), ...members.slice(0, shift)].reverse()))).toEqual(expected);
    }
  });

  it('never shows two members in one colour on any viewer\'s page, expanding the palette past 10', () => {
    const picks = channelPalette(1);
    const members: ColorMember[] = Array.from({ length: 35 }, (_, index) => index % 3 === 0
      ? human(`h${index}`, picks[index % 4])
      : agent(`g${index}`, `h${index - index % 3}`, index % 2 ? picks[index % 5] : undefined));
    for (const viewer of ['h0', 'h12', 'h33', 'nobody']) {
      const result = resolveChannelColors(viewer, members);
      expect(result.size).toBe(35);
      expect(new Set([...result.values()].map(color => color.key)).size).toBe(35);
    }
    expect(keysOf(resolveChannelColors('h0', members)).h0).toBe('red');
  });

  it('keeps the first entry for a repeated member id', () => {
    expect(keysOf(resolveChannelColors('v', [human('v', 'blue'), human('v', 'red')]))).toEqual({ v: 'blue' });
  });
});

describe('colorOf and humanColorStyle', () => {
  it('draws a base colour from the palette and a shade from its generated tint', () => {
    expect(colorOf('blue')).toMatchObject({ key: 'blue', label: 'Blue', hue: 214, solid: '#276ecb', bubbleDark: '#294365', bubbleLight: '#bdd3ef', ink: '#10233c', tint: '#276ecb' });
    const shade = colorOf('blue.2');
    expect(shade).toMatchObject({ key: 'blue.2', label: 'Blue shade 2', bubbleLight: '#bdd3ef', solid: shade.tint, bubbleDark: shade.tint });
    expect(shade.tint).not.toBe(colorOf('blue').tint);
  });

  it('keeps pink equal to the design other-human bubble', () => {
    expect(HUMAN_PALETTE.pink).toMatchObject({ dark: '#6d2c4d', light: '#f1c5db', ink: '#3a1026' });
  });

  it('maps each sender to its custom properties', () => {
    const blue = colorOf('blue');
    expect(humanColorStyle(blue, 'me')).toEqual({ '--hs': '#276ecb' });
    expect(humanColorStyle(blue, 'human')).toEqual({ '--hb': '#294365', '--hb-l': '#bdd3ef', '--hk': '#10233c' });
    expect(humanColorStyle(blue, 'agent')).toEqual({ '--oh': 214, '--ob': '#276ecb' });
  });
});

describe('palette contrast (WCAG 2.x)', () => {
  const rgb = (hex: string) => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16)) as [number, number, number];
  const luminance = (channels: readonly number[]) => {
    const [r, g, b] = channels.map(value => { const c = value / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const ratio = (a: readonly number[], b: readonly number[]) => {
    const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (high! + 0.05) / (low! + 0.05);
  };
  // color-mix(in srgb, tint p, base): a per-channel blend of the gamma-encoded values.
  const mix = (tint: string, p: number, base: string) => rgb(tint).map((value, index) => Math.round(value * p + rgb(base)[index]! * (1 - p)));
  const white = [255, 255, 255];
  const keys = channelPalette(Infinity);

  it.each(keys)('%s keeps bubble, agent-bubble and avatar text >= 4.5:1', key => {
    const color = colorOf(key);
    expect(ratio(white, rgb(color.solid))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(white, rgb(color.bubbleDark))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(rgb(color.ink), rgb(color.bubbleLight))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(rgb('#edeef0'), mix(color.tint, 0.30, '#292d34'))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(rgb('#2a2520'), mix(color.tint, 0.28, '#e9dcbf'))).toBeGreaterThanOrEqual(4.5);
    expect(colorSwatch(color)).toBe(color.tint);
    expect(ratio(white, rgb(color.tint))).toBeGreaterThanOrEqual(4.5);
  });

  it('generates 8 distinct shades of every base colour', () => {
    expect(keys).toHaveLength(90);
    for (const id of HUMAN_COLOR_IDS) {
      const tints = keys.filter(key => key.split('.')[0] === id).map(key => colorOf(key).tint);
      for (let a = 0; a < tints.length; a++) for (let b = a + 1; b < tints.length; b++) {
        const distance = rgb(tints[a]!).reduce((sum, value, index) => sum + Math.abs(value - rgb(tints[b]!)[index]!), 0);
        expect(distance, `${tints[a]} vs ${tints[b]}`).toBeGreaterThanOrEqual(30);
      }
    }
  });

  // The CSS fallback `hsl(var(--oh) 65% 29%)` for avatars drawn from a hue alone (no provider, the channel list).
  const hsl = (h: number, s: number, l: number) => {
    const a = s * Math.min(l, 1 - l);
    const f = (n: number) => { const k = (n + h / 30) % 12; return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); };
    return [f(0), f(8), f(4)];
  };

  it('keeps white initials >= 4.5:1 on the hue-only fallback for every hue', () => {
    const worst = Math.min(...Array.from({ length: 360 }, (_, hue) => ratio(white, hsl(hue, 0.65, 0.29))));
    expect(worst).toBeGreaterThanOrEqual(4.5);
  });
});
