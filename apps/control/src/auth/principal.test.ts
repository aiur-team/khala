import { describe, expect, it } from 'vitest';
import { decodeOwnerId } from '@khala/contracts/messaging/index';
import { checkClaims, ownerKey, resolveOwner } from './principal';
import { CLIENT_ID, ISSUER, T0, fakeStore, harness, request, secureRandom, signIn } from './support.test';

const NONCE = 'n'.repeat(43);
const valid = { iss: ISSUER, aud: CLIENT_ID, sub: 'user-1', email: 'ada@example.test', email_verified: true, exp: T0 / 1000 + 60, nonce: NONCE };
const expected = { issuer: ISSUER, clientId: CLIENT_ID, nonce: NONCE, nowMs: T0 };

describe('checkClaims', () => {
  it('accepts a verified identity and keeps identifiers byte-exact', () => {
    const result = checkClaims({ ...valid, sub: ' Mixed-Case ' }, expected);
    expect(result).toEqual({ ok: true, identity: { issuer: ISSUER, subject: ' Mixed-Case ', verifiedEmail: 'ada@example.test' } });
  });

  it.each([
    ['unverified boolean', { email_verified: false }, 'email_unverified'],
    ['string "true"', { email_verified: 'true' }, 'email_unverified'],
    ['missing email_verified', { email_verified: undefined }, 'email_unverified'],
    ['missing subject', { sub: undefined }, 'invalid_subject'],
    ['empty subject', { sub: '' }, 'invalid_subject'],
    ['control character in subject', { sub: 'a\u0000b' }, 'invalid_subject'],
    ['C1 control in subject', { sub: 'user\u0085x' }, 'invalid_subject'],
    ['lone surrogate in email', { email: 'a\ud800@example.test' }, 'invalid_email'],
    ['wrong issuer', { iss: 'https://evil.example.test' }, 'wrong_issuer'],
    ['issuer with trailing slash', { iss: `${ISSUER}/` }, 'wrong_issuer'],
    ['wrong audience', { aud: 'other-client' }, 'wrong_audience'],
    ['multi-audience without azp', { aud: [CLIENT_ID, 'other'] }, 'wrong_audience'],
    ['expired', { exp: T0 / 1000 }, 'expired'],
    ['missing exp', { exp: undefined }, 'expired'],
    ['string exp', { exp: String(T0 / 1000 + 60) }, 'expired'],
    ['another login\'s nonce', { nonce: 'm'.repeat(43) }, 'nonce_mismatch'],
    ['missing nonce', { nonce: undefined }, 'nonce_mismatch'],
    ['nonce prefix', { nonce: NONCE.slice(1) }, 'nonce_mismatch'],
    ['non-email email', { email: 'not-an-email' }, 'invalid_email'],
    ['missing email', { email: undefined }, 'invalid_email'],
  ])('rejects %s', (_name, override, code) => {
    expect(checkClaims({ ...valid, ...override }, expected)).toEqual({ ok: false, code });
  });

  it('accepts a multi-audience token whose azp is this client', () => {
    expect(checkClaims({ ...valid, aud: [CLIENT_ID, 'other'], azp: CLIENT_ID }, expected).ok).toBe(true);
  });
});

describe('owner mapping', () => {
  it('covers AE1: repeated login keeps the owner through an email change', async () => {
    const h = harness();
    const first = await signIn(h, 'user-1', 'ada@example.test');
    const second = await signIn(h, 'user-1', 'ada.lovelace@example.test');
    expect(second.result.principal.ownerId).toBe(first.result.principal.ownerId);
    expect(second.result.principal.verifiedEmail).toBe('ada.lovelace@example.test');
    expect(h.store.keys('auth.owner.')).toHaveLength(1);
    expect(h.store.keys('auth.mapping.')).toHaveLength(1);
    expect(h.messaging.accounts.size).toBe(1);
  });

  it('keeps the same verified email at another issuer as a distinct owner', async () => {
    const store = fakeStore(() => T0).store;
    const a = await resolveOwner(store, secureRandom, { issuer: ISSUER, subject: 's', verifiedEmail: 'ada@example.test' });
    const b = await resolveOwner(store, secureRandom, { issuer: 'https://other.example.test', subject: 's', verifiedEmail: 'ada@example.test' });
    expect(a.kind === 'owner' && b.kind === 'owner' && a.ownerId !== b.ownerId).toBe(true);
  });

  it('never uses the email as, or inside, the owner key', async () => {
    const h = harness();
    const { result } = await signIn(h, 'user-1', 'ada@example.test');
    expect(result.principal.ownerId).not.toContain('@');
    expect(ownerKey({ issuer: ISSUER, subject: 'user-1' })).not.toContain('ada');
    for (const record of h.store.records.values()) {
      if (record.key.startsWith('auth.owner.')) expect(JSON.stringify(record.value)).not.toContain('ada@');
    }
  });

  it('converges concurrent first sign-ins on one owner', async () => {
    const store = fakeStore(() => T0).store;
    const identity = { issuer: ISSUER, subject: 'racer', verifiedEmail: 'r@example.test' };
    const results = await Promise.all([1, 2, 3, 4].map(() => resolveOwner(store, secureRandom, identity)));
    const owners = new Set(results.map(result => (result.kind === 'owner' ? result.ownerId : 'none')));
    expect(owners.size).toBe(1);
    expect(owners.has('none')).toBe(false);
  });

  it('reports a store outage as unavailable, not a new owner', async () => {
    const fake = fakeStore(() => T0);
    fake.inject('read', 'unavailable');
    expect(await resolveOwner(fake.store, secureRandom, { issuer: ISSUER, subject: 's', verifiedEmail: 'a@b.c' })).toEqual({ kind: 'unavailable' });
    expect(fake.records.size).toBe(0);
  });

  it('adopts an owner create whose response was lost', async () => {
    const fake = fakeStore(() => T0);
    fake.inject('compareAndSet', 'lose_response');
    const identity = { issuer: ISSUER, subject: 's', verifiedEmail: 'a@b.c' };
    const first = await resolveOwner(fake.store, secureRandom, identity);
    const again = await resolveOwner(fake.store, secureRandom, identity);
    expect(first).toEqual(again);
    expect(fake.keys('auth.owner.')).toHaveLength(1);
  });

  it.each([
    ['another issuer', { issuer: 'https://other.example.test' }],
    ['another subject', { subject: 'user-2' }],
    ['an empty owner ID', { ownerId: '' }],
  ])('treats an owner record naming %s as corrupt, never as that owner', async (_name, change) => {
    const fake = fakeStore(() => T0);
    const identity = { issuer: ISSUER, subject: 'user-1', verifiedEmail: 'ada@example.test' };
    const value = { v: 1, ownerId: 'own_planted', issuer: ISSUER, subject: 'user-1', ...change };
    expect(decodeOwnerId('own_planted').ok).toBe(true);
    await fake.store.compareAndSet({ key: ownerKey(identity), expectedRevision: null, operationId: 'plant', next: { value, expiresAt: null } });
    expect(await resolveOwner(fake.store, secureRandom, identity)).toEqual({ kind: 'unavailable' });
  });

  it('fails a bad claim without creating a session', async () => {
    const h = harness();
    h.oidc.signInAs('user-1', 'ada@example.test', { email_verified: 'true' });
    const started = await h.service.startSignIn('/');
    if (started.kind !== 'redirect') throw new Error('not started');
    const state = new URL(started.location).searchParams.get('state')!;
    const result = await h.service.completeSignIn(request(`/api/human/auth/callback?code=c&state=${state}`, {
      cookies: started.cookies.map(cookie => cookie.split(';')[0]!),
    }));
    expect(result).toMatchObject({ kind: 'rejected', code: 'email_unverified' });
    expect(h.store.keys('auth.session.')).toHaveLength(0);
    expect(h.store.keys('auth.owner.')).toHaveLength(0);
  });

  it('refuses a subject the contract principal cannot carry before provisioning anything', async () => {
    const h = harness();
    h.oidc.signInAs('user\u0085x', 'ada@example.test');
    const started = await h.service.startSignIn('/');
    if (started.kind !== 'redirect') throw new Error('not started');
    const state = new URL(started.location).searchParams.get('state')!;
    const result = await h.service.completeSignIn(request(`/api/human/auth/callback?code=c&state=${state}`, {
      cookies: started.cookies.map(cookie => cookie.split(';')[0]!),
    }));
    expect(result).toMatchObject({ kind: 'rejected', code: 'invalid_subject' });
    expect(h.store.keys('auth.owner.')).toHaveLength(0);
    expect(h.messaging.accounts.size).toBe(0);
  });
});
