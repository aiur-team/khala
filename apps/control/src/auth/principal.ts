// Claims → provider identity → stable owner. Ownership is keyed by issuer and
// subject only: an email change keeps the owner, and the same email at another
// issuer is another owner. There is no account linking.

import { createHash } from 'node:crypto';
import {
  type ControlStore, type OwnerId, MAX_IDENTIFIER_BYTES, decodeAuthPrincipal, decodeOwnerId,
} from '@khala/contracts/messaging/index';
import { safeEqual } from './csrf';
import { type Random, randomToken, settleWrite } from './store';

export type ProviderIdentity = Readonly<{ issuer: string; subject: string; verifiedEmail: string }>;

export type ClaimRejection =
  | 'wrong_issuer' | 'wrong_audience' | 'expired' | 'nonce_mismatch' | 'invalid_subject' | 'email_unverified' | 'invalid_email';

export type ClaimCheck =
  | Readonly<{ ok: true; identity: ProviderIdentity }>
  | Readonly<{ ok: false; code: ClaimRejection }>;

const EMAIL = /^[^\s@]+@[^\s@]+$/;
// Printable, bounded identifiers only; never trimmed or normalised.
const CONTROL = /[\u0000-\u001f\u007f]/;

const isIdentifier = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && !CONTROL.test(value) && Buffer.byteLength(value) <= MAX_IDENTIFIER_BYTES;

/**
 * Re-checks the claims Khala relies on, after the maintained client has validated
 * the token. `email_verified` must be the boolean `true`; the string "true" fails.
 * The nonce is checked again here as defence in depth, so an adapter that skips
 * its own nonce check still cannot complete another browser's sign-in.
 */
export function checkClaims(
  claims: Readonly<Record<string, unknown>>,
  expected: Readonly<{ issuer: string; clientId: string; nonce: string; nowMs: number }>,
): ClaimCheck {
  if (claims.iss !== expected.issuer) return { ok: false, code: 'wrong_issuer' };
  const audience = claims.aud;
  const audiences = typeof audience === 'string' ? [audience] : Array.isArray(audience) ? audience : [];
  if (!audiences.includes(expected.clientId)) return { ok: false, code: 'wrong_audience' };
  // With several audiences the token must name this client as its authorised party.
  if (audiences.length > 1 && claims.azp !== expected.clientId) return { ok: false, code: 'wrong_audience' };
  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp * 1000 <= expected.nowMs) {
    return { ok: false, code: 'expired' };
  }
  if (typeof claims.nonce !== 'string' || !safeEqual(claims.nonce, expected.nonce)) return { ok: false, code: 'nonce_mismatch' };
  if (!isIdentifier(claims.sub)) return { ok: false, code: 'invalid_subject' };
  if (claims.email_verified !== true) return { ok: false, code: 'email_unverified' };
  if (!isIdentifier(claims.email) || !EMAIL.test(claims.email)) return { ok: false, code: 'invalid_email' };
  // Anything the contract principal decoder would refuse later (C1 controls, lone
  // surrogates) is refused here, before an owner or account is provisioned.
  const probe = decodeAuthPrincipal({
    v: 1, ownerId: 'own_probe', providerIssuer: expected.issuer, providerSubject: claims.sub, verifiedEmail: claims.email,
    sessionExpiresAt: new Date(expected.nowMs).toISOString(),
  });
  if (!probe.ok) return { ok: false, code: probe.error.path.endsWith('verifiedEmail') ? 'invalid_email' : 'invalid_subject' };
  return { ok: true, identity: { issuer: expected.issuer, subject: claims.sub, verifiedEmail: claims.email } };
}

type OwnerRecord = { v: 1; ownerId: string; issuer: string; subject: string };

/** Store key for an issuer/subject pair. Hashed so any identifier length fits the key limit. */
export function ownerKey(identity: Pick<ProviderIdentity, 'issuer' | 'subject'>): string {
  return `auth.owner.v1.${createHash('sha256').update(JSON.stringify([identity.issuer, identity.subject])).digest('hex')}`;
}

export type OwnerResolution =
  | Readonly<{ kind: 'owner'; ownerId: OwnerId }>
  | Readonly<{ kind: 'unavailable' }>;

/**
 * Returns the owner for this issuer/subject, creating it on first sign-in.
 * Concurrent first sign-ins converge: exactly one create applies and the others
 * read it back.
 */
export async function resolveOwner(store: ControlStore, random: Random, identity: ProviderIdentity): Promise<OwnerResolution> {
  const key = ownerKey(identity);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await store.read<OwnerRecord>(key);
    if (current.kind === 'unavailable') return { kind: 'unavailable' };
    if (current.kind === 'record') return ownerFrom(current.record.value, identity);
    const value: OwnerRecord = { v: 1, ownerId: `own_${randomToken(random, 18)}`, issuer: identity.issuer, subject: identity.subject };
    const write = await settleWrite(store, {
      key, expectedRevision: null, operationId: `auth.owner.create.${randomToken(random, 18)}`, next: { value, expiresAt: null },
    });
    if (write.kind === 'applied') return ownerFrom(write.record.value, identity);
    if (write.kind !== 'conflict') return { kind: 'unavailable' };
    // Lost the create race: loop and read the winner.
  }
  return { kind: 'unavailable' };
}

function ownerFrom(record: OwnerRecord, identity: ProviderIdentity): OwnerResolution {
  const decoded = decodeOwnerId(record.ownerId);
  // A record that disagrees with its own key is corrupt, never a different owner.
  if (!decoded.ok || record.issuer !== identity.issuer || record.subject !== identity.subject) return { kind: 'unavailable' };
  return { kind: 'owner', ownerId: decoded.value };
}
