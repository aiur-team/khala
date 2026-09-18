// The oauth4webapi adapter against an in-process authorization server that signs
// real ES256 ID tokens and enforces PKCE, redirect URI and code binding. This
// proves the adapter wires the library's checks; it does not certify a real
// provider's configuration (KHA-132 owns that journey).

import { createHash, webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAuthService } from './index';
import { createOidcClient } from './oidc';
import type { CodeExchange } from './provider';
import { CLIENT_ID, ISSUER, ORIGIN, T0, cookiePairs, fakeDirectory, fakeStore, request, secureRandom } from './support.test';

const REDIRECT = `${ORIGIN}/api/human/auth/callback`;
const SECRET = 'client-secret';
const b64 = (value: string | Uint8Array) => Buffer.from(value).toString('base64url');
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Grant = { redirectUri: string; challenge: string; nonce: string; used: boolean };

async function fakeServer() {
  const keys = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const rogue = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = { ...(await webcrypto.subtle.exportKey('jwk', keys.publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };
  const grants = new Map<string, Grant>();
  const server = {
    down: false,
    tokenStatus: 200,
    signWithRogueKey: false,
    idToken: {} as Record<string, unknown>,
    omitEmail: false,
    userinfoSub: null as string | null,
    tokenRequests: 0,
    approve(authorizationUrl: string, subject = 'user-1') {
      const params = new URL(authorizationUrl).searchParams;
      const code = `code-${grants.size + 1}`;
      grants.set(code, { redirectUri: params.get('redirect_uri')!, challenge: params.get('code_challenge')!, nonce: params.get('nonce')!, used: false });
      server.idToken = { sub: subject, ...server.idToken };
      return `${params.get('redirect_uri')}?code=${code}&state=${params.get('state')}`;
    },
    async fetch(url: string, init: { method: string; headers: Record<string, string>; body?: unknown }) {
      if (server.down) throw new TypeError('fetch failed');
      const path = new URL(url).pathname;
      if (path === '/.well-known/openid-configuration') {
        return json({
          issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`,
          jwks_uri: `${ISSUER}/jwks`, userinfo_endpoint: `${ISSUER}/userinfo`, code_challenge_methods_supported: ['S256'],
          id_token_signing_alg_values_supported: ['ES256'],
        });
      }
      if (path === '/jwks') return json({ keys: [jwk] });
      if (path === '/userinfo') {
        return json({ sub: server.userinfoSub ?? server.idToken.sub, email: 'ada@example.test', email_verified: true });
      }
      if (path !== '/token') return json({ error: 'not_found' }, 404);
      server.tokenRequests += 1;
      if (server.tokenStatus !== 200) return new Response('upstream down', { status: server.tokenStatus });
      const form = new URLSearchParams(String(init.body));
      const grant = grants.get(form.get('code') ?? '');
      const verifier = form.get('code_verifier') ?? '';
      // RFC 6749 §2.3.1: Basic credentials are form-encoded before base64.
      const basic = (new Headers(init.headers).get('authorization') ?? '').replace(/^Basic /, '');
      const [id, secret] = Buffer.from(basic, 'base64').toString().split(':').map(part => decodeURIComponent(part));
      if (id !== CLIENT_ID || secret !== SECRET) return json({ error: 'invalid_client' }, 401);
      if (!grant || grant.used || form.get('redirect_uri') !== grant.redirectUri
        || createHash('sha256').update(verifier).digest('base64url') !== grant.challenge) {
        return json({ error: 'invalid_grant' }, 400);
      }
      grant.used = true;
      const now = Math.floor(T0 / 1000);
      const claims = {
        iss: ISSUER, aud: CLIENT_ID, iat: now, exp: now + 300, nonce: grant.nonce,
        email: 'ada@example.test', email_verified: true, ...server.idToken,
      };
      if (server.omitEmail) {
        delete (claims as Record<string, unknown>).email;
        delete (claims as Record<string, unknown>).email_verified;
      }
      const signingInput = `${b64(JSON.stringify({ alg: 'ES256', kid: 'k1', typ: 'JWT' }))}.${b64(JSON.stringify(claims))}`;
      const key = server.signWithRogueKey ? rogue.privateKey : keys.privateKey;
      const signature = await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, Buffer.from(signingInput));
      return json({ access_token: 'at-secret', token_type: 'Bearer', expires_in: 300, id_token: `${signingInput}.${b64(new Uint8Array(signature))}` });
    },
  };
  return server;
}

async function setup() {
  const server = await fakeServer();
  const client = createOidcClient({ issuer: ISSUER, clientId: CLIENT_ID, clientSecret: SECRET, clock: () => T0, fetch: server.fetch });
  const verifier = 'v'.repeat(43);
  const binding = { redirectUri: REDIRECT, state: 's'.repeat(43), nonce: 'n'.repeat(43) };
  async function begin(): Promise<CodeExchange> {
    const url = await client.authorizationUrl({
      ...binding, codeChallenge: createHash('sha256').update(verifier).digest('base64url'), codeChallengeMethod: 'S256',
    });
    if (url.kind !== 'ok') throw new Error('authorization URL failed');
    return { callbackUrl: server.approve(url.value), redirectUri: REDIRECT, expectedState: binding.state, nonce: binding.nonce, codeVerifier: verifier };
  }
  return { server, client, begin, verifier };
}

describe('oauth4webapi adapter', () => {
  it('builds an S256 code-flow authorization URL from discovery', async () => {
    const { client } = await setup();
    const result = await client.authorizationUrl({ redirectUri: REDIRECT, state: 's', nonce: 'n', codeChallenge: 'c', codeChallengeMethod: 'S256' });
    const url = new URL(result.kind === 'ok' ? result.value : 'https://x.invalid');
    expect(url.origin + url.pathname).toBe(`${ISSUER}/authorize`);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CLIENT_ID, redirect_uri: REDIRECT, response_type: 'code', scope: 'openid email', state: 's', nonce: 'n',
      code_challenge: 'c', code_challenge_method: 'S256',
    });
  });

  it('refuses plain PKCE without contacting the provider', async () => {
    const { client, server } = await setup();
    server.down = true;
    const request = { redirectUri: REDIRECT, state: 's', nonce: 'n', codeChallenge: 'c', codeChallengeMethod: 'plain' };
    expect(await client.authorizationUrl(request as never)).toEqual({ kind: 'rejected', code: 'invalid_response' });
  });

  it('returns validated ID token claims and never a token', async () => {
    const { client, begin } = await setup();
    const result = await client.exchangeCode(await begin());
    expect(result).toMatchObject({
      kind: 'ok', value: { iss: ISSUER, aud: CLIENT_ID, sub: 'user-1', nonce: 'n'.repeat(43), email: 'ada@example.test', email_verified: true },
    });
    expect(JSON.stringify(result)).not.toMatch(/at-secret|eyJ/);
  });

  it.each([
    ['another code verifier', { codeVerifier: 'w'.repeat(43) }],
    ['another redirect URI', { redirectUri: `${ORIGIN}/elsewhere` }],
    ['another nonce', { nonce: 'm'.repeat(43) }],
    ['another state', { expectedState: 't'.repeat(43) }],
  ])('rejects a code exchanged with %s', async (_name, change) => {
    const { client, begin } = await setup();
    expect(await client.exchangeCode({ ...(await begin()), ...change })).toEqual({ kind: 'rejected', code: 'invalid_response' });
  });

  it.each([
    ['signed by a key outside the issuer JWKS', { signWithRogueKey: true }],
    ['for another audience', { idToken: { aud: 'other-client' } }],
    ['from another issuer', { idToken: { iss: 'https://evil.example.test' } }],
    ['already expired', { idToken: { exp: Math.floor(T0 / 1000) - 120 } }],
  ])('rejects an ID token %s', async (_name, fault) => {
    const { client, begin, server } = await setup();
    Object.assign(server, fault);
    expect(await client.exchangeCode(await begin())).toEqual({ kind: 'rejected', code: 'invalid_response' });
  });

  it('refuses to redeem a code twice', async () => {
    const { client, begin } = await setup();
    const exchange = await begin();
    expect((await client.exchangeCode(exchange)).kind).toBe('ok');
    expect(await client.exchangeCode(exchange)).toEqual({ kind: 'rejected', code: 'invalid_response' });
  });

  it('reports a provider refusal as denied', async () => {
    const { client, begin } = await setup();
    const exchange = await begin();
    const callbackUrl = `${REDIRECT}?error=access_denied&state=${exchange.expectedState}`;
    expect(await client.exchangeCode({ ...exchange, callbackUrl })).toEqual({ kind: 'rejected', code: 'denied' });
  });

  it('reports a token endpoint outage or network failure as unavailable', async () => {
    const { client, begin, server } = await setup();
    const exchange = await begin();
    server.tokenStatus = 503;
    expect(await client.exchangeCode(exchange)).toEqual({ kind: 'unavailable' });
    server.tokenStatus = 200;
    server.down = true;
    expect(await client.exchangeCode(exchange)).toEqual({ kind: 'unavailable' });
  });

  it('retries discovery after it fails', async () => {
    const server = await fakeServer();
    const client = createOidcClient({ issuer: ISSUER, clientId: CLIENT_ID, clientSecret: SECRET, clock: () => T0, fetch: server.fetch });
    const request = { redirectUri: REDIRECT, state: 's', nonce: 'n', codeChallenge: 'c', codeChallengeMethod: 'S256' } as const;
    server.down = true;
    expect(await client.authorizationUrl(request)).toEqual({ kind: 'unavailable' });
    server.down = false;
    expect((await client.authorizationUrl(request)).kind).toBe('ok');
  });

  it('takes email and its verified flag from userinfo when the ID token has neither', async () => {
    const { client, begin, server } = await setup();
    server.omitEmail = true;
    expect(await client.exchangeCode(await begin())).toMatchObject({
      kind: 'ok', value: { sub: 'user-1', email: 'ada@example.test', email_verified: true },
    });
  });

  it('refuses userinfo for another subject', async () => {
    const { client, begin, server } = await setup();
    server.omitEmail = true;
    server.userinfoSub = 'user-2';
    expect(await client.exchangeCode(await begin())).toEqual({ kind: 'rejected', code: 'invalid_response' });
  });

  it('signs a human in end to end through the auth service', async () => {
    const server = await fakeServer();
    const service = createAuthService({
      oidc: createOidcClient({ issuer: ISSUER, clientId: CLIENT_ID, clientSecret: SECRET, clock: () => T0, fetch: server.fetch }),
      store: fakeStore(() => T0).store,
      messaging: fakeDirectory().directory,
      clock: () => T0,
      random: secureRandom,
      origin: ORIGIN,
      sessionTtlMs: 3600_000,
      loginTtlMs: 600_000,
    });
    const started = await service.startSignIn('/chats');
    if (started.kind !== 'redirect') throw new Error('not started');
    const callback = server.approve(started.location);
    const result = await service.completeSignIn(request(callback, { cookies: cookiePairs(started.cookies) }));
    expect(result).toMatchObject({ kind: 'signed_in', location: '/chats', principal: { providerIssuer: ISSUER, providerSubject: 'user-1' } });
    expect(server.tokenRequests).toBe(1);
  });
});
