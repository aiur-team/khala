// Per-channel colours (operator requests 2026-10-02 and 2026-10-23). The
// 10-colour palette, its generated shades, and the per-viewer resolution that
// keeps every member of a channel visually distinct on the viewer's page.

import { createContext, createElement, useCallback, useContext, type CSSProperties, type ReactNode } from 'react';
import { CHANNEL_SHADE_COUNT, HUMAN_COLOR_IDS, defaultHumanColor, fnv1a, type ChannelColorKey, type HumanColorId } from '@khala/contracts/m1/colors';
import type { Participant } from '@khala/contracts/m1/participants';

export type HumanPaletteEntry = Readonly<{
  label: string;
  /** Drives the hue-based styles: name text (`--h`), avatar backgrounds (`--oh`), mentions (`--mh`). */
  hue: number;
  /** The viewer's own bubble in both themes, with white text. */
  solid: string;
  /** Light-theme text on `light`. */
  ink: string;
  /** Other humans' bubbles: `dark` takes white text, `light` takes `ink`. */
  dark: string;
  light: string;
}>;

// Every text/background pair is >= 4.5:1 (WCAG 2.x); `human-colors.test.ts` enforces it.
export const HUMAN_PALETTE = {
  red: { label: 'Red', hue: 0, solid: '#d42828', ink: '#3c1010', dark: '#702e2e', light: '#f2c7c7' },
  orange: { label: 'Orange', hue: 24, solid: '#ab5821', ink: '#3c2210', dark: '#5c3c26', light: '#edc9b1' },
  amber: { label: 'Amber', hue: 42, solid: '#8b691b', ink: '#3c2f10', dark: '#504221', light: '#e6ce96' },
  lime: { label: 'Lime', hue: 84, solid: '#537a17', ink: '#2b3c10', dark: '#37481e', light: '#b2de70' },
  green: { label: 'Green', hue: 150, solid: '#187e4b', ink: '#103c26', dark: '#1e4a34', light: '#87e3b5' },
  teal: { label: 'Teal', hue: 182, solid: '#187b7e', ink: '#103b3c', dark: '#1e494a', light: '#83dfe2' },
  blue: { label: 'Blue', hue: 214, solid: '#276ecb', ink: '#10233c', dark: '#294365', light: '#bdd3ef' },
  indigo: { label: 'Indigo', hue: 244, solid: '#655ce0', ink: '#13103c', dark: '#3e388a', light: '#d0cdf3' },
  purple: { label: 'Purple', hue: 278, solid: '#a03cda', ink: '#2c103c', dark: '#5c3076', light: '#e2c7f2' },
  pink: { label: 'Pink', hue: 330, solid: '#ce277a', ink: '#3a1026', dark: '#6d2c4d', light: '#f1c5db' },
} as const satisfies Record<HumanColorId, HumanPaletteEntry>;

export type ResolvedHumanColor = Readonly<{
  key: ChannelColorKey; label: string; hue: number;
  /** The viewer's own bubble. */
  solid: string;
  /** Another human's bubble. */
  bubbleDark: string;
  bubbleLight: string;
  ink: string;
  /** The agent-bubble tint base, and the avatar/badge/chip/swatch fill; white text on it is >= 4.5:1. */
  tint: string;
}>;

// Shades: candidates are [hue offset in degrees, fraction of the lightest
// lightness that keeps white text >= 4.5:1], tried in order; one is kept only
// if it is clearly apart from the base and every shade already kept.
const SHADE_CANDIDATES: readonly (readonly [number, number])[] = [
  [0, 0.75], [20, 1], [-20, 1], [0, 0.55], [20, 0.75], [-20, 0.75], [40, 1], [-40, 1], [20, 0.55], [-20, 0.55],
  [40, 0.75], [-40, 0.75], [0, 1], [40, 0.55], [-40, 0.55], [60, 1], [-60, 1]];
/** Minimum summed RGB channel distance between two shades of one colour. */
const SHADE_MIN_DISTANCE = 30;

const channel = (value: number) => { const c = value / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const rgbOf = (hex: string) => [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16));
/** WCAG contrast of white text on `hex`. */
function whiteContrast(hex: string): number {
  const [r, g, b] = rgbOf(hex).map(channel);
  return 1.05 / (0.2126 * r! + 0.7152 * g! + 0.0722 * b! + 0.05);
}
function toHsl(hex: string): [number, number, number] {
  const [r, g, b] = rgbOf(hex).map(value => value / 255) as [number, number, number];
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, s, l];
}
function toHex(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => { const k = (n + h / 30) % 12; return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); };
  return `#${[f(0), f(8), f(4)].map(value => value.toString(16).padStart(2, '0')).join('')}`;
}
const distance = (a: string, b: string) => { const right = rgbOf(b); return rgbOf(a).reduce((sum, value, index) => sum + Math.abs(value - right[index]!), 0); };

const shadeCache = new Map<HumanColorId, readonly Readonly<{ hue: number; tint: string }>[]>();
/** `id`'s CHANNEL_SHADE_COUNT generated shades, in palette order. */
function shadesOf(id: HumanColorId): readonly Readonly<{ hue: number; tint: string }>[] {
  const cached = shadeCache.get(id);
  if (cached) return cached;
  const entry = HUMAN_PALETTE[id];
  const [h, s] = toHsl(entry.solid);
  const kept: string[] = [entry.solid];
  const shades: { hue: number; tint: string }[] = [];
  for (const [offset, fraction] of SHADE_CANDIDATES) {
    if (shades.length === CHANNEL_SHADE_COUNT) break;
    const hue = (h + offset + 360) % 360, saturation = Math.max(s, 0.5);
    let ceiling = 0.9;
    while (whiteContrast(toHex(hue, saturation, ceiling)) < 4.5) ceiling -= 0.01;
    const tint = toHex(hue, saturation, ceiling * fraction);
    if (kept.every(other => distance(other, tint) >= SHADE_MIN_DISTANCE)) {
      kept.push(tint);
      shades.push({ hue: Math.round((entry.hue + offset + 360) % 360), tint });
    }
  }
  shadeCache.set(id, shades);
  return shades;
}

/** The colours a palette key draws with. A shade fills its own bubble in the dark theme; the light bubble stays its base colour's. */
export function colorOf(key: ChannelColorKey): ResolvedHumanColor {
  const [id, n] = key.split('.') as [HumanColorId, string | undefined];
  const entry = HUMAN_PALETTE[id];
  const base = { key: id, label: entry.label, hue: entry.hue, solid: entry.solid, bubbleDark: entry.dark, bubbleLight: entry.light, ink: entry.ink, tint: entry.solid };
  const shade = n === undefined ? undefined : shadesOf(id)[Number(n) - 1];
  return shade ? { ...base, key, label: `${entry.label} shade ${n}`, hue: shade.hue, solid: shade.tint, bubbleDark: shade.tint, tint: shade.tint } : base;
}

/**
 * The channel palette for `members` participants: the 10 base colours, plus
 * one ring of shades per further 10 members (ring-major), so it always has a
 * colour per member.
 */
export function channelPalette(members: number): readonly ChannelColorKey[] {
  const rings = Math.min(Math.max(1, Math.ceil(members / HUMAN_COLOR_IDS.length)), CHANNEL_SHADE_COUNT + 1);
  // ponytail: past (CHANNEL_SHADE_COUNT+1)*10 members the palette stops growing and colours repeat; add shades if that happens.
  return Array.from({ length: rings }, (_, ring) => HUMAN_COLOR_IDS.map(id => ring ? `${id}.${ring}` as const : id)).flat();
}

/** A channel member to colour: a human (`id` is its owner id) or an agent (`id` is its participant id). */
export type ColorMember = Readonly<{ id: string; ownerId: string; pick?: ChannelColorKey | undefined }>;

/**
 * Every member's colour as the viewer sees it, by member id. Pure and
 * order-independent. The viewer's own picks (theirs and their agents') win a
 * clash; then humans before agents, then by id. A member whose pick is taken,
 * or who has none, takes the first free palette colour from its pick (else a
 * hash of its id), so no two members share a colour on this page.
 */
export function resolveChannelColors(viewerOwnerId: string, input: readonly ColorMember[]): ReadonlyMap<string, ResolvedHumanColor> {
  const byId = new Map<string, ColorMember>();
  for (const member of input) if (!byId.has(member.id)) byId.set(member.id, member);
  const rank = (member: ColorMember) => `${member.ownerId === viewerOwnerId ? 0 : 1}${member.id === member.ownerId ? 0 : 1}`;
  const members = [...byId.values()].sort((a, b) => rank(a) < rank(b) ? -1 : rank(a) > rank(b) ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const palette = channelPalette(members.length);
  const taken = new Set<ChannelColorKey>();
  const keys = new Map<string, ChannelColorKey>();
  for (const { id, pick } of members) {
    if (pick && !taken.has(pick)) { taken.add(pick); keys.set(id, pick); }
  }
  for (const { id, pick } of members) {
    if (keys.has(id)) continue;
    const at = pick ? palette.indexOf(pick) : -1;
    const start = at >= 0 ? at : fnv1a(id) % palette.length;
    const free = palette.map((_, step) => palette[(start + step) % palette.length]!).find(key => !taken.has(key)) ?? palette[start]!;
    taken.add(free);
    keys.set(id, free);
  }
  return new Map([...keys].map(([id, key]) => [id, colorOf(key)]));
}

/** A human participant's chosen colour; absent from responses older than the colour field. */
export const humanColorOf = (detail: Participant | undefined): HumanColorId | undefined =>
  detail?.kind === 'human' ? detail.color : undefined;

/** An agent participant's owner's colour, which control sends even when the owner isn't in the channel. */
export const ownerColorOf = (detail: Participant | undefined): HumanColorId | undefined =>
  detail?.kind === 'agent' ? detail.ownerColor : undefined;

/** The inline custom properties a thread row needs for its bubble, by sender. */
export function humanColorStyle(color: ResolvedHumanColor, role: 'me' | 'human' | 'agent'): CSSProperties {
  if (role === 'me') return { '--hs': color.solid } as CSSProperties;
  if (role === 'human') return { '--hb': color.bubbleDark, '--hb-l': color.bubbleLight, '--hk': color.ink } as CSSProperties;
  return { '--oh': color.hue, '--ob': color.tint } as CSSProperties;
}

/**
 * The fill for avatars, badges and chips that carry white initials: every
 * palette colour keeps white text
 * at least 4.5:1, which the hue-only fill did not for green, teal or lime.
 */
export function colorSwatch(color: ResolvedHumanColor | null | undefined): string | undefined {
  return color?.tint;
}

const HumanColors = createContext<ReadonlyMap<string, ResolvedHumanColor> | undefined>(undefined);

/** Supplies a channel's `resolveChannelColors` result to `useHumanColor`. */
export function HumanColorsProvider({ value, children }: Readonly<{ value: ReadonlyMap<string, ResolvedHumanColor>; children?: ReactNode }>) {
  return createElement(HumanColors.Provider, { value }, children);
}

/**
 * A lookup into the nearest `HumanColorsProvider`, by agent participant id (its
 * own colour) first when given, then owner id. An owner it does not know
 * (e.g. a human who has left but is still in the timeline), or any owner
 * outside a provider, gets `fallback` (else their default colour).
 */
export function useHumanColor(): (ownerId: string, fallback?: HumanColorId, agentId?: string) => ResolvedHumanColor {
  const colors = useContext(HumanColors);
  return useCallback((ownerId: string, fallback?: HumanColorId, agentId?: string) =>
    (agentId === undefined ? undefined : colors?.get(agentId)) ?? colors?.get(ownerId) ?? colorOf(fallback ?? defaultHumanColor(ownerId)), [colors]);
}
