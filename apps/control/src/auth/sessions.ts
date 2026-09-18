// Browser sessions. The cookie carries a random token; the store holds only its
// purpose-separated hash, so a store read never yields a usable credential. A
// store outage is `unavailable`, never signed out.

import { createHash } from 'node:crypto';
import {
  type AuthPrincipal, type ControlRecord, type ControlStore, type OwnerId, decodeAuthPrincipal,
} from '@khala/contracts/messaging/index';
import type { ProviderIdentity } from './principal';
import { type Random, TOKEN, derive, randomToken, settleWrite } from './store';

export const SESSION_COOKIE = '__Host-khala_session';
export const LOGIN_COOKIE = '__Host-khala_login';

type SessionRecord = {
  v: 1;
  ownerId: string;
  providerIssuer: string;
  providerSubject: string;
  verifiedEmail: string;
  expiresAt: string;
  revoked: boolean;
};

export type SessionLookup =
  | Readonly<{ kind: 'authenticated'; principal: AuthPrincipal; token: string; record: ControlRecord<SessionRecord> }>
  | Readonly<{ kind: 'signed_out' }>
  | Readonly<{ kind: 'unavailable' }>;

export const sessionKey = (token: string) => `auth.session.v1.${derive('session', token)}`;

/** Session-bound CSRF proof. Derivable only from the HttpOnly token, so another origin cannot compute it. */
export const csrfTokenFor = (sessionToken: string) => derive('csrf', sessionToken);

/**
 * Reads one cookie. A duplicated name is ambiguous (another cookie scope may have
 * injected it), so it reads as absent rather than picking one.
 */
export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  const values = header.split(';').map(part => part.trim()).filter(part => part.startsWith(`${name}=`));
  return values.length === 1 ? values[0]!.slice(name.length + 1) : null;
}

export function sessionCookie(token: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export const clearCookie = (name: string) => `${name}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;

export async function createSession(
  store: ControlStore, random: Random, input: Readonly<{ ownerId: OwnerId; identity: ProviderIdentity; expiresAtMs: number }>,
): Promise<Readonly<{ kind: 'created'; token: string; principal: AuthPrincipal }> | Readonly<{ kind: 'unavailable' }>> {
  const token = randomToken(random, 32);
  const expiresAt = new Date(input.expiresAtMs).toISOString();
  const value: SessionRecord = {
    v: 1,
    ownerId: input.ownerId,
    providerIssuer: input.identity.issuer,
    providerSubject: input.identity.subject,
    verifiedEmail: input.identity.verifiedEmail,
    expiresAt,
    revoked: false,
  };
  const principal = principalOf(value);
  if (!principal) return { kind: 'unavailable' };
  const write = await settleWrite(store, {
    key: sessionKey(token), expectedRevision: null, operationId: `auth.session.create.${derive('session', token)}`,
    next: { value, expiresAt },
  });
  return write.kind === 'applied' ? { kind: 'created', token, principal } : { kind: 'unavailable' };
}

export async function lookupSession(store: ControlStore, cookieHeader: string | null, nowMs: number): Promise<SessionLookup> {
  const token = readCookie(cookieHeader, SESSION_COOKIE);
  if (token === null || !TOKEN.test(token)) return { kind: 'signed_out' };
  const read = await store.read<SessionRecord>(sessionKey(token));
  if (read.kind === 'unavailable') return { kind: 'unavailable' };
  if (read.kind === 'absent') return { kind: 'signed_out' };
  const session = read.record.value;
  // A record that no longer decodes is corrupt state, not a signed-out user.
  const principal = principalOf(session);
  if (!principal || typeof session.revoked !== 'boolean') return { kind: 'unavailable' };
  // The store enforces expiry too; checking here keeps an adapter clock skew from extending a session.
  if (session.revoked || !(nowMs < Date.parse(session.expiresAt))) return { kind: 'signed_out' };
  return { kind: 'authenticated', principal, token, record: read.record };
}

/**
 * Revokes the session. `operationId` names this revocation: a retry after a lost
 * response resolves to the same write, and an already revoked or expired session
 * is success. The caller's ID is scoped to this session before it reaches the
 * store, so an ID reused across sessions, or chosen by someone else, never
 * collides with another write.
 */
export async function revokeSession(
  store: ControlStore, token: string, callerOperationId: string,
): Promise<Readonly<{ kind: 'revoked' }> | Readonly<{ kind: 'unavailable' }> | Readonly<{ kind: 'outcome_unknown' }>> {
  const key = sessionKey(token);
  const operationId = `auth.session.revoke.${derive('session', token)}.${createHash('sha256').update(callerOperationId).digest('hex')}`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const read = await store.read<SessionRecord>(key);
    if (read.kind === 'unavailable') return { kind: 'unavailable' };
    if (read.kind === 'absent' || read.record.value.revoked) return { kind: 'revoked' };
    const next = { value: { ...read.record.value, revoked: true }, expiresAt: read.record.expiresAt };
    const write = await store.compareAndSet({ key, expectedRevision: read.record.revision, operationId, next });
    if (write.kind === 'applied') return { kind: 'revoked' };
    if (write.kind === 'unavailable') return { kind: 'unavailable' };
    if (write.kind === 'operation_mismatch') return { kind: 'outcome_unknown' };
    if (write.kind === 'outcome_unknown') {
      const resolved = await store.resolve({ key, operationId });
      if (resolved.kind === 'applied') return { kind: 'revoked' };
      if (resolved.kind !== 'not_applied') return { kind: 'outcome_unknown' };
    }
    // Conflict or proven not applied: re-read and try again with the same operation.
  }
  return { kind: 'outcome_unknown' };
}

function principalOf(session: SessionRecord): AuthPrincipal | null {
  if (typeof session !== 'object' || session === null) return null;
  const decoded = decodeAuthPrincipal({
    v: 1,
    ownerId: session.ownerId,
    providerIssuer: session.providerIssuer,
    providerSubject: session.providerSubject,
    verifiedEmail: session.verifiedEmail,
    sessionExpiresAt: session.expiresAt,
  });
  return decoded.ok ? decoded.value : null;
}
