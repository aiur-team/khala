import { type Decoded, decodeWith, fail, identifier, nullable, object, version } from '../messaging/decode';

export const PROFILE_INITIALS_PATH = '/api/human/profile/initials';
export function normalizeInitials(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const nfc = input.normalize('NFC');
  if ([...nfc].length !== 2) return null;
  const up = nfc.toLocaleUpperCase('en-US');
  return /^[\p{L}\p{Nd}]{2}$/u.test(up) ? up : null;
}
export function isCanonicalInitials(value: unknown): value is string {
  return typeof value === 'string' && normalizeInitials(value) === value;
}
export function readHumanInitials(input: unknown, path: string): string {
  if (!isCanonicalInitials(input)) return fail(path, 'invalid_value');
  return input;
}
export type HumanInitialsRecord = { v: 1; ownerId: string; initials: string | null };
export const humanInitialsRecordKey = (ownerId: string): string => `humans/${encodeURIComponent(ownerId)}/initials`;
export function decodeHumanInitialsRecord(input: unknown): Decoded<HumanInitialsRecord> {
  return decodeWith(() => {
    const r = object(input, '', ['v', 'ownerId', 'initials']);
    return { v: version(r.field('v'), r.at('v')), ownerId: identifier(r.field('ownerId'), r.at('ownerId')),
      initials: nullable(r.field('initials'), value => readHumanInitials(value, r.at('initials'))) };
  });
}
