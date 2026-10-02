import { describe, expect, it } from 'vitest';
import { HUMAN_COLOR_IDS, defaultHumanColor, type HumanColorId } from '@khala/contracts/m1/colors';
import { HUMAN_PALETTE, colorSwatch, humanColorStyle, nearestColors, resolveHumanColors, resolvedColor, type ResolvedHumanColor } from './human-colors';

const slot = (color: ResolvedHumanColor | undefined) => color ? `${color.id}@${color.tier}` : undefined;
const slots = (map: ReadonlyMap<string, ResolvedHumanColor>) => Object.fromEntries([...map].map(([ownerId, color]) => [ownerId, slot(color)]));

describe('nearestColors', () => {
  it('orders by circular hue distance, ties to the lower palette index', () => {
    expect(nearestColors('blue')).toEqual(['blue', 'indigo', 'teal', 'green', 'purple', 'pink', 'lime', 'red', 'orange', 'amber']);
    expect(nearestColors('red')).toEqual(['red', 'orange', 'pink', 'amber', 'purple', 'lime', 'indigo', 'blue', 'green', 'teal']);
  });

  it('starts every list with the colour itself and covers the palette', () => {
    for (const id of HUMAN_COLOR_IDS) {
      expect(nearestColors(id)[0]).toBe(id);
      expect([...nearestColors(id)].sort()).toEqual([...HUMAN_COLOR_IDS].sort());
    }
  });
});

describe('resolveHumanColors', () => {
  const others = [
    { ownerId: 'o-b', color: 'blue' as const },
    { ownerId: 'o-c', color: 'blue' as const },
    { ownerId: 'o-d', color: 'indigo' as const },
  ];

  it('gives the operator example: three blues each see themselves blue and the others apart', () => {
    expect(slots(resolveHumanColors({ viewer: { ownerId: 'o-a', color: 'blue' }, others }))).toEqual({
      'o-a': 'blue@0', 'o-b': 'teal@0', 'o-c': 'green@0', 'o-d': 'indigo@0',
    });
    const fromB = resolveHumanColors({
      viewer: { ownerId: 'o-b', color: 'blue' },
      others: [{ ownerId: 'o-a', color: 'blue' }, { ownerId: 'o-c', color: 'blue' }, { ownerId: 'o-d', color: 'indigo' }],
    });
    expect(slots(fromB)).toEqual({ 'o-b': 'blue@0', 'o-a': 'teal@0', 'o-c': 'green@0', 'o-d': 'indigo@0' });
  });

  it('is independent of the order of others', () => {
    const viewer = { ownerId: 'o-a', color: 'blue' as const };
    const expected = slots(resolveHumanColors({ viewer, others }));
    for (const shuffled of [[others[2]!, others[0]!, others[1]!], [others[1]!, others[2]!, others[0]!], [...others].reverse()]) {
      expect(slots(resolveHumanColors({ viewer, others: shuffled }))).toEqual(expected);
    }
  });

  it('uses all ten base colours before the vivid variants', () => {
    const many = Array.from({ length: 11 }, (_, index) => ({ ownerId: `o-${String(index).padStart(2, '0')}`, color: 'red' as const }));
    const result = resolveHumanColors({ viewer: { ownerId: 'viewer', color: 'red' }, others: many });
    expect(slot(result.get('viewer'))).toBe('red@0');
    expect(many.map(({ ownerId }) => slot(result.get(ownerId)))).toEqual([
      'orange@0', 'pink@0', 'amber@0', 'purple@0', 'lime@0', 'indigo@0', 'blue@0', 'green@0', 'teal@0', 'red@1', 'orange@1',
    ]);
  });

  it('accepts a duplicate only once all 30 slots are used', () => {
    const many = Array.from({ length: 30 }, (_, index) => ({ ownerId: `o-${String(index).padStart(2, '0')}`, color: 'green' as const }));
    const result = resolveHumanColors({ viewer: { ownerId: 'viewer', color: 'green' }, others: many });
    const firstThirty = [slot(result.get('viewer')), ...many.slice(0, 29).map(({ ownerId }) => slot(result.get(ownerId)))];
    expect(new Set(firstThirty).size).toBe(30);
    expect(slot(result.get('o-29'))).toBe('green@0');
  });

  it("ignores an entry with the viewer's ownerId", () => {
    const result = resolveHumanColors({ viewer: { ownerId: 'o-a', color: 'blue' }, others: [{ ownerId: 'o-a', color: 'red' }] });
    expect(slots(result)).toEqual({ 'o-a': 'blue@0' });
  });

  it('falls back to the default colour, and lets a defined colour win among duplicates', () => {
    const result = resolveHumanColors({
      viewer: { ownerId: 'viewer', color: defaultHumanColor('o-x') === 'red' ? 'blue' : 'red' },
      others: [{ ownerId: 'o-x' }, { ownerId: 'o-y' }, { ownerId: 'o-y', color: defaultHumanColor('o-y') === 'pink' ? 'lime' : 'pink' }],
    });
    expect(result.get('o-x')?.id).toBe(defaultHumanColor('o-x'));
    expect(result.get('o-y')?.id).toBe(defaultHumanColor('o-y') === 'pink' ? 'lime' : 'pink');
  });
});

describe('resolvedColor and humanColorStyle', () => {
  it('tints with solid at tier 0 and with the dark variant otherwise', () => {
    expect(resolvedColor('blue', 0)).toMatchObject({ hue: 214, solid: '#276ecb', bubbleDark: '#294365', bubbleLight: '#bdd3ef', ink: '#10233c', tint: '#276ecb' });
    expect(resolvedColor('blue', 1).tint).toBe('#2962ae');
    expect(resolvedColor('blue', 2).tint).toBe('#3f526c');
  });

  it('keeps pink tier 0 equal to the design other-human bubble', () => {
    expect(HUMAN_PALETTE.pink.tiers[0]).toEqual({ dark: '#6d2c4d', light: '#f1c5db' });
    expect(HUMAN_PALETTE.pink.ink).toBe('#3a1026');
  });

  it('maps each sender to its custom properties', () => {
    const blue = resolvedColor('blue', 0);
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

  const cases = HUMAN_COLOR_IDS.flatMap(id => ([0, 1, 2] as const).map(tier => [id, tier] as [HumanColorId, 0 | 1 | 2]));

  it.each(cases)('%s tier %i keeps every bubble text >= 4.5:1', (id, tier) => {
    const entry = HUMAN_PALETTE[id];
    expect(ratio(white, rgb(entry.solid))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(white, rgb(entry.tiers[tier].dark))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(rgb(entry.ink), rgb(entry.tiers[tier].light))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(cases)('%s tier %i keeps agent-bubble text >= 4.5:1 on its tint', (id, tier) => {
    const { tint } = resolvedColor(id, tier);
    expect(ratio(rgb('#edeef0'), mix(tint, 0.30, '#292d34'))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(rgb('#2a2520'), mix(tint, 0.28, '#e9dcbf'))).toBeGreaterThanOrEqual(4.5);
  });

  it.each(cases)('%s tier %i keeps white avatar initials >= 4.5:1 on its swatch', (id, tier) => {
    const color = resolvedColor(id, tier);
    expect(colorSwatch(color)).toBe(color.tint);
    expect(ratio(white, rgb(color.tint))).toBeGreaterThanOrEqual(4.5);
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
