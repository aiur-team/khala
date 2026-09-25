import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AuthPrincipal, OwnerId, StableAgentPrincipal } from '@khala/contracts/messaging/index';
import type { Authentication } from '../../auth/index';
import { T0, fakeStore, secureRandom } from '../../auth/support.test';
import {
  AUTHORIZE_PATH, CODE_TTL_MS, CREDENTIAL_TTL_MS, TOKEN_PATH,
  type ChannelDiscoveryBootstrapDeps, createChannelDiscoveryBootstrapHandlers,
} from './handler';
import { thumbprint } from '../../agent-bootstrap/proof';

const ORIGIN = 'https://khala.aiur.team';
const REDIRECT_URI = 'http://127.0.0.1:49152/khala/discovery/callback';
const SESSION = { harness: 'codex', session_id: 'thread-existing-b', generation: 3 };

function principal(ownerId = 'owner_b'): AuthPrincipal {
  return {
    v: 1, ownerId: ownerId as OwnerId, providerIssuer: 'https://id.example.test', providerSubject: `sub-${ownerId}`,
    verifiedEmail: `${ownerId}@example.test`, sessionExpiresAt: '2026-09-18T20:00:00Z',
  };
}

function connectorKey(clock: () => number) {
  const { privateKey } = generateKeyPairSync('ed25519');
  const x = createPublicKey(privateKey).export({ format: 'jwk' }).x!;
  return {
    x, jkt: thumbprint(x), privateKey,
    proof(url: string, accessToken?: string, claims: Record<string, unknown> = {}, signWith: KeyObject = privateKey) {
      const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'dpop+jwt', jwk: { kty: 'OKP', crv: 'Ed25519', x } })).toString('base64url');
      const payloadClaims: Record<string, unknown> = {
        htm: 'POST', htu: url, iat: Math.floor(clock() / 1000), jti: randomBytes(16).toString('base64url'), ...claims,
      };
      if (accessToken !== undefined && !('ath' in claims)) payloadClaims.ath = createHash('sha256').update(accessToken).digest('base64url');
      const payload = Buffer.from(JSON.stringify(payloadClaims)).toString('base64url');
      return `${header}.${payload}.${sign(null, Buffer.from(`${header}.${payload}`), signWith).toString('base64url')}`;
    },
  };
}

type Overrides = Partial<ChannelDiscoveryBootstrapDeps> & { signedIn?: () => string | null };

function scriptedTokenLimiter(
  reservations: Array<'reserved' | 'limited' | 'unavailable'>,
  finalizations: Array<'released' | 'finalized' | 'unavailable'> = [],
): ChannelDiscoveryBootstrapDeps['limiter'] {
  let reservationIndex = 0;
  let finalizationIndex = 0;
  return {
    async reserve(input) {
      if (input.kind === 'consent') return { kind: 'reserved', permit: { permitId: 'consent-permit' } };
      const kind = reservations[reservationIndex++] ?? 'reserved';
      return kind === 'reserved' ? { kind, permit: { permitId: `token-permit-${reservationIndex}` } } : { kind };
    },
    async finalize(input) {
      if (input.operationId.startsWith('consent-')) {
        return input.disposition === 'release' ? { kind: 'released' } : { kind: 'finalized' };
      }
      const kind = finalizations[finalizationIndex++]
        ?? (input.disposition === 'release' ? 'released' : 'finalized');
      return { kind };
    },
  };
}

function setup(overrides: Overrides = {}) {
  let now = T0;
  const clock = () => now;
  const store = fakeStore(clock);
  const inspected: string[] = [];
  const limiterCalls: string[] = [];
  let authority: 'verified' | 'removed' | 'rebound' | 'unavailable' = 'verified';
  const deps: ChannelDiscoveryBootstrapDeps = {
    origin: ORIGIN, store: store.store, clock, random: secureRandom,
    async authenticate(): Promise<Authentication> {
      const owner = overrides.signedIn ? overrides.signedIn() : 'owner_b';
      return owner === null ? { kind: 'signed_out' } : { kind: 'authenticated', context: { principal: principal(owner), csrfToken: 'csrf-token' } };
    },
    sessionAuthority: {
      async inspect(input) {
        inspected.push(`${input.ownerId}:${input.session.harness}:${input.session.sessionId}:${input.session.generation}`);
        return authority === 'verified'
          ? { kind: 'verified', principal: 'agent_stable_b' as StableAgentPrincipal, currentGeneration: input.session.generation }
          : { kind: authority };
      },
    },
    trustedSource: async () => ({ kind: 'trusted', source: 'edge:test' }),
    limiter: {
      async reserve(input) {
        limiterCalls.push(`reserve:${input.kind}`);
        return { kind: 'reserved', permit: { permitId: randomBytes(8).toString('hex') } };
      },
      async finalize(input) {
        limiterCalls.push(`finalize:${input.disposition}`);
        return input.disposition === 'release' ? { kind: 'released' } : { kind: 'finalized' };
      },
    },
    ...overrides,
  };
  const handlers = createChannelDiscoveryBootstrapHandlers(deps);
  const route = (path: string) => [...handlers.human, ...handlers.agent].find(item => item.path === path)!;
  const key = connectorKey(clock);
  const verifier = randomBytes(32).toString('base64url');
  const params = (extra: Record<string, string> = {}) => new URLSearchParams({
    redirect_uri: REDIRECT_URI, state: 'state-0123456789abcdef', code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256', origin: ORIGIN, harness: SESSION.harness, session_id: SESSION.session_id,
    generation: String(SESSION.generation), proof_jkt: key.jkt, ...extra,
  });
  const consent = (extra: Record<string, string> = {}, raw?: string) => route(AUTHORIZE_PATH).handle(new Request(
    `${ORIGIN}${AUTHORIZE_PATH}?${raw ?? params(extra)}`, { headers: { cookie: 'session=x' } },
  ));
  const decide = (decision = 'allow', extra: Record<string, string> = {}, raw?: string) => route(AUTHORIZE_PATH).handle(new Request(
    `${ORIGIN}${AUTHORIZE_PATH}`, {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN, 'sec-fetch-site': 'same-origin', cookie: 'session=x' },
      body: raw ?? new URLSearchParams({ ...Object.fromEntries(params(extra)), csrf_token: 'csrf-token', decision }),
    },
  ));
  async function code() {
    const response = await decide();
    return new URL(response.headers.get('location')!).searchParams.get('code')!;
  }
  const post = (body: Record<string, unknown>, headers: Record<string, string>) => route(TOKEN_PATH).handle(new Request(`${ORIGIN}${TOKEN_PATH}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
  }));
  async function exchange(oneTimeCode?: string, body: Record<string, unknown> = {}, proof = key.proof(`${ORIGIN}${TOKEN_PATH}`)) {
    return post({ grant_type: 'authorization_code', code: oneTimeCode ?? await code(), code_verifier: verifier, redirect_uri: REDIRECT_URI, ...SESSION, ...body }, { dpop: proof });
  }
  async function credential() {
    const response = await exchange();
    return (await response.json() as { credential: { credentialRef: string } }).credential;
  }
  const refresh = (credentialRef: string, proof = key.proof(`${ORIGIN}${TOKEN_PATH}`, credentialRef)) => post(
    { grant_type: 'refresh_token', ...SESSION }, { authorization: `DPoP ${credentialRef}`, dpop: proof },
  );
  const authorize = (
    credentialRef: string,
    action = 'list_channels',
    requestUrl = `${ORIGIN}/api/agent/channel-discovery/list`,
    proof = key.proof(requestUrl, credentialRef),
  ) => handlers.credentials.authorize(
    new Request(requestUrl, { method: 'POST', headers: { authorization: `DPoP ${credentialRef}`, dpop: proof } }), action,
  );
  return { store, key, route, params, consent, decide, code, exchange, credential, refresh, authorize, handlers, inspected, limiterCalls,
    advance(ms: number) { now += ms; }, setAuthority(next: typeof authority) { authority = next; } };
}

describe('channel discovery owner consent', () => {
  it('renders informed, no-store consent without creating channel authority', async () => {
    const h = setup();
    const response = await h.consent();
    const page = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(page).toContain('Authorize channel discovery');
    expect(page).toContain('does not join or create a channel');
    expect(page).toContain('Request access');
    expect(page).toContain('Request channel creation');
    expect(h.store.records.size).toBe(0);
  });

  it('redirects signed-out owners through login with an inert return request', async () => {
    const response = await setup({ signedIn: () => null }).consent();
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get('location')!);
    expect(location.pathname).toBe('/api/human/auth/login');
    expect(location.searchParams.get('return_to')).toContain(AUTHORIZE_PATH);
  });

  it('denies without issuing a code and rejects duplicate or hostile inputs', async () => {
    const h = setup();
    const denied = await h.decide('deny');
    expect(new URL(denied.headers.get('location')!).searchParams.get('error')).toBe('access_denied');
    expect(h.store.records.size).toBe(0);
    expect((await h.consent({}, `${h.params()}&state=duplicate`)).status).toBe(400);
    expect((await h.consent({ origin: 'https://attacker.example' })).status).toBe(400);
    expect((await h.consent({}, `${h.params()}&owner_id=owner_b`)).status).toBe(400);
    expect((await h.decide('allow', {}, `${h.params()}&csrf_token=csrf-token&decision=allow&owner_id=owner_b`)).status).toBe(400);
    expect((await h.decide('allow', {}, `${h.params()}&csrf_token=csrf-token&csrf_token=second&decision=allow`)).status).toBe(403);
  });

  it('requires exact Origin and CSRF and rechecks owner/session authority', async () => {
    const h = setup();
    const form = new URLSearchParams({ ...Object.fromEntries(h.params()), csrf_token: 'wrong', decision: 'allow' }).toString();
    expect((await h.decide('allow', {}, form)).status).toBe(403);
    h.setAuthority('rebound');
    expect((await h.decide()).status).toBe(403);
  });
});

describe('channel discovery credential lifecycle', () => {
  it('completes discovery authorization without creating channel authority', async () => {
    const forbidden = new Proxy({}, { get() { throw new Error('forbidden channel authority touched'); } });
    const h = setup({ channel: forbidden, admission: forbidden, devices: forbidden, bindings: forbidden } as never);
    const response = await h.exchange();
    expect(response.status).toBe(200);
    const { credential } = await response.json() as { credential: Record<string, unknown> };
    expect(credential).toMatchObject({ v: 1, audience: 'khala-channel-discovery', scopes: ['list_channels', 'request_channel_access', 'request_channel_create'] });
    expect((credential.requester as Record<string, unknown>)).toMatchObject({ principal: 'agent_stable_b', origin: ORIGIN, sessionGeneration: 3 });
    expect((credential.requester as { proofKey: unknown }).proofKey).toEqual({ algorithm: 'Ed25519', publicKey: h.key.x, thumbprint: h.key.jkt });
    expect(JSON.stringify([...h.store.records.values()])).not.toContain(credential.credentialRef as string);
  });

  it('burns the code before rejecting PKCE, redirect, session, or proof mismatch', async () => {
    for (const body of [{ code_verifier: 'z'.repeat(43) }, { redirect_uri: 'http://127.0.0.1:5000/other' }, { generation: 4 }]) {
      const h = setup();
      const code = await h.code();
      expect((await h.exchange(code, body)).status).toBe(401);
      expect((await h.exchange(code)).status).toBe(401);
    }
    const h = setup();
    const thief = connectorKey(() => T0);
    const code = await h.code();
    expect((await h.exchange(code, {}, thief.proof(`${ORIGIN}${TOKEN_PATH}`))).status).toBe(401);
    expect((await h.exchange(code)).status).toBe(401);
  });

  it('rejects unexpected fields in both exact token grant shapes', async () => {
    const exchangeHarness = setup();
    const code = await exchangeHarness.code();
    expect((await exchangeHarness.exchange(code, { owner_id: 'owner_b' })).status).toBe(400);
    const refreshHarness = setup();
    const credential = await refreshHarness.credential();
    const response = refreshHarness.route(TOKEN_PATH).handle(new Request(`${ORIGIN}${TOKEN_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', authorization: `DPoP ${credential.credentialRef}`,
        dpop: refreshHarness.key.proof(`${ORIGIN}${TOKEN_PATH}`, credential.credentialRef),
      },
      body: JSON.stringify({ grant_type: 'refresh_token', ...SESSION, audience: 'khala-channel-discovery' }),
    }));
    expect((await response).status).toBe(400);
  });

  it('enforces exact code and credential expiry boundaries', async () => {
    const codeHarness = setup();
    const code = await codeHarness.code();
    codeHarness.advance(CODE_TTL_MS);
    expect((await codeHarness.exchange(code)).status).toBe(401);
    const h = setup();
    const credential = await h.credential();
    h.advance(CREDENTIAL_TTL_MS - 1);
    expect(await h.authorize(credential.credentialRef)).toMatchObject({ kind: 'authorized' });
    h.advance(1);
    expect(await h.authorize(credential.credentialRef)).toMatchObject({ kind: 'refused', code: 'invalid_credential' });
  });

  it('rotates atomically, rejects the old value, and permits one concurrent refresh winner', async () => {
    const h = setup();
    const first = await h.credential();
    const proofA = h.key.proof(`${ORIGIN}${TOKEN_PATH}`, first.credentialRef);
    const proofB = h.key.proof(`${ORIGIN}${TOKEN_PATH}`, first.credentialRef);
    const [a, b] = await Promise.all([h.refresh(first.credentialRef, proofA), h.refresh(first.credentialRef, proofB)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const winner = a.status === 200 ? a : b;
    const second = (await winner.json() as { credential: { credentialRef: string } }).credential;
    expect(await h.authorize(first.credentialRef)).toMatchObject({ kind: 'refused' });
    expect(await h.authorize(second.credentialRef)).toMatchObject({ kind: 'authorized' });
  });

  it('rechecks owner removal and rebind at exchange, refresh, and use', async () => {
    for (const state of ['removed', 'rebound'] as const) {
      const atExchange = setup();
      const code = await atExchange.code();
      atExchange.setAuthority(state);
      expect((await atExchange.exchange(code)).status).toBe(401);
      const later = setup();
      const credential = await later.credential();
      later.setAuthority(state);
      expect((await later.refresh(credential.credentialRef)).status).toBe(401);
      expect(await later.authorize(credential.credentialRef)).toMatchObject({ kind: 'refused' });
    }
  });

  it('requires current sender proof, exact scope and rejects proof replay', async () => {
    const h = setup();
    const credential = await h.credential();
    const proof = h.key.proof(`${ORIGIN}/api/agent/channel-discovery/list`, credential.credentialRef);
    expect(await h.authorize(credential.credentialRef, 'list_channels', undefined, proof)).toMatchObject({ kind: 'authorized' });
    expect(await h.authorize(credential.credentialRef, 'list_channels', undefined, proof)).toMatchObject({ kind: 'refused', code: 'proof_replayed' });
    expect(await h.authorize(credential.credentialRef, 'approve')).toMatchObject({ status: 403 });
  });

  it('rejects a foreign request origin even when the proof names that exact target', async () => {
    const h = setup();
    const credential = await h.credential();
    const target = 'https://attacker.example/api/agent/channel-discovery/list?cursor=next';
    expect(await h.authorize(credential.credentialRef, 'list_channels', target)).toEqual({
      kind: 'refused', status: 401, code: 'proof_target_mismatch',
    });
  });

  it('keeps code and credential authority unchanged when token limiter reserve refuses', async () => {
    for (const kind of ['limited', 'unavailable'] as const) {
      const exchangeHarness = setup({ limiter: scriptedTokenLimiter([kind, 'reserved']) });
      const code = await exchangeHarness.code();
      expect((await exchangeHarness.exchange(code)).status).toBe(kind === 'limited' ? 429 : 503);
      expect((await exchangeHarness.exchange(code)).status).toBe(200);

      const refreshHarness = setup({ limiter: scriptedTokenLimiter(['reserved', kind, 'reserved']) });
      const credential = await refreshHarness.credential();
      expect((await refreshHarness.refresh(credential.credentialRef)).status).toBe(kind === 'limited' ? 429 : 503);
      const rotated = await refreshHarness.refresh(credential.credentialRef);
      expect(rotated.status).toBe(200);
      expect(await refreshHarness.authorize(credential.credentialRef)).toMatchObject({ kind: 'refused', code: 'invalid_credential' });
    }
  });

  it('returns unavailable and preserves committed token mutations when limiter finalization is unavailable', async () => {
    const exchangeHarness = setup({ limiter: scriptedTokenLimiter(['reserved', 'reserved'], ['unavailable']) });
    const code = await exchangeHarness.code();
    expect((await exchangeHarness.exchange(code)).status).toBe(503);
    expect((await exchangeHarness.exchange(code)).status).toBe(401);

    const refreshHarness = setup({ limiter: scriptedTokenLimiter(['reserved', 'reserved', 'reserved'], ['released', 'unavailable']) });
    const credential = await refreshHarness.credential();
    expect((await refreshHarness.refresh(credential.credentialRef)).status).toBe(503);
    expect((await refreshHarness.refresh(credential.credentialRef)).status).toBe(401);
    expect(await refreshHarness.authorize(credential.credentialRef)).toMatchObject({ kind: 'refused', code: 'invalid_credential' });
  });

  it('fails closed when limiter reserve is limited or unavailable', async () => {
    for (const kind of ['limited', 'unavailable'] as const) {
      const h = setup({ limiter: { reserve: async () => ({ kind }), finalize: async () => ({ kind: 'unavailable' }) } });
      const response = await h.decide();
      expect(response.status).toBe(kind === 'limited' ? 429 : 503);
      expect(h.store.records.size).toBe(0);
    }
  });

  it('fails closed when a limiter finalization cannot be proven', async () => {
    const h = setup({ limiter: {
      reserve: async () => ({ kind: 'reserved', permit: { permitId: 'permit_1' } }),
      finalize: async () => ({ kind: 'unavailable' }),
    } });
    expect((await h.decide()).status).toBe(503);
  });
});
