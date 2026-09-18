import { describe, expect, it } from 'vitest';
import { CSRF_HEADER } from './index';
import { readCookie } from './sessions';
import { ORIGIN, harness, request, signIn } from './support.test';

async function signedIn() {
  const h = harness();
  const { cookies, result } = await signIn(h);
  const auth = await h.service.authenticateRequest(request('/api/human/me', { cookies }));
  if (auth.kind !== 'authenticated') throw new Error('not authenticated');
  return { h, cookies, principal: result.principal, csrf: auth.context.csrfToken };
}

const mutation = (cookies: string[], headers: Record<string, string>) =>
  request('/api/human/chats', { method: 'POST', cookies, headers: { origin: ORIGIN, ...headers }, body: '{}' });

describe('authenticateRequest', () => {
  it('returns the principal and a session-bound CSRF token', async () => {
    const { principal, csrf } = await signedIn();
    expect(principal.sessionExpiresAt).toBe('2026-09-17T20:00:00.000Z');
    expect(csrf).toMatch(/^[0-9a-f]{64}$/);
  });

  it('treats a missing, malformed or unknown session as signed out', async () => {
    const h = harness();
    expect(await h.service.authenticateRequest(request('/'))).toEqual({ kind: 'signed_out' });
    expect(await h.service.authenticateRequest(request('/', { cookies: ['__Host-khala_session=short'] }))).toEqual({ kind: 'signed_out' });
    expect(await h.service.authenticateRequest(request('/', { cookies: [`__Host-khala_session=${'A'.repeat(43)}`] }))).toEqual({ kind: 'signed_out' });
  });

  it('treats an expired session as signed out', async () => {
    const { h, cookies } = await signedIn();
    h.advance(8 * 3600_000);
    expect(await h.service.authenticateRequest(request('/', { cookies }))).toEqual({ kind: 'signed_out' });
  });

  // Expiry is enforced twice, and each layer must hold when the other does not.
  it('expires the session in the store even when the record value claims it is still valid', async () => {
    const { h, cookies, principal } = await signedIn();
    const key = h.store.keys('auth.session.')[0]!;
    const record = h.store.records.get(key)!;
    expect(record.expiresAt).toBe(principal.sessionExpiresAt);
    h.store.records.set(key, { ...record, value: { ...(record.value as object), expiresAt: '2099-01-01T00:00:00.000Z' } });
    h.advance(8 * 3600_000);
    expect(await h.service.authenticateRequest(request('/', { cookies }))).toEqual({ kind: 'signed_out' });
  });

  it('expires the session in the module even when the store still serves the record', async () => {
    const { h, cookies } = await signedIn();
    const key = h.store.keys('auth.session.')[0]!;
    // A store whose clock lags keeps the record live past the session's expiry.
    h.store.records.set(key, { ...h.store.records.get(key)!, expiresAt: '2099-01-01T00:00:00.000Z' });
    h.advance(8 * 3600_000 - 1);
    expect((await h.service.authenticateRequest(request('/', { cookies }))).kind).toBe('authenticated');
    h.advance(1);
    expect(await h.service.authenticateRequest(request('/', { cookies }))).toEqual({ kind: 'signed_out' });
  });

  it('reports a store timeout as unavailable, not signed out', async () => {
    const { h, cookies } = await signedIn();
    h.store.inject('read', 'unavailable');
    expect(await h.service.authenticateRequest(request('/', { cookies }))).toEqual({ kind: 'unavailable' });
    h.store.inject('read', 'throw');
    expect(await h.service.authenticateRequest(request('/', { cookies }))).toEqual({ kind: 'unavailable' });
    expect(JSON.stringify(h.logs)).not.toContain('secret-cookie-value');
  });

  it.each([
    ['an unparseable expiry', { expiresAt: 'garbage' }],
    ['a non-boolean revoked flag', { revoked: 'yes' }],
    ['a non-object value', null],
  ])('reports a session record with %s as unavailable, not signed out', async (_name, patch) => {
    const { h, cookies } = await signedIn();
    const key = h.store.keys('auth.session.')[0]!;
    const record = h.store.records.get(key)!;
    h.store.records.set(key, { ...record, value: patch === null ? 'corrupt' : { ...(record.value as object), ...patch } });
    expect(await h.service.authenticateRequest(request('/', { cookies }))).toEqual({ kind: 'unavailable' });
  });

  it('refuses an ambiguous duplicated session cookie', async () => {
    const { h, cookies } = await signedIn();
    expect(await h.service.authenticateRequest(request('/', { cookies: [...cookies, `__Host-khala_session=${'B'.repeat(43)}`] })))
      .toEqual({ kind: 'signed_out' });
    expect(readCookie('a=1; b=2', 'b')).toBe('2');
  });
});

describe('requireHumanMutation', () => {
  it('authorizes a same-origin request with the session CSRF token', async () => {
    const { h, cookies, csrf, principal } = await signedIn();
    const result = await h.service.requireHumanMutation(mutation(cookies, { [CSRF_HEADER]: csrf, 'sec-fetch-site': 'same-origin' }));
    expect(result).toEqual({ kind: 'authorized', context: { principal, csrfToken: csrf } });
  });

  it('ignores a forged ownerId in the body', async () => {
    const { h, cookies, csrf, principal } = await signedIn();
    const forged = request('/api/human/chats', {
      method: 'POST', cookies, headers: { origin: ORIGIN, [CSRF_HEADER]: csrf }, body: JSON.stringify({ ownerId: 'own_victim' }),
    });
    const result = await h.service.requireHumanMutation(forged);
    expect(result.kind === 'authorized' && result.context.principal.ownerId).toBe(principal.ownerId);
  });

  it.each([
    ['missing Origin', {}],
    ['another origin', { origin: 'https://evil.example' }],
    ['a preview origin', { origin: 'https://preview.khala.aiur.team' }],
    ['the http origin', { origin: 'http://khala.aiur.team' }],
    // These two keep a valid Origin, so only the fetch metadata check can refuse them.
    ['cross-site fetch metadata', { origin: ORIGIN, 'sec-fetch-site': 'cross-site' }],
    ['same-site fetch metadata', { origin: ORIGIN, 'sec-fetch-site': 'same-site' }],
  ])('rejects %s', async (name, headers) => {
    const { h, cookies, csrf } = await signedIn();
    const init = { method: 'POST', cookies, headers: { origin: ORIGIN, [CSRF_HEADER]: csrf, ...headers } };
    if (name === 'missing Origin') delete (init.headers as Record<string, string>).origin;
    expect(await h.service.requireHumanMutation(request('/api/human/chats', init))).toEqual({ kind: 'rejected', code: 'forbidden_origin' });
  });

  it('rejects a missing or mismatched CSRF token', async () => {
    const { h, cookies, csrf } = await signedIn();
    expect(await h.service.requireHumanMutation(mutation(cookies, {}))).toEqual({ kind: 'rejected', code: 'csrf_mismatch' });
    const wrong = csrf.replace(/.$/, c => (c === '0' ? '1' : '0'));
    expect(await h.service.requireHumanMutation(mutation(cookies, { [CSRF_HEADER]: wrong }))).toEqual({ kind: 'rejected', code: 'csrf_mismatch' });
  });

  it('rejects another session\'s CSRF token', async () => {
    const { h, cookies } = await signedIn();
    const other = await signIn(h, 'user-2', 'bob@example.test');
    const otherAuth = await h.service.authenticateRequest(request('/', { cookies: other.cookies }));
    const otherCsrf = otherAuth.kind === 'authenticated' ? otherAuth.context.csrfToken : '';
    expect(await h.service.requireHumanMutation(mutation(cookies, { [CSRF_HEADER]: otherCsrf }))).toEqual({ kind: 'rejected', code: 'csrf_mismatch' });
  });

  it('rejects safe methods, which must never mutate', async () => {
    const { h, cookies, csrf } = await signedIn();
    const get = request('/api/human/chats', { cookies, headers: { origin: ORIGIN, [CSRF_HEADER]: csrf } });
    expect(await h.service.requireHumanMutation(get)).toEqual({ kind: 'rejected', code: 'not_a_mutation' });
  });

  it('distinguishes signed out from unavailable', async () => {
    const { h, cookies, csrf } = await signedIn();
    expect(await h.service.requireHumanMutation(mutation([], { [CSRF_HEADER]: csrf }))).toEqual({ kind: 'rejected', code: 'signed_out' });
    h.store.inject('read', 'unavailable');
    expect(await h.service.requireHumanMutation(mutation(cookies, { [CSRF_HEADER]: csrf }))).toEqual({ kind: 'unavailable' });
  });
});

describe('signOut', () => {
  it('revokes the session so later requests are signed out', async () => {
    const { h, cookies, csrf } = await signedIn();
    const result = await h.service.signOut(mutation(cookies, { [CSRF_HEADER]: csrf }), 'op-logout-1');
    expect(result).toEqual({ kind: 'signed_out', cookies: ['__Host-khala_session=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0'] });
    expect(await h.service.authenticateRequest(request('/', { cookies }))).toEqual({ kind: 'signed_out' });
  });

  it('resolves a retry after a lost write response to the same revocation', async () => {
    const { h, cookies, csrf } = await signedIn();
    h.store.inject('compareAndSet', 'lose_response');
    h.store.inject('resolve', 'unavailable');
    const lost = await h.service.signOut(mutation(cookies, { [CSRF_HEADER]: csrf }), 'op-logout-2');
    expect(lost).toEqual({ kind: 'outcome_unknown', operationId: 'op-logout-2' });
    const retry = await h.service.signOut(mutation(cookies, { [CSRF_HEADER]: csrf }), 'op-logout-2');
    expect(retry.kind).toBe('signed_out');
    const writes = [...h.store.records.values()].filter(record => record.key.startsWith('auth.session.'));
    expect(writes).toHaveLength(1);
    expect(writes[0]!.operationId).toMatch(/^auth\.session\.revoke\./);
  });

  it('revokes even when the caller reuses an operation ID from another session', async () => {
    const { h, cookies, csrf } = await signedIn();
    expect((await h.service.signOut(mutation(cookies, { [CSRF_HEADER]: csrf }), 'logout')).kind).toBe('signed_out');
    const second = await signIn(h, 'user-1', 'ada@example.test');
    const auth = await h.service.authenticateRequest(request('/', { cookies: second.cookies }));
    const secondCsrf = auth.kind === 'authenticated' ? auth.context.csrfToken : '';
    expect((await h.service.signOut(mutation(second.cookies, { [CSRF_HEADER]: secondCsrf }), 'logout')).kind).toBe('signed_out');
    expect(await h.service.authenticateRequest(request('/', { cookies: second.cookies }))).toEqual({ kind: 'signed_out' });
  });

  it('settles a lost response within one call when the store can resolve it', async () => {
    const { h, cookies, csrf } = await signedIn();
    h.store.inject('compareAndSet', 'lose_response');
    expect((await h.service.signOut(mutation(cookies, { [CSRF_HEADER]: csrf }), 'op-logout-3')).kind).toBe('signed_out');
  });

  it('refuses a cross-origin or CSRF-less logout and leaves the session active', async () => {
    const { h, cookies, csrf } = await signedIn();
    const crossSite = request('/api/human/auth/logout', { method: 'POST', cookies, headers: { origin: 'https://evil.example', [CSRF_HEADER]: csrf } });
    expect(await h.service.signOut(crossSite, 'op')).toEqual({ kind: 'rejected', code: 'forbidden_origin' });
    expect(await h.service.signOut(mutation(cookies, {}), 'op')).toEqual({ kind: 'rejected', code: 'csrf_mismatch' });
    expect((await h.service.authenticateRequest(request('/', { cookies }))).kind).toBe('authenticated');
  });

  it('reports a store outage as unavailable and keeps the session', async () => {
    const { h, cookies, csrf } = await signedIn();
    h.store.inject('read', 'unavailable');
    expect(await h.service.signOut(mutation(cookies, { [CSRF_HEADER]: csrf }), 'op')).toEqual({ kind: 'unavailable' });
    expect((await h.service.authenticateRequest(request('/', { cookies }))).kind).toBe('authenticated');
  });
});
