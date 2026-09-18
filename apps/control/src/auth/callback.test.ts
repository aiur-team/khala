import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ORIGIN, beginAndReturn, cookiePairs, harness, request, signIn } from './support.test';

describe('startSignIn', () => {
  it('binds the code flow to state, nonce and S256 PKCE on the exact callback', async () => {
    const h = harness();
    const started = await h.service.startSignIn('/chats?x=1');
    expect(started.kind).toBe('redirect');
    const issued = h.oidc.issued[0]!;
    expect(issued.redirectUri).toBe('https://khala.aiur.team/api/human/auth/callback');
    expect(issued.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued.nonce).not.toBe(issued.state);
    // The verifier never leaves the server; only its S256 challenge does.
    const login = [...h.store.records.values()].find(record => record.key.startsWith('auth.login.'))!;
    const verifier = (login.value as { codeVerifier: string }).codeVerifier;
    expect(issued.codeChallenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
    expect(started.kind === 'redirect' && started.location).not.toContain(verifier);
  });

  it('sets a host-only, Secure, HttpOnly login cookie whose value is not the store key', async () => {
    const h = harness();
    const started = await h.service.startSignIn('/');
    if (started.kind !== 'redirect') throw new Error('not started');
    const cookie = started.cookies[0]!;
    expect(cookie).toMatch(/^__Host-khala_login=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=600$/);
    const handle = cookie.split(';')[0]!.split('=')[1]!;
    expect([...h.store.records.keys()].some(key => key.includes(handle))).toBe(false);
  });

  it.each(['//evil.example', 'https://evil.example/', '/\\evil.example', 'relative', '/a\nb', ''])('rejects return path %j', async path => {
    const h = harness();
    expect(await h.service.startSignIn(path)).toEqual({ kind: 'rejected', code: 'invalid_return_path' });
    expect(h.store.records.size).toBe(0);
  });

  it('reports a store outage as unavailable without contacting the provider', async () => {
    const h = harness();
    h.store.inject('compareAndSet', 'unavailable');
    expect(await h.service.startSignIn('/')).toEqual({ kind: 'unavailable' });
    expect(h.oidc.issued).toHaveLength(0);
  });
});

describe('completeSignIn', () => {
  it('mints a Secure HttpOnly host-only session and returns to the stored path', async () => {
    const h = harness();
    const { result } = await signIn(h);
    expect(result.location).toBe('/chats');
    expect(result.cookies[0]).toMatch(/^__Host-khala_session=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=28800$/);
    expect(result.cookies[1]).toBe('__Host-khala_login=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0');
    expect(result.principal).toMatchObject({ v: 1, providerSubject: 'user-1', verifiedEmail: 'ada@example.test' });
  });

  it('stores only hashes of session tokens', async () => {
    const h = harness();
    const { cookies } = await signIn(h);
    const token = cookies[0]!.split('=')[1]!;
    for (const record of h.store.records.values()) {
      expect(record.key).not.toContain(token);
      expect(JSON.stringify(record.value)).not.toContain(token);
    }
  });

  it('covers AE2: a sequential callback replay creates no second session', async () => {
    const h = harness();
    h.oidc.signInAs('user-1', 'ada@example.test');
    const callback = await beginAndReturn(h);
    const first = await h.service.completeSignIn(callback.clone());
    const replay = await h.service.completeSignIn(callback.clone());
    expect(first.kind).toBe('signed_in');
    expect(replay).toMatchObject({ kind: 'rejected', code: 'login_replayed' });
    expect(h.store.keys('auth.session.')).toHaveLength(1);
    expect(h.oidc.exchanges).toHaveLength(1);
  });

  it('covers AE2: simultaneous callback replays yield at most one session', async () => {
    const h = harness();
    h.oidc.signInAs('user-1', 'ada@example.test');
    const callback = await beginAndReturn(h);
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => h.service.completeSignIn(callback.clone())));
    expect(results.filter(result => result.kind === 'signed_in')).toHaveLength(1);
    expect(results.filter(result => result.kind === 'rejected' && result.code === 'login_replayed')).toHaveLength(4);
    expect(h.store.keys('auth.session.')).toHaveLength(1);
    expect(h.oidc.exchanges).toHaveLength(1);
  });

  it('rejects a callback without the login cookie that began it', async () => {
    const h = harness();
    h.oidc.signInAs('user-1', 'ada@example.test');
    const callback = await beginAndReturn(h);
    const stripped = request(callback.url);
    expect(await h.service.completeSignIn(stripped)).toMatchObject({ kind: 'rejected', code: 'login_expired' });
    expect(h.oidc.exchanges).toHaveLength(0);
  });

  it('rejects a mismatched state without consuming the login', async () => {
    const h = harness();
    h.oidc.signInAs('user-1', 'ada@example.test');
    const callback = await beginAndReturn(h);
    const forged = request('/api/human/auth/callback?code=attacker&state=forged', { cookies: [callback.headers.get('cookie')!] });
    // A forged callback must not clear the login cookie of the sign-in in progress.
    expect(await h.service.completeSignIn(forged)).toEqual({ kind: 'rejected', code: 'state_mismatch', cookies: [] });
    expect((await h.service.completeSignIn(callback)).kind).toBe('signed_in');
  });

  it('rejects a callback delivered to another path or origin', async () => {
    const h = harness();
    h.oidc.signInAs('user-1', 'ada@example.test');
    const callback = await beginAndReturn(h);
    const state = new URL(callback.url).searchParams.get('state')!;
    const elsewhere = new Request(`https://preview.khala.aiur.team/api/human/auth/callback?code=c&state=${state}`, { headers: callback.headers });
    expect(await h.service.completeSignIn(elsewhere)).toMatchObject({ kind: 'rejected', code: 'state_mismatch' });
  });

  it('expires an abandoned login', async () => {
    const h = harness();
    h.oidc.signInAs('user-1', 'ada@example.test');
    const callback = await beginAndReturn(h);
    h.advance(600_000);
    expect(await h.service.completeSignIn(callback)).toMatchObject({ kind: 'rejected', code: 'login_expired' });
  });

  it('maps provider refusal and invalid responses to rejections, not sessions', async () => {
    const h = harness();
    h.oidc.failNext({ kind: 'rejected', code: 'denied' });
    expect(await h.service.completeSignIn(await beginAndReturn(h))).toMatchObject({ kind: 'rejected', code: 'provider_denied' });
    h.oidc.failNext({ kind: 'rejected', code: 'invalid_response' });
    expect(await h.service.completeSignIn(await beginAndReturn(h))).toMatchObject({ kind: 'rejected', code: 'invalid_response' });
    expect(h.store.keys('auth.session.')).toHaveLength(0);
  });

  it('reports provider and store outages as unavailable, never signed in or out', async () => {
    const h = harness();
    h.oidc.signInAs('user-1', 'ada@example.test');
    h.oidc.failNext('throw');
    expect(await h.service.completeSignIn(await beginAndReturn(h))).toMatchObject({ kind: 'unavailable' });

    const callback = await beginAndReturn(h);
    h.store.inject('read', 'unavailable');
    // The login binding survives a read outage, so the same callback can still complete.
    expect(await h.service.completeSignIn(callback.clone())).toEqual({ kind: 'unavailable', cookies: [] });
    expect((await h.service.completeSignIn(callback.clone())).kind).toBe('signed_in');
  });

  it('settles a consume whose response was lost', async () => {
    const h = harness();
    h.oidc.signInAs('user-1', 'ada@example.test');
    const callback = await beginAndReturn(h);
    h.store.inject('compareAndSet', 'lose_response');
    expect((await h.service.completeSignIn(callback)).kind).toBe('signed_in');
  });

  it('mints no session while messaging provisioning is unavailable', async () => {
    const h = harness();
    h.oidc.signInAs('user-1', 'ada@example.test');
    h.messaging.inject('lookup', 'unavailable');
    const result = await h.service.completeSignIn(await beginAndReturn(h));
    expect(result).toMatchObject({ kind: 'unavailable' });
    expect(result.cookies.some(cookie => cookie.startsWith('__Host-khala_session='))).toBe(false);
    expect(h.store.keys('auth.session.')).toHaveLength(0);
    // The next sign-in resumes the pending mapping.
    expect((await signIn(h)).result.kind).toBe('signed_in');
    expect(h.messaging.accounts.size).toBe(1);
  });

  it('carries no token, claim or provider detail in results or diagnostics', async () => {
    const h = harness();
    h.oidc.signInAs('user-1', 'ada@example.test');
    h.oidc.failNext('throw');
    const result = await h.service.completeSignIn(await beginAndReturn(h));
    const text = JSON.stringify([result, h.logs]);
    expect(text).not.toMatch(/eyJ|exploded|code-1|ada@/);
    expect(h.logs).toEqual([{ event: 'callback', code: 'unavailable', requestId: null }]);
  });

  it('returns to the stored path, never one supplied on the callback', async () => {
    const h = harness();
    h.oidc.signInAs('user-1', 'ada@example.test');
    const callback = await beginAndReturn(h, '/chats/1');
    const tampered = new Request(`${callback.url}&return_to=${encodeURIComponent('https://evil.example')}`, { headers: callback.headers });
    const result = await h.service.completeSignIn(tampered);
    expect(result).toMatchObject({ kind: 'signed_in', location: '/chats/1' });
    expect(cookiePairs(result.cookies)).toHaveLength(1);
    expect(new URL(result.kind === 'signed_in' ? result.location : '/', ORIGIN).origin).toBe(ORIGIN);
  });

  it('refuses an ID token carrying another login\'s nonce even if the adapter let it through', async () => {
    const h = harness();
    h.oidc.signInAs('user-1', 'ada@example.test', { nonce: 'n'.repeat(43) });
    const result = await h.service.completeSignIn(await beginAndReturn(h));
    expect(result).toMatchObject({ kind: 'rejected', code: 'nonce_mismatch' });
    expect(h.store.keys('auth.session.')).toHaveLength(0);
  });

  it('refuses a callback whose state differs only in its last character', async () => {
    const h = harness();
    h.oidc.signInAs('user-1', 'ada@example.test');
    const callback = await beginAndReturn(h);
    const url = new URL(callback.url);
    const state = url.searchParams.get('state')!;
    url.searchParams.set('state', state.slice(0, -1) + (state.endsWith('A') ? 'B' : 'A'));
    const result = await h.service.completeSignIn(new Request(url, { headers: callback.headers }));
    expect(result).toEqual({ kind: 'rejected', code: 'state_mismatch', cookies: [] });
    expect(h.oidc.exchanges).toHaveLength(0);
  });

  it('revokes the browser\'s previous session when it signs in again', async () => {
    const h = harness();
    const first = await signIn(h);
    h.oidc.signInAs('user-1', 'ada@example.test');
    const callback = await beginAndReturn(h);
    const again = new Request(callback.url, { headers: { cookie: [callback.headers.get('cookie'), ...first.cookies].join('; ') } });
    const second = await h.service.completeSignIn(again);
    expect(second.kind).toBe('signed_in');
    expect(await h.service.authenticateRequest(request('/', { cookies: first.cookies }))).toEqual({ kind: 'signed_out' });
    expect((await h.service.authenticateRequest(request('/', { cookies: cookiePairs(second.cookies) }))).kind).toBe('authenticated');
  });
});
