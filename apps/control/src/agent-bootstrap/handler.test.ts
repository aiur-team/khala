// Route-level tests with injected doubles. They prove module behaviour only; the
// real provider, store and substrate proof belongs to KHA-133/139.

import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject, createPublicKey } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AuthPrincipal, BindingId, InviteState, OwnerId, ParticipantId, RoomId } from '@khala/contracts/messaging/index';
import type { Authentication } from '../auth/index';
import { T0, fakeStore, secureRandom } from '../auth/support.test';
import {
  ADAPTER_CAPABILITIES, AUTHORIZE_PATH, type AgentAdmissionPort, type AgentBootstrapDeps, DESCRIPTOR_PATH, REDEEM_PATH, TOKEN_PATH,
  createAgentBootstrapHandlers, isLoopbackRedirect,
} from './handler';
import { thumbprint } from './proof';
import { agentBindingStoreKeys } from './store';
import { type ProtocolRevocationPort, type RevocationTargets, createRevocationService } from '@khala/messaging/revocation/index';
import type { ControlStore, DeviceId } from '@khala/contracts/messaging/index';

const ORIGIN = 'https://khala.aiur.team';
const SESSION = { harness: 'codex', session_id: 'thread-existing-b', generation: 3 };
const REDIRECT_URI = 'http://127.0.0.1:49152/khala/callback/abc';
const ADAPTER_URL = `${ORIGIN}/api/agent/adapter/publish`;

function principal(ownerId: string): AuthPrincipal {
  return {
    v: 1, ownerId: ownerId as OwnerId, providerIssuer: 'https://id.example.test', providerSubject: `sub-${ownerId}`,
    verifiedEmail: `${ownerId}@example.test`, sessionExpiresAt: '2026-09-18T20:00:00Z',
  };
}

type ProofOptions = { claims?: Record<string, unknown>; header?: Record<string, unknown>; signWith?: KeyObject; jwk?: Record<string, unknown> };

/** Test-side connector key: signs proofs exactly as `@khala/connector/bootstrap/proof` does. */
function connectorKey(clock: () => number) {
  const { privateKey } = generateKeyPairSync('ed25519');
  const x = createPublicKey(privateKey).export({ format: 'jwk' }).x!;
  return {
    jkt: thumbprint(x),
    privateKey,
    proof(url: string, accessToken?: string, options: ProofOptions = {}) {
      const jwk = options.jwk ?? { kty: 'OKP', crv: 'Ed25519', x };
      const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'dpop+jwt', jwk, ...options.header })).toString('base64url');
      const overrides = options.claims ?? {};
      const claims: Record<string, unknown> = { htm: 'POST', htu: url, iat: Math.floor(clock() / 1000), jti: randomBytes(16).toString('base64url'), ...overrides };
      if (accessToken !== undefined && !('ath' in overrides)) claims.ath = createHash('sha256').update(accessToken).digest('base64url');
      const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
      return `${header}.${payload}.${sign(null, Buffer.from(`${header}.${payload}`), options.signWith ?? privateKey).toString('base64url')}`;
    },
  };
}

type SetupOverrides = Partial<Omit<AgentBootstrapDeps, 'agents'>> & {
  agents?: Partial<AgentAdmissionPort>;
  signedIn?: () => string | null;
  invite?: () => InviteState;
};

type Capability = { token: string; token_type: string; scope: string[]; binding_id: string; generation: number; expires_at: number };
type Redeemed = { binding: { bindingId: string; ownerId: string; generation: number; agentParticipantId: string }; adapter_capability: Capability };

function setup(overrides: SetupOverrides = {}) {
  let now = T0;
  const clock = () => now;
  const store = fakeStore(clock);
  const admits: string[] = [];
  const admitOperations: string[] = [];
  const admissionResults = new Map<string, Readonly<{ agentParticipantId: ParticipantId; roomId: RoomId }>>();
  const deps: AgentBootstrapDeps = {
    origin: ORIGIN,
    store: store.store,
    clock,
    random: secureRandom,
    async authenticate(): Promise<Authentication> {
      const owner = overrides.signedIn ? overrides.signedIn() : 'owner_b';
      return owner === null ? { kind: 'signed_out' } : { kind: 'authenticated', context: { principal: principal(owner), csrfToken: 'csrf-token-of-session' } };
    },
    inviteFromLink: url => (url.pathname.startsWith('/i/') ? url.pathname.slice(3) : null),
    admissionFor: () => ({ inspect: async () => overrides.invite?.() ?? 'eligible' }),
    admissionPolicy: async () => 'allow',
    legacyMigrationWritesEnabled: true,
    agents: {
      inspect: async ({ ownerId }) => ({
        kind: 'ok', value: { agentParticipantId: `agent_${ownerId}` as ParticipantId, roomId: 'room_1' as RoomId },
      }),
      async admit({ deviceId, expectedAgentParticipantId, expectedRoomId, operationId }) {
        const previous = admissionResults.get(operationId);
        if (previous) return { kind: 'ok', value: previous };
        admits.push(deviceId);
        admitOperations.push(operationId);
        const value = { agentParticipantId: expectedAgentParticipantId, roomId: expectedRoomId };
        admissionResults.set(operationId, value);
        return { kind: 'ok', value };
      },
    },
  };
  Object.assign(deps, { ...overrides, agents: { ...deps.agents, ...overrides.agents } });
  const handlers = createAgentBootstrapHandlers(deps);
  const route = (path: string) => [...handlers.agent, ...handlers.human].find(entry => entry.path === path)!;
  const key = connectorKey(clock);
  const verifier = randomBytes(32).toString('base64url');

  function authorizeParams(params: Record<string, string> = {}) {
    return new URLSearchParams({
      invite: 'room-invite', harness: SESSION.harness, session_id: SESSION.session_id, generation: String(SESSION.generation),
      device_id: 'KHALADEV1', jkt: key.jkt, redirect_uri: REDIRECT_URI,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
      state: 'state-0123456789abcdef', ...params,
    });
  }

  /** The owner's browser opening the consent page. */
  async function consent(params: Record<string, string> = {}, query?: string) {
    const url = new URL(`${ORIGIN}${AUTHORIZE_PATH}`);
    url.search = query ?? authorizeParams(params).toString();
    return route(AUTHORIZE_PATH).handle(new Request(url, { headers: { cookie: '__Host-khala_session=x' } }));
  }

  /** The owner's browser submitting the consent form. */
  async function approve(params: Record<string, string> = {}, form: Record<string, string> = {}, headers: Record<string, string> = {}, raw?: string) {
    const body = raw ?? new URLSearchParams({ ...Object.fromEntries(authorizeParams(params)), csrf: 'csrf-token-of-session', decision: 'allow', ...form }).toString();
    return route(AUTHORIZE_PATH).handle(new Request(`${ORIGIN}${AUTHORIZE_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded', cookie: '__Host-khala_session=x', origin: ORIGIN, 'sec-fetch-site': 'same-origin', ...headers,
      },
      body,
    }));
  }

  async function code(params: Record<string, string> = {}) {
    const response = await approve(params);
    return new URL(response.headers.get('location')!).searchParams.get('code')!;
  }

  function post(path: string, body: Record<string, unknown>, headers: Record<string, string>) {
    return route(path).handle(new Request(`${ORIGIN}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers }, body: JSON.stringify(body),
    }));
  }

  async function exchange(oneTimeCode: string, overrides: Record<string, unknown> = {}, proof = key.proof(`${ORIGIN}${TOKEN_PATH}`)) {
    return post(TOKEN_PATH, {
      code: oneTimeCode, code_verifier: verifier, ...SESSION, device_id: 'KHALADEV1', redirect_uri: REDIRECT_URI, ...overrides,
    }, { dpop: proof });
  }

  async function grant(params: Record<string, string> = {}, body: Record<string, unknown> = {}) {
    const response = await exchange(await code(params), body);
    return ((await response.json()) as { grant: string }).grant;
  }

  async function redeem(bootstrapGrant: string, operationId = 'bootstrap-b-1', overrides: Record<string, unknown> = {}, proof?: string) {
    return post(REDEEM_PATH, { operation_id: operationId, ...SESSION, device_id: 'KHALADEV1', ...overrides }, {
      authorization: `DPoP ${bootstrapGrant}`, dpop: proof ?? key.proof(`${ORIGIN}${REDEEM_PATH}`, bootstrapGrant),
    });
  }

  /** A full bootstrap at `generation`, returning the parsed redeem body. */
  async function bootstrap(generation = SESSION.generation, operationId = 'bootstrap-b-1') {
    const response = await redeem(await grant({ generation: String(generation) }, { generation }), operationId, { generation });
    return { status: response.status, body: await response.json() as Redeemed & { code?: string } };
  }

  function adapter(token: string, action: string, proof = key.proof(ADAPTER_URL, token)) {
    return handlers.capabilities.authorize(new Request(ADAPTER_URL, { method: 'POST', headers: { authorization: `DPoP ${token}`, dpop: proof } }), action);
  }

  return {
    route, key, consent, approve, code, exchange, grant, redeem, bootstrap, adapter, handlers, store, admits, admitOperations,
    advance: (ms: number) => { now += ms; },
  };
}

type Harness = ReturnType<typeof setup>;

function storedText(h: Harness): string {
  return JSON.stringify([...h.store.records.entries()]);
}

async function bootstrapSession(
  h: Harness, sessionId: string, operationId: string, deviceId = 'KHALADEV1', generation = SESSION.generation,
) {
  const params = { session_id: sessionId, device_id: deviceId, generation: String(generation) };
  const body = { session_id: sessionId, device_id: deviceId, generation };
  const response = await h.redeem(await h.grant(params, body), operationId, body);
  return { status: response.status, body: await response.json() as Redeemed & { code?: string } };
}

function moveBindingToLegacy(h: Harness, binding: Redeemed['binding']): void {
  const participantKey = agentBindingStoreKeys.participant(binding.ownerId, 'room_1', binding.agentParticipantId);
  const legacyKey = agentBindingStoreKeys.legacy(binding.ownerId, 'room_1');
  const record = h.store.records.get(participantKey);
  if (!record) throw new Error('participant binding fixture is missing');
  h.store.records.delete(participantKey);
  h.store.records.set(legacyKey, { ...record, key: legacyKey });
}

describe('descriptor', () => {
  it('describes a link on this origin with the invite and fixed endpoints only', async () => {
    const { route } = setup();
    const response = await route(DESCRIPTOR_PATH).handle(new Request(`${ORIGIN}${DESCRIPTOR_PATH}?link=${encodeURIComponent(`${ORIGIN}/i/room-invite`)}`));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      v: 1, invite: 'room-invite', methods: ['loopback-browser-v1'],
      authorize: `${ORIGIN}${AUTHORIZE_PATH}`, token: `${ORIGIN}${TOKEN_PATH}`, redeem: `${ORIGIN}${REDEEM_PATH}`,
    });
  });

  it('does not describe foreign, credentialed or unparseable links', async () => {
    const { route } = setup();
    for (const link of ['https://evil.example/i/room-invite', 'https://u:p@khala.aiur.team/i/x', `${ORIGIN}/elsewhere`, 'nope']) {
      const response = await route(DESCRIPTOR_PATH).handle(new Request(`${ORIGIN}${DESCRIPTOR_PATH}?link=${encodeURIComponent(link)}`));
      expect(response.status).toBe(404);
    }
  });
});

describe('authorize (owner browser)', () => {
  it('sends a signed-out browser to sign-in and back to the consent page', async () => {
    const h = setup({ signedIn: () => null });
    for (const response of [await h.consent(), await h.approve()]) {
      expect(response.status).toBe(303);
      const location = new URL(response.headers.get('location')!);
      expect(location.pathname).toBe('/api/human/auth/login');
      const returnTo = location.searchParams.get('return_to')!;
      expect(returnTo).toMatch(/^\/api\/human\/agent-bootstrap\/authorize\?/);
      expect(returnTo).not.toContain('csrf');
    }
  });

  it('GET only renders a consent page: it issues nothing and cannot be framed', async () => {
    const h = setup();
    const response = await h.consent({ session_id: 'thread-<b>"x"' });
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
    expect(response.headers.get('content-type')).toMatch(/^text\/html/);
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    const page = await response.text();
    expect(page).toContain('<form method="post" action="/api/human/agent-bootstrap/authorize">');
    expect(page).toContain('name="csrf" value="csrf-token-of-session"');
    expect(page).toContain('thread-&#60;b&#62;&#34;x&#34;');
    expect(page).not.toContain('thread-<b>');
    expect(h.store.keys('agent-bootstrap:code:')).toHaveLength(0);
  });

  it('returns a one-time code only to a loopback redirect, and never stores it raw', async () => {
    const h = setup();
    const response = await h.approve();
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get('location')!);
    expect(location.origin).toBe('http://127.0.0.1:49152');
    expect(location.searchParams.get('state')).toBe('state-0123456789abcdef');
    const code = location.searchParams.get('code')!;
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(storedText(h)).not.toContain(code);
  });

  it('refuses a POST with a missing, wrong or repeated CSRF token', async () => {
    const h = setup();
    for (const form of [{ csrf: 'csrf-token-of-another-session' }, { csrf: '' }]) {
      const response = await h.approve({}, form);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ code: 'csrf_mismatch' });
    }
    const fields = await formOf(h);
    const missing = new URLSearchParams([...fields.filter(([name]) => name !== 'csrf'), ['decision', 'allow']]);
    expect(await (await h.approve({}, {}, {}, missing.toString())).json()).toEqual({ code: 'csrf_mismatch' });
    const repeated = new URLSearchParams([...fields, ['csrf', 'csrf-token-of-session'], ['decision', 'allow']]);
    expect(await (await h.approve({}, {}, {}, repeated.toString())).json()).toEqual({ code: 'csrf_mismatch' });
    expect(h.store.keys('agent-bootstrap:code:')).toHaveLength(0);
  });

  it('refuses a cross-site or wrong-origin POST before reading the session', async () => {
    let authenticated = 0;
    const h = setup({ signedIn: () => { authenticated += 1; return 'owner_b'; } });
    for (const headers of [{ origin: 'https://evil.example' }, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }]) {
      const response = await h.approve({}, {}, headers);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ code: 'forbidden_origin' });
    }
    expect(authenticated).toBe(0);
  });

  it('refuses a POST that is not a form', async () => {
    const h = setup();
    expect((await h.approve({}, {}, { 'content-type': 'application/json' })).status).toBe(400);
  });

  it('reports the owner cancelling to the loopback listener without issuing a code', async () => {
    const h = setup();
    const location = new URL((await h.approve({}, { decision: 'deny' })).headers.get('location')!);
    expect(location.searchParams.get('error')).toBe('access_denied');
    expect(location.searchParams.get('code')).toBeNull();
    expect((await h.approve({}, { decision: 'maybe' })).status).toBe(400);
  });

  it('refuses non-loopback, localhost, portless, credentialed, query-carrying and https redirects without redirecting', async () => {
    const h = setup();
    for (const redirect of [
      'https://evil.example/cb', 'http://localhost:4000/cb', 'http://127.0.0.1/cb', 'http://u@127.0.0.1:4000/cb', 'http://127.0.0.1:4000/cb#x',
      'http://127.0.0.1:4000/cb?next=https://evil.example', 'https://127.0.0.1:4000/cb',
    ]) {
      expect(isLoopbackRedirect(redirect)).toBe(false);
      for (const response of [await h.consent({ redirect_uri: redirect }), await h.approve({ redirect_uri: redirect })]) {
        expect(response.status).toBe(400);
        expect(response.headers.get('location')).toBeNull();
      }
    }
    expect(isLoopbackRedirect('http://[::1]:4000/cb')).toBe(true);
  });

  it('refuses a plain PKCE method, a malformed state and duplicated parameters', async () => {
    const h = setup();
    for (const params of [{ code_challenge_method: 'plain' }, { state: 'short' }, { state: 'state with spaces 0123456789' }]) {
      expect((await h.consent(params)).status).toBe(400);
      expect((await h.approve(params)).status).toBe(400);
    }
    const query = new URLSearchParams(await formOf(h));
    query.append('redirect_uri', 'http://127.0.0.1:1/other');
    expect((await h.consent({}, query.toString())).status).toBe(400);
    query.delete('redirect_uri');
    query.append('invite', 'room-invite');
    query.append('redirect_uri', REDIRECT_URI);
    expect((await h.consent({}, query.toString())).status).toBe(400);
  });

  it('reports a policy refusal or an unusable invite to the loopback listener', async () => {
    const denied = setup({ admissionPolicy: async () => 'deny' });
    expect(new URL((await denied.approve()).headers.get('location')!).searchParams.get('error')).toBe('access_denied');
    const expired = setup({ invite: () => 'expired' });
    expect(new URL((await expired.approve()).headers.get('location')!).searchParams.get('error')).toBe('invite_unavailable');
    const mismatch = setup({ invite: () => 'identity_mismatch' });
    for (const response of [await mismatch.consent(), await mismatch.approve()]) {
      expect(new URL(response.headers.get('location')!).searchParams.get('error')).toBe('access_denied');
    }
    expect(mismatch.store.keys('agent-bootstrap:code:')).toHaveLength(0);
  });

  it('requires an explicit admission policy', () => {
    expect(() => createAgentBootstrapHandlers({ ...({} as AgentBootstrapDeps), origin: ORIGIN, admissionPolicy: undefined as never })).toThrow(/G-ADMISSION/);
  });

  it('requires an explicit legacy migration write gate', () => {
    expect(() => setup({ legacyMigrationWritesEnabled: undefined as never })).toThrow(/migration write activation/);
  });
});

/** The consent form's fields, as the browser would submit them. */
async function formOf(h: Harness): Promise<[string, string][]> {
  const page = await (await h.consent()).text();
  return [...page.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map(match => [match[1]!, decodeEntities(match[2]!)]);
}

function decodeEntities(value: string): string {
  return value.replace(/&#(\d+);/g, (_, code: string) => String.fromCharCode(Number(code)));
}

describe('token exchange', () => {
  it('issues a short-lived grant for the code, verifier, session, redirect and key', async () => {
    const h = setup();
    const response = await h.exchange(await h.code());
    expect(response.status).toBe(200);
    const body = await response.json() as { grant: string; expires_at: number };
    expect(body.expires_at).toBe(T0 + 60_000);
    expect(storedText(h)).not.toContain(body.grant);
  });

  it('accepts each code once', async () => {
    const h = setup();
    const code = await h.code();
    expect((await h.exchange(code)).status).toBe(200);
    expect(await (await h.exchange(code)).json()).toEqual({ code: 'invalid_grant' });
  });

  it('lets exactly one of two racing exchanges of a code succeed', async () => {
    const h = setup();
    const code = await h.code();
    const responses = await Promise.all([h.exchange(code), h.exchange(code)]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 400]);
  });

  it('burns the code on a wrong verifier, session, device, generation or redirect URI', async () => {
    for (const change of [
      { code_verifier: randomBytes(32).toString('base64url') }, { session_id: 'thread-other' }, { device_id: 'KHALADEV2' }, { generation: 4 },
      { redirect_uri: 'http://127.0.0.1:49153/khala/callback/abc' },
    ]) {
      const h = setup();
      const code = await h.code();
      expect((await h.exchange(code, change)).status).toBe(400);
      expect((await h.exchange(code)).status).toBe(400);
    }
    const h = setup();
    expect(await (await h.exchange(await h.code(), { redirect_uri: undefined })).json()).toEqual({ code: 'invalid_request' });
  });

  it('refuses a proof from another key, for another target, stale, future, forged or malformed', async () => {
    const thief = connectorKey(() => T0);
    const tokenUrl = `${ORIGIN}${TOKEN_PATH}`;
    const now = Math.floor(T0 / 1000);
    const cases: { name: string; proof: (h: Harness) => string; code: string }[] = [
      { name: 'another key', proof: () => thief.proof(tokenUrl), code: 'proof_key_mismatch' },
      // Header names the bound key, but the signature is the thief's.
      { name: 'forged signature', proof: h => h.key.proof(tokenUrl, undefined, { signWith: thief.privateKey }), code: 'invalid_proof' },
      { name: 'redeem target', proof: h => h.key.proof(`${ORIGIN}${REDEEM_PATH}`), code: 'proof_target_mismatch' },
      { name: 'foreign issuer', proof: h => h.key.proof(`https://evil.example${TOKEN_PATH}`), code: 'proof_target_mismatch' },
      { name: 'wrong method', proof: h => h.key.proof(tokenUrl, undefined, { claims: { htm: 'GET' } }), code: 'proof_target_mismatch' },
      { name: 'ath without a token', proof: h => h.key.proof(tokenUrl, undefined, { claims: { ath: 'x'.repeat(43) } }), code: 'proof_token_mismatch' },
      { name: 'stale', proof: h => h.key.proof(tokenUrl, undefined, { claims: { iat: now - 120 } }), code: 'invalid_proof' },
      { name: 'future', proof: h => h.key.proof(tokenUrl, undefined, { claims: { iat: now + 30 } }), code: 'invalid_proof' },
      { name: 'wrong typ', proof: h => h.key.proof(tokenUrl, undefined, { header: { typ: 'jwt' } }), code: 'invalid_proof' },
      { name: 'private key in jwk', proof: h => h.key.proof(tokenUrl, undefined, { jwk: { ...h.key.privateKey.export({ format: 'jwk' }) } }), code: 'invalid_proof' },
      { name: 'short jti', proof: h => h.key.proof(tokenUrl, undefined, { claims: { jti: 'short' } }), code: 'invalid_proof' },
      { name: 'missing', proof: () => '', code: 'proof_required' },
    ];
    for (const { name, proof, code } of cases) {
      const h = setup();
      const response = await h.exchange(await h.code(), {}, proof(h));
      expect({ name, status: response.status, body: await response.json() }).toEqual({ name, status: 401, body: { code } });
    }
    const h = setup();
    const replayed = h.key.proof(tokenUrl);
    expect((await h.exchange(await h.code(), {}, replayed)).status).toBe(200);
    expect(await (await h.exchange(await h.code(), {}, replayed)).json()).toEqual({ code: 'proof_replayed' });
  });

  it('accepts a proof within the allowed future skew', async () => {
    const h = setup();
    const response = await h.exchange(await h.code(), {}, h.key.proof(`${ORIGIN}${TOKEN_PATH}`, undefined, { claims: { iat: Math.floor(T0 / 1000) + 5 } }));
    expect(response.status).toBe(200);
  });

  it('expires codes after 60 seconds', async () => {
    const h = setup();
    const code = await h.code();
    h.advance(60_000);
    expect((await h.exchange(code, {}, h.key.proof(`${ORIGIN}${TOKEN_PATH}`))).status).toBe(400);
  });
});

describe('redeem', () => {
  it('admits distinct participants for one owner and channel', async () => {
    const h = setup({
      agents: {
        inspect: async ({ session }) => ({
          kind: 'ok',
          value: {
            agentParticipantId: (session.sessionId === SESSION.session_id ? 'agent_1' : 'agent_2') as ParticipantId,
            roomId: 'room_1' as RoomId,
          },
        }),
      },
    });

    const first = await h.bootstrap();
    const second = await bootstrapSession(h, 'thread-existing-c', 'bootstrap-c-1');

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.binding.agentParticipantId).not.toBe(first.body.binding.agentParticipantId);
    expect(second.body.binding.bindingId).not.toBe(first.body.binding.bindingId);
    expect(await h.adapter(first.body.adapter_capability.token, 'publish_own')).toMatchObject({ kind: 'authorized' });
    expect(await h.adapter(second.body.adapter_capability.token, 'publish_own')).toMatchObject({ kind: 'authorized' });
  });

  it('passes the inspected verified session and address to admission', async () => {
    const inspected = {
      agentParticipantId: 'agent_distinctive' as ParticipantId,
      roomId: 'room_distinctive' as RoomId,
    };
    let admissionInput: Parameters<AgentAdmissionPort['admit']>[0] | undefined;
    const h = setup({
      agents: {
        inspect: async () => ({ kind: 'ok', value: inspected }),
        admit: async input => {
          admissionInput = input;
          expect(input.session).toEqual({ harness: 'codex', sessionId: 'thread-existing-b', generation: 3 });
          expect(input.expectedAgentParticipantId).toBe(inspected.agentParticipantId);
          expect(input.expectedRoomId).toBe(inspected.roomId);
          return { kind: 'ok', value: inspected };
        },
      },
    });

    expect((await h.redeem(await h.grant())).status).toBe(200);
    expect(admissionInput).toMatchObject({
      session: { harness: 'codex', sessionId: 'thread-existing-b', generation: 3 },
      expectedAgentParticipantId: inspected.agentParticipantId,
      expectedRoomId: inspected.roomId,
    });
  });

  it('refreshes and revokes one participant without changing another participant authority', async () => {
    const h = setup({
      agents: {
        inspect: async ({ session }) => ({
          kind: 'ok',
          value: {
            agentParticipantId: (session.sessionId === SESSION.session_id ? 'agent_a' : 'agent_b') as ParticipantId,
            roomId: 'room_1' as RoomId,
          },
        }),
      },
    });
    const firstA = (await h.bootstrap()).body;
    const participantB = (await bootstrapSession(h, 'thread-existing-c', 'bootstrap-c-1')).body;
    const refreshedA = (await h.bootstrap(SESSION.generation, 'bootstrap-a-2')).body;

    expect(refreshedA.binding.bindingId).toBe(firstA.binding.bindingId);
    expect(await h.adapter(firstA.adapter_capability.token, 'publish_own')).toMatchObject({ code: 'binding_superseded' });
    expect(await h.adapter(refreshedA.adapter_capability.token, 'publish_own')).toMatchObject({ kind: 'authorized' });
    expect(await h.adapter(participantB.adapter_capability.token, 'publish_own')).toMatchObject({ kind: 'authorized' });

    await h.handlers.capabilities.revokeAdapterCapability({
      operationId: 'revoke-a', bindingId: refreshedA.binding.bindingId as BindingId, revokedGeneration: SESSION.generation,
    });
    expect(await h.adapter(refreshedA.adapter_capability.token, 'publish_own')).toMatchObject({ code: 'binding_revoked' });
    expect(await h.adapter(participantB.adapter_capability.token, 'publish_own')).toMatchObject({ kind: 'authorized' });
  });

  it('converges independent grants for one session on one binding and admission commit', async () => {
    const h = setup();
    const [grantA, grantB] = await Promise.all([h.grant(), h.grant()]);
    const responses = await Promise.all([
      h.redeem(grantA, 'independent-a'),
      h.redeem(grantB, 'independent-b'),
    ]);
    const bodies = await Promise.all(responses.map(response => response.json() as Promise<Redeemed>));

    expect(responses.map(response => response.status)).toEqual([200, 200]);
    expect(bodies[0]!.binding.bindingId).toBe(bodies[1]!.binding.bindingId);
    expect(h.admits).toEqual(['KHALADEV1']);
    expect(new Set(h.admitOperations).size).toBe(1);
    const authorization = await Promise.all(bodies.map(body => h.adapter(body.adapter_capability.token, 'publish_own')));
    expect(authorization.filter(result => result.kind === 'authorized')).toHaveLength(1);
    expect(authorization.filter(result => result.kind === 'refused' && result.code === 'binding_superseded')).toHaveLength(1);
  });

  it('admits only the winner when different first-time sessions race for one participant', async () => {
    const h = setup();
    const otherSession = { session_id: 'thread-existing-c' };
    const [grantA, grantB] = await Promise.all([
      h.grant(),
      h.grant(otherSession, otherSession),
    ]);

    const responses = await Promise.all([
      h.redeem(grantA, 'session-race-a'),
      h.redeem(grantB, 'session-race-b', otherSession),
    ]);

    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    expect(h.admits).toHaveLength(1);
  });

  it('admits only the winner when different first-time devices race for one participant', async () => {
    const h = setup();
    const otherDevice = { device_id: 'KHALADEV2' };
    const [grantA, grantB] = await Promise.all([
      h.grant(),
      h.grant(otherDevice, otherDevice),
    ]);

    const responses = await Promise.all([
      h.redeem(grantA, 'device-race-a'),
      h.redeem(grantB, 'device-race-b', otherDevice),
    ]);

    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    expect(h.admits).toHaveLength(1);
  });

  it('binds the owner, agent participant, device and existing session, with the narrow adapter capability', async () => {
    const h = setup();
    const response = await h.redeem(await h.grant());
    expect(response.status).toBe(200);
    const body = await response.json() as Redeemed;
    expect(body.binding).toMatchObject({
      v: 1, ownerId: 'owner_b', agentParticipantId: 'agent_owner_b', deviceId: 'KHALADEV1', harness: 'codex', sessionId: 'thread-existing-b', generation: 3,
    });
    expect(body.binding.agentParticipantId).not.toBe(body.binding.ownerId);
    expect(body.adapter_capability).toEqual({
      token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), token_type: 'DPoP', scope: ['publish_own', 'receive_released', 'ack_delivery'],
      binding_id: body.binding.bindingId, generation: 3, expires_at: T0 + 3_600_000,
    });
    expect(Object.keys(body)).toEqual(['binding', 'adapter_capability']);
    expect(storedText(h)).not.toContain(body.adapter_capability.token);
  });

  it('spends the grant: presenting it again, even for the same operation, issues nothing', async () => {
    const h = setup();
    const grant = await h.grant();
    expect((await h.redeem(grant)).status).toBe(200);
    for (const operationId of ['bootstrap-b-1', 'bootstrap-other']) {
      const again = await h.redeem(grant, operationId);
      expect(again.status).toBe(401);
      expect(await again.json()).toEqual({ code: 'grant_replayed' });
    }
    expect(h.admits).toHaveLength(1);
    expect(h.store.keys('agent-bootstrap:capability:')).toHaveLength(1);
  });

  it('resumes a retry of the same operation after a failure without admitting again', async () => {
    const h = setup({
      agents: {
        async admit({ ownerId, deviceId }) {
          h.admits.push(deviceId);
          // The binding read right after admission fails once.
          h.store.inject('read', 'unavailable');
          return { kind: 'ok', value: { agentParticipantId: `agent_${ownerId}` as ParticipantId, roomId: 'room_1' as RoomId } };
        },
      },
    });
    const grant = await h.grant();
    expect((await h.redeem(grant)).status).toBe(503);
    expect(await (await h.redeem(grant, 'bootstrap-other')).json()).toEqual({ code: 'grant_replayed' });
    expect((await h.redeem(grant)).status).toBe(200);
    expect(h.admits).toEqual(['KHALADEV1']);
  });

  it('issues one capability when two retries of the admitted operation race', async () => {
    let failNext = true;
    const h = setup({
      agents: {
        async admit({ ownerId }) {
          if (failNext) h.store.inject('read', 'unavailable');
          failNext = false;
          return { kind: 'ok', value: { agentParticipantId: `agent_${ownerId}` as ParticipantId, roomId: 'room_1' as RoomId } };
        },
      },
    });
    const grant = await h.grant();
    expect((await h.redeem(grant)).status).toBe(503);
    const responses = await Promise.all([h.redeem(grant), h.redeem(grant)]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 401]);
    expect(h.store.keys('agent-bootstrap:capability:')).toHaveLength(1);
  });

  it('AE1: a new setup of the same session and device returns the same binding', async () => {
    const h = setup();
    const first = await (await h.redeem(await h.grant())).json() as Redeemed;
    const reconnect = await (await h.redeem(await h.grant(), 'bootstrap-b-2')).json() as Redeemed;
    expect(reconnect.binding).toEqual(first.binding);
    expect(reconnect.adapter_capability.token).not.toBe(first.adapter_capability.token);
  });

  it('lets exactly one of two racing redeems of a grant succeed, whatever their operation IDs', async () => {
    for (const operations of [['bootstrap-b-1', 'bootstrap-b-2'], ['bootstrap-b-1', 'bootstrap-b-1']]) {
      const h = setup();
      const grant = await h.grant();
      const responses = await Promise.all(operations.map(operationId => h.redeem(grant, operationId)));
      expect(responses.map(response => response.status).sort()).toEqual([200, 401]);
      expect(h.store.keys('agent-bootstrap:capability:')).toHaveLength(1);
    }
  });

  it('refuses a grant expired or held by another key', async () => {
    const late = setup();
    const lateGrant = await late.grant();
    late.advance(60_000);
    expect(await (await late.redeem(lateGrant)).json()).toEqual({ code: 'invalid_grant' });

    const stolen = setup();
    const stolenGrant = await stolen.grant();
    const thief = connectorKey(() => T0);
    expect(await (await stolen.redeem(stolenGrant, 'bootstrap-b-1', {}, thief.proof(`${ORIGIN}${REDEEM_PATH}`, stolenGrant))).json())
      .toEqual({ code: 'proof_key_mismatch' });
    expect(await (await stolen.redeem(stolenGrant, 'bootstrap-b-1', {}, stolen.key.proof(`${ORIGIN}${REDEEM_PATH}`))).json())
      .toEqual({ code: 'proof_token_mismatch' });
    const wrongAth = stolen.key.proof(`${ORIGIN}${REDEEM_PATH}`, stolenGrant, { claims: { ath: createHash('sha256').update('other').digest('base64url') } });
    expect(await (await stolen.redeem(stolenGrant, 'bootstrap-b-1', {}, wrongAth)).json()).toEqual({ code: 'proof_token_mismatch' });
    expect(stolen.admits).toHaveLength(0);
  });

  it('refuses a substituted session, generation or device', async () => {
    for (const change of [{ session_id: 'thread-other' }, { generation: 4 }, { device_id: 'KHALADEV2' }]) {
      const h = setup();
      expect((await h.redeem(await h.grant(), 'bootstrap-b-1', change)).status).toBe(401);
    }
  });

  it('refuses a human session cookie in place of a grant', async () => {
    const h = setup();
    const response = await h.route(REDEEM_PATH).handle(new Request(`${ORIGIN}${REDEEM_PATH}`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: '__Host-khala_session=x', origin: ORIGIN },
      body: JSON.stringify({ operation_id: 'bootstrap-b-1', ...SESSION, device_id: 'KHALADEV1' }),
    }));
    expect(response.status).toBe(401);
  });

  it('AE2: a forwarded link binds the stranger’s own agent, never the creator’s', async () => {
    let owner = 'owner_a';
    const h = setup({ signedIn: () => owner });
    const creator = await (await h.redeem(await h.grant())).json() as Redeemed;
    owner = 'owner_stranger';
    const stranger = await (await h.redeem(await h.grant(), 'bootstrap-s-1')).json() as Redeemed;
    expect(creator.binding.ownerId).toBe('owner_a');
    expect(stranger.binding.ownerId).toBe('owner_stranger');
    expect(stranger.binding.bindingId).not.toBe(creator.binding.bindingId);
  });

  it('does not let another session or generation of the same owner take over the room binding', async () => {
    const h = setup();
    expect((await h.redeem(await h.grant())).status).toBe(200);
    const admitted = h.admits.length;
    for (const [change, operationId] of [[{ session_id: 'thread-other' }, 'bootstrap-b-2'], [{ generation: '4' }, 'bootstrap-b-3']] as const) {
      const bodyChange = 'generation' in change ? { generation: 4 } : change;
      const response = await h.redeem(await h.grant(change, bodyChange), operationId, bodyChange);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ code: 'binding_conflict' });
    }
    // The conflicting sessions' devices never joined the room.
    expect(h.admits).toHaveLength(admitted);
  });

  it('does not reserve a new session when the participant binding verdict conflicts', async () => {
    let secondParticipant = 'agent_owner_b';
    const h = setup({
      agents: {
        inspect: async ({ ownerId, session }) => ({
          kind: 'ok',
          value: {
            agentParticipantId: (session.sessionId === SESSION.session_id ? `agent_${ownerId}` : secondParticipant) as ParticipantId,
            roomId: 'room_1' as RoomId,
          },
        }),
      },
    });
    expect((await h.bootstrap()).status).toBe(200);
    expect((await bootstrapSession(h, 'thread-existing-c', 'bootstrap-c-1')).body).toEqual({ code: 'binding_conflict' });
    expect(h.admits).toHaveLength(1);

    secondParticipant = 'agent_second';
    const distinct = await bootstrapSession(h, 'thread-existing-c', 'bootstrap-c-2');
    expect(distinct.status).toBe(200);
    expect(distinct.body.binding.agentParticipantId).toBe('agent_second');
  });

  it('refuses a valid grant for a changed device before admission commit', async () => {
    const h = setup();
    expect((await h.bootstrap()).status).toBe(200);
    const admitted = h.admits.length;
    const response = await bootstrapSession(h, SESSION.session_id, 'bootstrap-device-2', 'KHALADEV2');
    expect(response).toEqual({ status: 409, body: { code: 'binding_conflict' } });
    expect(h.admits).toHaveLength(admitted);
  });

  it('refuses a reconnect whose admission names another agent participant', async () => {
    let participant = 'agent_one';
    const h = setup({
      agents: { inspect: async () => ({ kind: 'ok', value: { agentParticipantId: participant as ParticipantId, roomId: 'room_1' as RoomId } }) },
    });
    expect((await h.redeem(await h.grant())).status).toBe(200);
    const admitted = h.admits.length;
    participant = 'agent_two';
    const response = await h.redeem(await h.grant(), 'bootstrap-b-2');
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: 'binding_conflict' });
    expect(h.admits).toHaveLength(admitted);
  });

  it('derives admission identity from the binding rather than the client operation ID', async () => {
    let owner = 'owner_a';
    const h = setup({ signedIn: () => owner });
    await h.redeem(await h.grant(), 'shared-operation');
    owner = 'owner_b';
    await h.redeem(await h.grant(), 'shared-operation');
    expect(h.admitOperations).toHaveLength(2);
    expect(h.admitOperations[0]).not.toBe(h.admitOperations[1]);
    expect(h.admitOperations.join()).not.toContain('shared-operation');
  });

  it('refuses admission commit drift from the inspected room or participant', async () => {
    for (const value of [
      { agentParticipantId: 'agent_x' as ParticipantId, roomId: 'room_2' as RoomId },
      { agentParticipantId: 'agent_y' as ParticipantId, roomId: 'room_1' as RoomId },
    ]) {
      const h = setup({
        agents: {
          inspect: async () => ({ kind: 'ok', value: { agentParticipantId: 'agent_x' as ParticipantId, roomId: 'room_1' as RoomId } }),
          admit: async () => ({ kind: 'ok', value }),
        },
      });
      const response = await h.redeem(await h.grant());
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ code: 'admission_denied' });
    }
  });

  it('maps admission refusals and unknown outcomes', async () => {
    const refused = setup({ agents: { admit: async () => ({ kind: 'rejected', code: 'forbidden' }) } });
    expect((await refused.redeem(await refused.grant())).status).toBe(403);
    const unknown = setup({ agents: { admit: async () => ({ kind: 'outcome_unknown', operationId: 'x' }) } });
    expect((await unknown.redeem(await unknown.grant())).status).toBe(502);
    const throwing = setup({ agents: { admit: async () => { throw new Error('admin-token=secret'); } } });
    const response = await throwing.redeem(await throwing.grant());
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('secret');
  });
});

describe('adapter capability', () => {
  it('migrates an active legacy binding while keeping its capability authorized', async () => {
    const h = setup();
    const bootstrapped = (await h.bootstrap()).body;
    moveBindingToLegacy(h, bootstrapped.binding);

    expect(await h.adapter(bootstrapped.adapter_capability.token, 'publish_own')).toMatchObject({
      kind: 'authorized', binding: { bindingId: bootstrapped.binding.bindingId },
    });
    const legacy = h.store.records.get(agentBindingStoreKeys.legacy('owner_b', 'room_1'));
    expect(legacy?.value).toMatchObject({ kind: 'binding_forward', agentParticipantId: bootstrapped.binding.agentParticipantId });
  });

  it('migrates a revoked legacy binding and only re-arms its later generation', async () => {
    const h = setup();
    const first = (await h.bootstrap()).body;
    await h.handlers.capabilities.revokeAdapterCapability({
      operationId: 'revoke-legacy', bindingId: first.binding.bindingId as BindingId, revokedGeneration: 4,
    });
    moveBindingToLegacy(h, first.binding);
    const admitted = h.admits.length;

    expect(await h.bootstrap(3, 'legacy-g3')).toEqual({ status: 409, body: { code: 'binding_revoked' } });
    expect(h.admits).toHaveLength(admitted);
    const rebound = await h.bootstrap(4, 'legacy-g4');
    expect(rebound.status).toBe(200);
    expect(rebound.body.binding.bindingId).not.toBe(first.binding.bindingId);
    expect(await h.adapter(rebound.body.adapter_capability.token, 'publish_own')).toMatchObject({ kind: 'authorized' });
  });

  it('grants exactly publish_own, receive_released and ack_delivery, and nothing that approves or sets policy', async () => {
    const h = setup();
    const { body } = await h.bootstrap();
    const token = body.adapter_capability.token;
    for (const action of ADAPTER_CAPABILITIES) {
      expect(await h.adapter(token, action)).toMatchObject({ kind: 'authorized', action, binding: { bindingId: body.binding.bindingId, generation: 3 } });
    }
    for (const action of ['approve', 'release', 'set_policy', 'revoke', '']) {
      expect(await h.adapter(token, action)).toEqual({ kind: 'refused', status: 403, code: 'capability_not_granted' });
    }
  });

  it('is sender-constrained to the connector key and this request', async () => {
    const h = setup();
    const token = (await h.bootstrap()).body.adapter_capability.token;
    const thief = connectorKey(() => T0);
    expect(await h.adapter(token, 'publish_own', thief.proof(ADAPTER_URL, token))).toMatchObject({ code: 'proof_key_mismatch' });
    expect(await h.adapter(token, 'publish_own', h.key.proof(`${ORIGIN}/api/agent/adapter/other`, token))).toMatchObject({ code: 'proof_target_mismatch' });
    expect(await h.adapter(token, 'publish_own', h.key.proof(ADAPTER_URL))).toMatchObject({ code: 'proof_token_mismatch' });
    expect(await h.adapter('A'.repeat(43), 'publish_own')).toMatchObject({ code: 'invalid_capability' });
    const bare = await h.handlers.capabilities.authorize(new Request(ADAPTER_URL, { method: 'POST' }), 'publish_own');
    expect(bare).toMatchObject({ code: 'capability_required' });
  });

  it('refuses a revoked binding’s capability, and revocation is idempotent', async () => {
    const h = setup();
    const { body } = await h.bootstrap();
    const revoke = { operationId: 'revoke-1', bindingId: body.binding.bindingId as BindingId, revokedGeneration: 4 };
    expect(await h.handlers.capabilities.revokeAdapterCapability(revoke)).toEqual({ kind: 'applied' });
    expect(await h.handlers.capabilities.revokeAdapterCapability(revoke)).toEqual({ kind: 'applied' });
    expect(await h.adapter(body.adapter_capability.token, 'publish_own')).toEqual({ kind: 'refused', status: 401, code: 'binding_revoked' });
    expect(await h.handlers.capabilities.revokeAdapterCapability({ ...revoke, bindingId: 'bnd_unknown' as BindingId })).toEqual({ kind: 'applied' });
  });

  it('never revives a revoked binding: re-bootstrap needs the revoked generation and gets a new binding and authority', async () => {
    const h = setup();
    const first = (await h.bootstrap()).body;
    await h.handlers.capabilities.revokeAdapterCapability({ operationId: 'revoke-1', bindingId: first.binding.bindingId as BindingId, revokedGeneration: 4 });
    const admitted = h.admits.length;

    for (const generation of [2, 3]) {
      const again = await h.bootstrap(generation, `bootstrap-b-g${generation}`);
      expect(again).toEqual({ status: 409, body: { code: 'binding_revoked' } });
    }
    expect(h.admits).toHaveLength(admitted);

    const rebound = await h.bootstrap(4, 'bootstrap-b-g4');
    expect(rebound.status).toBe(200);
    expect(rebound.body.binding.bindingId).not.toBe(first.binding.bindingId);
    expect(rebound.body.binding.generation).toBe(4);
    expect(await h.adapter(rebound.body.adapter_capability.token, 'publish_own')).toMatchObject({ kind: 'authorized' });
    expect(await h.adapter(first.adapter_capability.token, 'publish_own')).toMatchObject({ kind: 'refused', status: 401 });
    // Revoking the old binding again cannot touch the new one.
    await h.handlers.capabilities.revokeAdapterCapability({ operationId: 'revoke-2', bindingId: first.binding.bindingId as BindingId, revokedGeneration: 4 });
    expect(await h.adapter(rebound.body.adapter_capability.token, 'publish_own')).toMatchObject({ kind: 'authorized' });
  });

  it('refuses a superseded capability once the binding is re-keyed', async () => {
    const h = setup();
    const first = (await h.bootstrap()).body;
    const second = (await h.bootstrap(3, 'bootstrap-b-2')).body;
    expect(second.binding.bindingId).toBe(first.binding.bindingId);
    expect(await h.adapter(first.adapter_capability.token, 'publish_own')).toEqual({ kind: 'refused', status: 401, code: 'binding_superseded' });
    expect(await h.adapter(second.adapter_capability.token, 'publish_own')).toMatchObject({ kind: 'authorized' });
  });

  it('is bound to its binding ID and generation', async () => {
    for (const change of [{ generation: 4 }, { bindingId: 'bnd_other' }]) {
      const h = setup();
      const token = (await h.bootstrap()).body.adapter_capability.token;
      const [storeKey] = h.store.keys('agent-bootstrap:binding:');
      const record = h.store.records.get(storeKey!)!;
      const value = record.value as { binding: Record<string, unknown> };
      h.store.records.set(storeKey!, { ...record, value: { ...value, binding: { ...value.binding, ...change } } });
      expect(await h.adapter(token, 'publish_own')).toEqual({ kind: 'refused', status: 401, code: 'binding_superseded' });
    }
  });

  it('expires with its lifetime', async () => {
    const h = setup();
    const token = (await h.bootstrap()).body.adapter_capability.token;
    h.advance(3_600_000);
    expect(await h.adapter(token, 'publish_own', h.key.proof(ADAPTER_URL, token))).toMatchObject({ code: 'invalid_capability' });
  });
});

describe('revocation composition (KHA-136)', () => {
  /** KHA-128's service bound to the bootstrap handlers, as the control composition root binds it. */
  function revocation(h: Harness, ownerId = 'owner_b') {
    const targets: RevocationTargets = {
      async lookup(subject) {
        if (subject.targetKind !== 'binding') return { kind: 'absent' };
        const found = await h.handlers.capabilities.lookupBinding(subject.targetId);
        if (found.kind !== 'found') return found;
        return { kind: 'found', ownerId: found.ownerId, generation: found.generation, device: { deviceId: found.deviceId as DeviceId, deviceKey: 'curve-key-1' } };
      },
    };
    const protocol: ProtocolRevocationPort = {
      removeDevice: async () => ({ kind: 'removed' }),
      deviceStatus: async () => ({ kind: 'removed' }),
      rotateSessions: async () => ({ kind: 'rotated' }),
    };
    return createRevocationService({
      principal: principal(ownerId),
      journal: fakeStore(() => T0).store,
      targets,
      control: {
        disable: input => (input.targetKind === 'binding' ? h.handlers.capabilities.disableBinding({ ...input, bindingId: input.targetId }) : Promise.resolve({ kind: 'unavailable' })),
        revokeAdapterCapability: input => h.handlers.capabilities.revokeAdapterCapability(input),
      },
      protocol,
    });
  }

  it('looks a binding up by ID with the authoritative generation and status', async () => {
    const h = setup();
    const { body } = await h.bootstrap();
    const bindingId = body.binding.bindingId as BindingId;
    expect(await h.handlers.capabilities.lookupBinding(bindingId)).toEqual({
      kind: 'found', ownerId: 'owner_b', deviceId: 'KHALADEV1', generation: 3, status: 'active',
    });
    await h.handlers.capabilities.revokeAdapterCapability({ operationId: 'revoke-1', bindingId, revokedGeneration: 4 });
    expect(await h.handlers.capabilities.lookupBinding(bindingId)).toMatchObject({ generation: 4, status: 'revoked' });
    expect(await h.handlers.capabilities.lookupBinding('bnd_unknown')).toEqual({ kind: 'absent' });
    h.store.inject('read', 'unavailable');
    expect(await h.handlers.capabilities.lookupBinding(bindingId)).toEqual({ kind: 'unavailable' });
  });

  it('disables a binding once, idempotently, and only at its expected generation', async () => {
    const h = setup();
    const { body } = await h.bootstrap();
    const bindingId = body.binding.bindingId as BindingId;
    const input = { operationId: 'revoke-1', bindingId, expectedGeneration: 3, revokedGeneration: 4 };
    expect(await h.handlers.capabilities.disableBinding({ ...input, expectedGeneration: 2, revokedGeneration: 3 })).toEqual({ kind: 'stale' });
    expect(await h.handlers.capabilities.disableBinding(input)).toEqual({ kind: 'applied' });
    expect(await h.handlers.capabilities.disableBinding(input)).toEqual({ kind: 'applied' });
    expect(await h.adapter(body.adapter_capability.token, 'receive_released')).toEqual({ kind: 'refused', status: 401, code: 'binding_revoked' });
    expect(await h.handlers.capabilities.disableBinding({ ...input, revokedGeneration: 5 })).toEqual({ kind: 'stale' });
    expect(await h.handlers.capabilities.disableBinding({ ...input, bindingId: 'bnd_unknown' as BindingId })).toEqual({ kind: 'stale' });
  });

  it('revokes through the KHA-128 port, then re-bootstraps one generation later with new authority', async () => {
    const h = setup();
    const first = (await h.bootstrap()).body;
    const bindingId = first.binding.bindingId as BindingId;
    const service = revocation(h);

    expect(await service.revoke({ operationId: 'revoke-1', targetKind: 'binding', targetId: bindingId, expectedGeneration: 3 })).toEqual({
      kind: 'ok', value: { operationId: 'revoke-1', targetKind: 'binding', targetId: bindingId, generation: 4, state: 'partial' },
    });
    const status = await service.status('revoke-1');
    expect(status).toMatchObject({ kind: 'ok', value: { control: 'disabled', capability: 'revoked', removal: 'removed', rotation: 'rotated' } });
    expect(await h.adapter(first.adapter_capability.token, 'publish_own')).toEqual({ kind: 'refused', status: 401, code: 'binding_revoked' });
    // A stale request for the old generation cannot revoke again.
    expect(await service.revoke({ operationId: 'revoke-2', targetKind: 'binding', targetId: bindingId, expectedGeneration: 3 }))
      .toEqual({ kind: 'rejected', code: 'stale_generation' });

    expect(await h.bootstrap(3, 'bootstrap-b-again')).toEqual({ status: 409, body: { code: 'binding_revoked' } });
    const rebound = await h.bootstrap(4, 'bootstrap-b-g4');
    expect(rebound.status).toBe(200);
    expect(rebound.body.binding.bindingId).not.toBe(bindingId);
    expect(await h.adapter(rebound.body.adapter_capability.token, 'publish_own')).toMatchObject({ kind: 'authorized' });
    // The replaced binding is absent, so a retried revocation converges without touching the new one.
    expect(await service.revoke({ operationId: 'revoke-1', targetKind: 'binding', targetId: bindingId, expectedGeneration: 3 }))
      .toMatchObject({ kind: 'ok', value: { state: 'partial' } });
    expect(await h.adapter(rebound.body.adapter_capability.token, 'publish_own')).toMatchObject({ kind: 'authorized' });
    expect(await h.handlers.capabilities.lookupBinding(rebound.body.binding.bindingId)).toMatchObject({ generation: 4, status: 'active' });
  });

  it('refuses another owner revoking the binding', async () => {
    const h = setup();
    const { body } = await h.bootstrap();
    expect(await revocation(h, 'owner_other').revoke({
      operationId: 'revoke-1', targetKind: 'binding', targetId: body.binding.bindingId as BindingId, expectedGeneration: 3,
    })).toEqual({ kind: 'rejected', code: 'forbidden' });
    expect(await h.adapter(body.adapter_capability.token, 'publish_own')).toMatchObject({ kind: 'authorized' });
  });

  it('issues nothing usable when revocation lands between binding and capability issue', async () => {
    const backing = fakeStore(() => T0);
    let revokeBeforeIssue: (() => Promise<unknown>) | null = null;
    const store: ControlStore = {
      ...backing.store,
      async compareAndSet(input) {
        if (revokeBeforeIssue && input.key.startsWith('agent-bootstrap:capability:')) {
          const revoke = revokeBeforeIssue;
          revokeBeforeIssue = null;
          await revoke();
        }
        return backing.store.compareAndSet(input);
      },
    };
    const h = setup({ store });
    revokeBeforeIssue = async () => {
      const [bindingKey] = backing.keys('agent-bootstrap:binding:');
      const bindingId = (backing.records.get(bindingKey!)!.value as { binding: { bindingId: BindingId } }).binding.bindingId;
      await h.handlers.capabilities.disableBinding({ operationId: 'revoke-race', bindingId, expectedGeneration: 3, revokedGeneration: 4 });
    };

    const response = await h.bootstrap();
    expect(response).toEqual({ status: 409, body: { code: 'binding_revoked' } });
    // The capability record written before the revocation is never pointed to by the binding.
    expect(backing.keys('agent-bootstrap:capability:')).toHaveLength(1);
    const [bindingKey] = backing.keys('agent-bootstrap:binding:');
    expect(backing.records.get(bindingKey!)!.value).toMatchObject({ revokedGeneration: 4, capability: null });
  });
});
