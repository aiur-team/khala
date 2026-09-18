// Mutation guard: exact Origin, same-origin fetch metadata, then a session-bound
// CSRF proof. Authority comes only from the session; a request body's `ownerId`
// or email is untrusted data and never consulted here.

import { timingSafeEqual } from 'node:crypto';

export const CSRF_HEADER = 'x-khala-csrf';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export type OriginCheck = 'ok' | 'not_a_mutation' | 'forbidden_origin';

/** Checks everything that needs no store read, so a cross-site request costs nothing. */
export function checkMutationOrigin(request: Pick<Request, 'method' | 'headers'>, origin: string): OriginCheck {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return 'not_a_mutation';
  if (request.headers.get('origin') !== origin) return 'forbidden_origin';
  const site = request.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin') return 'forbidden_origin';
  return 'ok';
}

/** Constant-time comparison of a presented secret against the expected one. */
export function safeEqual(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function csrfMatches(presented: string | null, expected: string): boolean {
  return presented !== null && safeEqual(presented, expected);
}
