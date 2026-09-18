import { describe, expect, it } from 'vitest';
import { decodeAuthPrincipal } from '@khala/contracts/messaging/index';
import { CSRF_HEADER, createAuthService } from './index';
import { ORIGIN, harness, request, signIn } from './support.test';

describe('createAuthService', () => {
  it.each(['http://khala.aiur.team', 'https://khala.aiur.team/', 'https://khala.aiur.team/app', 'not a url'])('refuses origin %j', origin => {
    expect(() => harness({ origin })).toThrow();
  });

  it('requires explicit lifetimes', () => {
    expect(() => harness({ sessionTtlMs: 0 })).toThrow();
    expect(() => harness({ loginTtlMs: Number.NaN })).toThrow();
  });

  it('exports the factory', () => {
    expect(typeof createAuthService).toBe('function');
  });
});

describe('public principal', () => {
  it('decodes as the contract principal and carries no bearer or key material', async () => {
    const h = harness();
    const { result, cookies } = await signIn(h);
    // Unknown fields would fail the strict contract decoder.
    expect(decodeAuthPrincipal(result.principal).ok).toBe(true);
    const text = JSON.stringify(result.principal);
    const token = cookies[0]!.split('=')[1]!;
    expect(text).not.toContain(token);
    expect(text).not.toMatch(/token|password|secret|key|csrf|accountId|@khala_/i);
  });
});

describe('identityFor', () => {
  it('reports signed_in, then signed_out after signOut', async () => {
    const h = harness();
    const { cookies, result } = await signIn(h);
    const current = await h.service.identityFor(request('/', { cookies })).current();
    expect(current).toEqual({ kind: 'signed_in', principal: result.principal });

    const auth = await h.service.authenticateRequest(request('/', { cookies }));
    const csrf = auth.kind === 'authenticated' ? auth.context.csrfToken : '';
    const logout = request('/api/human/auth/logout', { method: 'POST', cookies, headers: { origin: ORIGIN, [CSRF_HEADER]: csrf } });
    expect(await h.service.identityFor(logout).signOut('op-1')).toEqual({ kind: 'ok', value: null });
    expect(await h.service.identityFor(request('/', { cookies })).current()).toEqual({ kind: 'signed_out' });
  });

  it('reports a store outage as unavailable', async () => {
    const h = harness();
    const { cookies } = await signIn(h);
    h.store.inject('read', 'unavailable');
    expect(await h.service.identityFor(request('/', { cookies })).current()).toEqual({ kind: 'unavailable', retryable: true });
  });

  it('does not sign out through a request that fails the mutation guard', async () => {
    const h = harness();
    const { cookies } = await signIn(h);
    const forged = request('/api/human/auth/logout', { method: 'POST', cookies, headers: { origin: 'https://evil.example' } });
    expect(await h.service.identityFor(forged).signOut('op-2')).toEqual({ kind: 'unavailable', retryable: true });
    expect((await h.service.identityFor(request('/', { cookies })).current()).kind).toBe('signed_in');
  });

  it('builds a same-origin sign-in navigation and rejects unsafe return paths', async () => {
    const identity = harness().service.identityFor(request('/'));
    expect(await identity.beginSignIn('/chats/1?tab=a')).toEqual({
      kind: 'ok', value: { kind: 'navigate', url: 'https://khala.aiur.team/api/human/auth/login?return_to=%2Fchats%2F1%3Ftab%3Da' },
    });
    expect(await identity.beginSignIn('//evil.example')).toEqual({ kind: 'rejected', code: 'invalid_return_path' });
  });
});

describe('diagnostics', () => {
  it('logs stable codes with a sanitized request ID only', async () => {
    const h = harness();
    await h.service.requireHumanMutation(request('/x', { method: 'POST', headers: { origin: 'https://evil.example', 'x-nf-request-id': '01J-abc' } }));
    await h.service.requireHumanMutation(request('/x', { method: 'POST', headers: { origin: 'https://evil.example', 'x-request-id': 'bad id <script>' } }));
    expect(h.logs).toEqual([
      { event: 'mutation', code: 'forbidden_origin', requestId: '01J-abc' },
      { event: 'mutation', code: 'forbidden_origin', requestId: null },
    ]);
  });

  it('never lets a failing logger change the outcome', async () => {
    const h = harness({ log: () => { throw new Error('logger down'); } });
    expect(await h.service.requireHumanMutation(request('/x', { method: 'POST' }))).toEqual({ kind: 'rejected', code: 'forbidden_origin' });
  });

  it('keeps malformed input and raw cookies out of errors and logs', async () => {
    const h = harness();
    const raw = `__Host-khala_session=${'Z'.repeat(43)}`;
    const result = await h.service.completeSignIn(request('/api/human/auth/callback?code=secret-code&state=s', { cookies: [raw, '__Host-khala_login=%%%'] }));
    const text = JSON.stringify([result, h.logs]);
    expect(text).not.toContain('Z'.repeat(43));
    expect(text).not.toContain('secret-code');
    expect(result).toMatchObject({ kind: 'rejected', code: 'login_expired' });
  });
});
