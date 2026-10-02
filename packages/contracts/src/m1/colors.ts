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
