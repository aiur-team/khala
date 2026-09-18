// Safe navigation into the join feature. A share URL is a locator, never an
// approval authority: this module decides only what invite reference (if any)
// a location names. `132` later injects the concrete production route
// mapping; nothing here invents production URL vocabulary.

import { isSameOriginReturnPath } from '@khala/contracts/messaging/index';

export type JoinLocation = Readonly<{ inviteRef: string }>;
export type JoinLocationError = Readonly<{ error: 'invalid_location' }>;

/** Injected so `132` can supply the real production route mapping; tests use a synthetic codec. */
export interface RouteCodec {
  parseJoinLocation(url: string): JoinLocation | JoinLocationError;
}

/** Longest accepted opaque invite reference, in UTF-8 bytes. Matches the contracts' opaque-identifier limit. */
export const MAX_INVITE_REF_BYTES = 512;

// Control characters, bidi controls and invisible zero-width characters that
// could let one invite reference impersonate another or corrupt a URL.
// Built from numeric code points, never literal escapes in a regex literal,
// so this source file itself never carries a raw control character.
const CONTROL_OR_INVISIBLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x1f],
  [0x7f, 0x9f],
  [0x061c, 0x061c],
  [0x200b, 0x200b],
  [0x200e, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2060],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
];

function containsControlOrInvisible(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (CONTROL_OR_INVISIBLE_RANGES.some(([from, to]) => code >= from && code <= to)) return true;
  }
  return false;
}

function utf8Length(value: string): number {
  let bytes = 0;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

function isOpaqueInviteRef(value: string): boolean {
  return value.length > 0 && utf8Length(value) <= MAX_INVITE_REF_BYTES && !containsControlOrInvisible(value);
}

/**
 * Reference `RouteCodec` used by tests and as the feature default until `132`
 * injects the real production mapping. Reads an opaque `invite` query
 * parameter from an absolute or origin-relative URL. A scheme-relative
 * (`//host`) or otherwise external locator resolves against a fixed opaque
 * base, so it never smuggles a foreign origin into the parsed result.
 */
export const parseJoinLocation: RouteCodec['parseJoinLocation'] = url => {
  if (typeof url !== 'string' || url.length === 0) return { error: 'invalid_location' };
  let parsed: URL;
  try {
    parsed = new URL(url, 'https://join.invalid/');
  } catch {
    return { error: 'invalid_location' };
  }
  const inviteRef = parsed.searchParams.get('invite');
  if (inviteRef === null || !isOpaqueInviteRef(inviteRef)) return { error: 'invalid_location' };
  return { inviteRef };
};

/**
 * The same-origin relative path OAuth returns to after sign-in, carrying the
 * invite reference through the round trip. Never absolute, never carrying a
 * foreign scheme or host, so it always satisfies `isSameOriginReturnPath`.
 */
export function buildReturnPath(inviteRef: string): string {
  const path = `/join?invite=${encodeURIComponent(inviteRef)}`;
  return isSameOriginReturnPath(path) ? path : '/join';
}
