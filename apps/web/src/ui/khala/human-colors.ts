// Per-human colours 2/3 (operator request 2026-10-02: per-human colours). The
// 10-colour palette, and the per-viewer resolution that keeps humans in one
// channel visually distinct: the viewer always sees their own choice, others
// keep theirs unless taken, and are otherwise moved to the nearest free
// colour, then to a vivid (tier 1) and a muted (tier 2) variant.

import { createContext, createElement, useCallback, useContext, type CSSProperties, type ReactNode } from 'react';
import { HUMAN_COLOR_IDS, defaultHumanColor, type HumanColorId } from './human-color-ids';

export type HumanColorTier = 0 | 1 | 2;

export type HumanPaletteEntry = Readonly<{
  label: string;
  /** Drives the hue-based styles: name text (`--h`), avatar backgrounds (`--oh`), mentions (`--mh`). */
  hue: number;
  /** The viewer's own bubble in both themes, with white text. */
  solid: string;
  /** Light-theme text on `tiers[t].light`. */
  ink: string;
  /** Other humans' bubbles: base, vivid, muted. `dark` takes white text, `light` takes `ink`. */
  tiers: readonly [HumanTierColors, HumanTierColors, HumanTierColors];
}>;
type HumanTierColors = Readonly<{ dark: string; light: string }>;

// Every text/background pair is >= 4.5:1 (WCAG 2.x); `human-colors.test.ts` enforces it.
export const HUMAN_PALETTE = {
  red: { label: 'Red', hue: 0, solid: '#d42828', ink: '#3c1010', tiers: [{ dark: '#702e2e', light: '#f2c7c7' }, { dark: '#ba2c2c', light: '#f7a1a1' }, { dark: '#744444', light: '#f2dede' }] },
  orange: { label: 'Orange', hue: 24, solid: '#ab5821', ink: '#3c2210', tiers: [{ dark: '#5c3c26', light: '#edc9b1' }, { dark: '#955023', light: '#f4a774' }, { dark: '#654c3b', light: '#efdfd4' }] },
  amber: { label: 'Amber', hue: 42, solid: '#8b691b', ink: '#3c2f10', tiers: [{ dark: '#504221', light: '#e6ce96' }, { dark: '#7a5e1d', light: '#f0bc42' }, { dark: '#5c5036', light: '#ebe1c9' }] },
  lime: { label: 'Lime', hue: 84, solid: '#537a17', ink: '#2b3c10', tiers: [{ dark: '#37481e', light: '#b2de70' }, { dark: '#4b6b19', light: '#aaf042' }, { dark: '#485733', light: '#d8e7c0' }] },
  green: { label: 'Green', hue: 150, solid: '#187e4b', ink: '#103c26', tiers: [{ dark: '#1e4a34', light: '#87e3b5' }, { dark: '#1a7045', light: '#42f099' }, { dark: '#345846', light: '#c8ead9' }] },
  teal: { label: 'Teal', hue: 182, solid: '#187b7e', ink: '#103b3c', tiers: [{ dark: '#1e494a', light: '#83dfe2' }, { dark: '#1a6d70', light: '#42eaf0' }, { dark: '#345758', light: '#c6e8e9' }] },
  blue: { label: 'Blue', hue: 214, solid: '#276ecb', ink: '#10233c', tiers: [{ dark: '#294365', light: '#bdd3ef' }, { dark: '#2962ae', light: '#8ebbf6' }, { dark: '#3f526c', light: '#d8e3f0' }] },
  indigo: { label: 'Indigo', hue: 244, solid: '#655ce0', ink: '#13103c', tiers: [{ dark: '#3e388a', light: '#d0cdf3' }, { dark: '#564dd5', light: '#b6b1f9' }, { dark: '#4f4b81', light: '#e1e0f3' }] },
  purple: { label: 'Purple', hue: 278, solid: '#a03cda', ink: '#2c103c', tiers: [{ dark: '#5c3076', light: '#e2c7f2' }, { dark: '#922fca', light: '#d9a3f8' }, { dark: '#644575', light: '#ebdef2' }] },
  pink: { label: 'Pink', hue: 330, solid: '#ce277a', ink: '#3a1026', tiers: [{ dark: '#6d2c4d', light: '#f1c5db' }, { dark: '#b22a6e', light: '#f79cc9' }, { dark: '#72435b', light: '#f2dce7' }] },
} as const satisfies Record<HumanColorId, HumanPaletteEntry>;

export type ResolvedHumanColor = Readonly<{
  id: HumanColorId; tier: HumanColorTier; hue: number;
  /** `HUMAN_PALETTE[id].solid`: the viewer's own bubble. */
  solid: string;
  /** `tiers[tier].dark` / `.light`: another human's bubble. */
  bubbleDark: string;
  bubbleLight: string;
  ink: string;
  /** Tier 0: `solid`; else `tiers[tier].dark`. The agent-bubble tint base, and the avatar/badge/chip swatch of a variant. */
  tint: string;
}>;

export function resolvedColor(id: HumanColorId, tier: HumanColorTier): ResolvedHumanColor {
  const entry = HUMAN_PALETTE[id];
  const colors = entry.tiers[tier];
  return { id, tier, hue: entry.hue, solid: entry.solid, bubbleDark: colors.dark, bubbleLight: colors.light, ink: entry.ink,
    tint: tier === 0 ? entry.solid : colors.dark };
}

const hueDistance = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };

/** Palette ids by circular hue distance from `id` (itself first); ties → lower HUMAN_COLOR_IDS index. */
export function nearestColors(id: HumanColorId): readonly HumanColorId[] {
  const hue = HUMAN_PALETTE[id].hue;
  return HUMAN_COLOR_IDS
    .map((candidate, index) => ({ candidate, index, distance: hueDistance(hue, HUMAN_PALETTE[candidate].hue) }))
    .sort((a, b) => a.distance - b.distance || a.index - b.index)
    .map(entry => entry.candidate);
}

const TIERS: readonly HumanColorTier[] = [0, 1, 2];

/**
 * Each human's colour as `viewer` sees it, keyed by ownerId (the viewer
 * included). Pure and deterministic: others are ordered by ownerId, never by
 * join time, so a reload gives the same assignment.
 */
export function resolveHumanColors(input: Readonly<{
  viewer: Readonly<{ ownerId: string; color: HumanColorId }>;
  others: readonly Readonly<{ ownerId: string; color?: HumanColorId | undefined }>[];
}>): ReadonlyMap<string, ResolvedHumanColor> {
  const { viewer } = input;
  const result = new Map<string, ResolvedHumanColor>([[viewer.ownerId, resolvedColor(viewer.color, 0)]]);
  const taken = new Set<string>([`${viewer.color}@0`]);

  const chosen = new Map<string, HumanColorId | undefined>();
  for (const { ownerId, color } of input.others) {
    if (ownerId === viewer.ownerId) continue;
    if (chosen.get(ownerId) === undefined) chosen.set(ownerId, color);
  }
  const humans = [...chosen].map(([ownerId, color]) => ({ ownerId, preferred: color ?? defaultHumanColor(ownerId) }))
    .sort((a, b) => a.ownerId < b.ownerId ? -1 : a.ownerId > b.ownerId ? 1 : 0);

  // Pass 1: honour exact choices.
  for (const { ownerId, preferred } of humans) {
    if (taken.has(`${preferred}@0`)) continue;
    taken.add(`${preferred}@0`);
    result.set(ownerId, resolvedColor(preferred, 0));
  }
  // Pass 2: the displaced take the nearest free colour, every base colour before any variant.
  for (const { ownerId, preferred } of humans) {
    if (result.has(ownerId)) continue;
    const slot = freeSlot(preferred, taken);
    if (slot) taken.add(`${slot.id}@${slot.tier}`);
    result.set(ownerId, slot ? resolvedColor(slot.id, slot.tier) : resolvedColor(preferred, 0));
  }
  return result;
}

function freeSlot(preferred: HumanColorId, taken: ReadonlySet<string>): { id: HumanColorId; tier: HumanColorTier } | null {
  const order = nearestColors(preferred);
  for (const tier of TIERS) {
    for (const id of order) if (!taken.has(`${id}@${tier}`)) return { id, tier };
  }
  return null;
}

/** The inline custom properties a thread row needs for its bubble, by sender. */
export function humanColorStyle(color: ResolvedHumanColor, role: 'me' | 'human' | 'agent'): CSSProperties {
  if (role === 'me') return { '--hs': color.solid } as CSSProperties;
  if (role === 'human') return { '--hb': color.bubbleDark, '--hb-l': color.bubbleLight, '--hk': color.ink } as CSSProperties;
  return { '--oh': color.hue, '--ob': color.tint } as CSSProperties;
}

/** The variant swatch for avatars, badges and chips: set only for tiers 1-2, which tier 0's hue rules cannot draw. */
export function variantSwatch(color: ResolvedHumanColor | null | undefined): string | undefined {
  return color && color.tier > 0 ? color.tint : undefined;
}

const HumanColors = createContext<ReadonlyMap<string, ResolvedHumanColor> | undefined>(undefined);

/** Supplies a channel's `resolveHumanColors` result to `useHumanColor`. */
export function HumanColorsProvider({ value, children }: Readonly<{ value: ReadonlyMap<string, ResolvedHumanColor>; children?: ReactNode }>) {
  return createElement(HumanColors.Provider, { value }, children);
}

/**
 * A lookup into the nearest `HumanColorsProvider`. An owner it does not know
 * (e.g. a human who has left but is still in the timeline), or any owner
 * outside a provider, gets `fallback` (else their default colour) at tier 0.
 */
export function useHumanColor(): (ownerId: string, fallback?: HumanColorId) => ResolvedHumanColor {
  const colors = useContext(HumanColors);
  return useCallback((ownerId: string, fallback?: HumanColorId) =>
    colors?.get(ownerId) ?? resolvedColor(fallback ?? defaultHumanColor(ownerId), 0), [colors]);
}
