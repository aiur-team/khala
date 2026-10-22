import { type Decoded, decodeWith, fail, identifier, object, version } from '../messaging/decode';

export const HUMAN_COLOR_IDS = ['red', 'orange', 'amber', 'lime', 'green', 'teal', 'blue', 'indigo', 'purple', 'pink'] as const;
export type HumanColorId = typeof HUMAN_COLOR_IDS[number];
export const PROFILE_COLOR_PATH = '/api/human/profile/color';
export function isHumanColorId(value: unknown): value is HumanColorId {
  return typeof value === 'string' && (HUMAN_COLOR_IDS as readonly string[]).includes(value);
}
/** 32-bit FNV-1a over the UTF-8 bytes of `value`. */
export function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}
/** The colour of a human who has not chosen one. */
export function defaultHumanColor(ownerId: string): HumanColorId {
  return HUMAN_COLOR_IDS[fnv1a(ownerId) % HUMAN_COLOR_IDS.length]!;
}
export function readHumanColorId(input: unknown, path: string): HumanColorId {
  if (!isHumanColorId(input)) return fail(path, 'invalid_value');
  return input;
}
export type HumanColorRecord = { v: 1; ownerId: string; color: HumanColorId };
export const humanColorRecordKey = (ownerId: string): string => `humans/${encodeURIComponent(ownerId)}/color`;
export function decodeHumanColorRecord(input: unknown): Decoded<HumanColorRecord> {
  return decodeWith(() => {
    const r = object(input, '', ['v', 'ownerId', 'color']);
    return { v: version(r.field('v'), r.at('v')), ownerId: identifier(r.field('ownerId'), r.at('ownerId')),
      color: readHumanColorId(r.field('color'), r.at('color')) };
  });
}

/**
 * A human's colours in one channel, in their own `m.room.member` content (only
 * that member can send it): an optional channel colour that overrides their
 * profile colour there, and a variant index per agent Matrix user id. Clients
 * honour an agent entry only for an agent that human owns.
 */
export const CHANNEL_COLORS_MEMBER_KEY = 'com.khala.colors' as const;
/** Variant 0 is the human's own colour; agents take 1..AGENT_VARIANT_COUNT-1. */
export const AGENT_VARIANT_COUNT = 9;
export type ChannelColors = Readonly<{ color?: HumanColorId; agents: Readonly<Record<string, number>> }>;
export const isAgentVariant = (value: unknown): value is number =>
  Number.isInteger(value) && (value as number) >= 1 && (value as number) < AGENT_VARIANT_COUNT;
/** The colours in a member event's content; invalid parts are dropped, `null` when absent. */
export function memberChannelColors(content: unknown): ChannelColors | null {
  const raw = typeof content === 'object' && content !== null ? (content as Record<string, unknown>)[CHANNEL_COLORS_MEMBER_KEY] : undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const { color, agents } = raw as Record<string, unknown>;
  const entries = typeof agents === 'object' && agents !== null && !Array.isArray(agents)
    ? Object.entries(agents).filter(([userId, index]) => userId.startsWith('@') && isAgentVariant(index)) : [];
  return { ...(isHumanColorId(color) ? { color } : {}), agents: Object.fromEntries(entries) as Record<string, number> };
}
