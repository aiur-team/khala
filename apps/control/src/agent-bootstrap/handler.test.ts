// Route-level tests with injected doubles. They prove module behaviour only; the
// real provider, store and substrate proof belongs to KHA-133/139.

import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject, createPublicKey } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AuthPrincipal, InviteState, OwnerId, ParticipantId, RoomId } from '@khala/contracts/messaging/index';
import type { Authentication } from '../auth/index';
import { T0, fakeStore, secureRandom } from '../auth/support.test';
import {
  AUTHORIZE_PATH, type AgentAdmissionPort, type AgentBootstrapDeps, DESCRIPTOR_PATH, REDEEM_PATH, TOKEN_PATH, createAgentBootstrapHandlers,
} from './handler';
import { thumbprint } from './proof';

const ORIGIN = 'https://khala.aiur.team';
const SESSION = { harness: 'codex', session_id: 'thread-existing-b', generation: 3 };

function principal(ownerId: string): AuthPrincipal {
  return {
    v: 1, ownerId: ownerId as OwnerId, providerIssuer: 'https://id.example.test', providerSubject: `sub-${ownerId}`,
    verifiedEmail: `${ownerId}@example.test`, sessionExpiresAt: '2026-09-18T20:00:00Z',
  };
}

/** Test-side connector key: signs proofs exactly as `@khala/connector/bootstrap/proof` does. */
function connectorKey(clock: () => number) {
  const { privateKey } = generateKeyPairSync('ed25519');
  const x = createPublicKey(privateKey).export({ format: 'jwk' }).x!;
  return {
    jkt: thumbprint(x),
    proof(url: string, accessToken?: string, overrides: Record<string, unknown> = {}, key: KeyObject = privateKey) {
      const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'dpop+jwt', jwk: { kty: 'OKP', crv: 'Ed25519', x } })).toString('base64url');
      const claims: Record<string, unknown> = { htm: 'POST', htu: url, iat: Math.floor(clock() / 1000), jti: randomBytes(16).toString('base64url'), ...overrides };
      if (accessToken !== undefined && !('ath' in overrides)) claims.ath = createHash('sha256').update(accessToken).digest('base64url');
      const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
      return `${header}.${payload}.${sign(null, Buffer.from(`${header}.${payload}`), key).toString('base64url')}`;
    },
  };
}

type SetupOverrides = Partial<Omit<AgentBootstrapDeps, 'agents'>> & {
  agents?: Partial<AgentAdmissionPort>;
  signedIn?: () => string | null;
  invite?: () => InviteState;
};

function setup(overrides: SetupOverrides = {}) {
  let now = T0;
  const clock = () => now;
  const store = fakeStore(clock);
  const admits: string[] = [];
  const admitOperations: string[] = [];
  const deps: AgentBootstrapDeps = {
    origin: ORIGIN,
    store: store.store,
    clock,
    random: secureRandom,
    async authenticate(): Promise<Authentication> {
      const owner = overrides.signedIn ? overrides.signedIn() : 'owner_b';
      return owner === null ? { kind: 'signed_out' } : { kind: 'authenticated', context: { principal: principal(owner), csrfToken: 'csrf' } };
    },
    inviteFromLink: url => (url.pathname.startsWith('/i/') ? url.pathname.slice(3) : null),
    admissionFor: () => ({ inspect: async () => overrides.invite?.() ?? 'eligible' }),
    admissionPolicy: async () => 'allow',
    agents: {
      room: async () => ({ kind: 'ok', value: 'room_1' as RoomId }),
      async admit({ ownerId, deviceId, operationId }) {
        admits.push(deviceId);
        admitOperations.push(operationId);
        return { kind: 'ok', value: { agentParticipantId: `agent_${ownerId}` as ParticipantId, roomId: 'room_1' as RoomId } };
      },
    },
    devices: { issue: async () => ({ kind: 'ok', value: { secret: 'device-login-secret', expiresAt: T0 + 60_000 } }) },
  };
  Object.assign(deps, { ...overrides, agents: { ...deps.agents, ...overrides.agents } });
  const handlers = createAgentBootstrapHandlers(deps);
  const route = (path: string) => [...handlers.agent, ...handlers.human].find(entry => entry.path === path)!;
  const key = connectorKey(clock);
  const verifier = randomBytes(32).toString('base64url');

  async function authorize(params: Record<string, string> = {}) {
    const url = new URL(`${ORIGIN}${AUTHORIZE_PATH}`);
    url.search = new URLSearchParams({
      invite: 'room-invite', harness: SESSION.harness, session_id: SESSION.session_id, generation: String(SESSION.generation),
      device_id: 'KHALADEV1', jkt: key.jkt, redirect_uri: 'http://127.0.0.1:49152/khala/callback/abc',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
      state: 'state-0123456789abcdef', ...params,
    }).toString();
    return route(AUTHORIZE_PATH).handle(new Request(url, { headers: { cookie: '__Host-khala_session=x' } }));
  }

  async function code(params: Record<string, string> = {}) {
    const response = await authorize(params);
    return new URL(response.headers.get('location')!).searchParams.get('code')!;
  }

  function post(path: string, body: Record<string, unknown>, headers: Record<string, string>) {
    return route(path).handle(new Request(`${ORIGIN}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers }, body: JSON.stringify(body),
    }));
  }

  async function exchange(oneTimeCode: string, overrides: Record<string, unknown> = {}, proof = key.proof(`${ORIGIN}${TOKEN_PATH}`)) {
    return post(TOKEN_PATH, { code: oneTimeCode, code_verifier: verifier, ...SESSION, device_id: 'KHALADEV1', ...overrides }, { dpop: proof });
  }

  async function grant() {
    const response = await exchange(await code());
    return ((await response.json()) as { grant: string }).grant;
  }

  async function redeem(bootstrapGrant: string, operationId = 'bootstrap-b-1', overrides: Record<string, unknown> = {}, proof?: string) {
    return post(REDEEM_PATH, { operation_id: operationId, ...SESSION, device_id: 'KHALADEV1', ...overrides }, {
      authorization: `DPoP ${bootstrapGrant}`, dpop: proof ?? key.proof(`${ORIGIN}${REDEEM_PATH}`, bootstrapGrant),
    });
  }

  return { route, key, authorize, code, exchange, grant, redeem, store, admits, admitOperations, advance: (ms: number) => { now += ms; } };
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
  it('sends a signed-out browser to sign-in and back', async () => {
    const h = setup({ signedIn: () => null });
    const response = await h.authorize();
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get('location')!);
    expect(location.pathname).toBe('/api/human/auth/login');
    expect(location.searchParams.get('return_to')).toMatch(/^\/api\/human\/agent-bootstrap\/authorize\?/);
  });

  it('returns a one-time code only to a loopback redirect, and never stores it raw', async () => {
    const h = setup();
    const response = await h.authorize();
    const location = new URL(response.headers.get('location')!);
    expect(location.origin).toBe('http://127.0.0.1:49152');
    expect(location.searchParams.get('state')).toBe('state-0123456789abcdef');
    const code = location.searchParams.get('code')!;
    expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify([...h.store.records.entries()])).not.toContain(code);
  });

  it('refuses non-loopback, localhost, portless and credentialed redirects without redirecting', async () => {
    const h = setup();
    for (const redirect of ['https://evil.example/cb', 'http://localhost:4000/cb', 'http://127.0.0.1/cb', 'http://u@127.0.0.1:4000/cb', 'http://127.0.0.1:4000/cb#x']) {
      const response = await h.authorize({ redirect_uri: redirect });
      expect(response.status).toBe(400);
      expect(response.headers.get('location')).toBeNull();
    }
  });

  it('reports a policy refusal or an unusable invite to the loopback listener', async () => {
    const denied = setup({ admissionPolicy: async () => 'deny' });
    expect(new URL((await denied.authorize()).headers.get('location')!).searchParams.get('error')).toBe('access_denied');
    const expired = setup({ invite: () => 'expired' });
    expect(new URL((await expired.authorize()).headers.get('location')!).searchParams.get('error')).toBe('invite_unavailable');
  });

  it('requires an explicit admission policy', () => {
    expect(() => createAgentBootstrapHandlers({ ...({} as AgentBootstrapDeps), origin: ORIGIN, admissionPolicy: undefined as never })).toThrow(/G-ADMISSION/);
  });
});

describe('token exchange', () => {
  it('issues a short-lived grant for the code, verifier, session and key', async () => {
    const h = setup();
    const response = await h.exchange(await h.code());
    expect(response.status).toBe(200);
    const body = await response.json() as { grant: string; expires_at: number };
    expect(body.expires_at).toBe(T0 + 60_000);
    expect(JSON.stringify([...h.store.records.entries()])).not.toContain(body.grant);
  });

  it('accepts each code once', async () => {
    const h = setup();
    const code = await h.code();
    expect((await h.exchange(code)).status).toBe(200);
    expect(await (await h.exchange(code)).json()).toEqual({ code: 'invalid_grant' });
  });

  it('burns the code on a wrong verifier, session, device or generation', async () => {
    for (const change of [
      { code_verifier: randomBytes(32).toString('base64url') }, { session_id: 'thread-other' }, { device_id: 'KHALADEV2' }, { generation: 4 },
    ]) {
      const h = setup();
      const code = await h.code();
      expect((await h.exchange(code, change)).status).toBe(400);
      expect((await h.exchange(code)).status).toBe(400);
    }
  });

  it('refuses a proof from another key, for another target, stale or replayed', async () => {
    const thief = connectorKey(() => T0);
    const tokenUrl = `${ORIGIN}${TOKEN_PATH}`;
    const cases = [
      { proof: () => thief.proof(tokenUrl), code: 'proof_key_mismatch' },
      { proof: (h: ReturnType<typeof setup>) => h.key.proof(`${ORIGIN}${REDEEM_PATH}`), code: 'proof_target_mismatch' },
      { proof: (h: ReturnType<typeof setup>) => h.key.proof(tokenUrl, undefined, { iat: Math.floor(T0 / 1000) - 120 }), code: 'invalid_proof' },
      { proof: () => '', code: 'proof_required' },
    ];
    for (const { proof, code } of cases) {
      const h = setup();
      const response = await h.exchange(await h.code(), {}, proof(h));
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ code });
    }
    const h = setup();
    const replayed = h.key.proof(tokenUrl);
    expect((await h.exchange(await h.code(), {}, replayed)).status).toBe(200);
    expect(await (await h.exchange(await h.code(), {}, replayed)).json()).toEqual({ code: 'proof_replayed' });
  });

  it('expires codes after 60 seconds', async () => {
    const h = setup();
    const code = await h.code();
    h.advance(60_000);
    expect((await h.exchange(code, {}, h.key.proof(`${ORIGIN}${TOKEN_PATH}`))).status).toBe(400);
  });
});

describe('redeem', () => {
  it('binds the owner, agent participant, device and existing session', async () => {
    const h = setup();
    const response = await h.redeem(await h.grant());
    expect(response.status).toBe(200);
    const body = await response.json() as { binding: Record<string, unknown>; device_credential: unknown };
    expect(body.binding).toMatchObject({
      v: 1, ownerId: 'owner_b', agentParticipantId: 'agent_owner_b', deviceId: 'KHALADEV1', harness: 'codex', sessionId: 'thread-existing-b', generation: 3,
    });
    expect(body.binding.agentParticipantId).not.toBe(body.binding.ownerId);
    expect(body.device_credential).toEqual({ secret: 'device-login-secret', expires_at: T0 + 60_000 });
  });

  it('AE1: a lost-response retry of the same operation returns the same binding', async () => {
    const h = setup();
    const grant = await h.grant();
    const first = await (await h.redeem(grant)).json() as { binding: unknown };
    const again = await (await h.redeem(grant)).json() as { binding: unknown };
    expect(again.binding).toEqual(first.binding);
    const reconnect = await (await h.redeem(await h.grant(), 'bootstrap-b-2')).json() as { binding: unknown };
    expect(reconnect.binding).toEqual(first.binding);
    expect(new Set(h.admits)).toEqual(new Set(['KHALADEV1']));
  });

  it('refuses a grant replayed under another operation, expired or held by another key', async () => {
    const h = setup();
    const grant = await h.grant();
    expect((await h.redeem(grant)).status).toBe(200);
    expect(await (await h.redeem(grant, 'bootstrap-other')).json()).toEqual({ code: 'grant_replayed' });

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
    const creator = await (await h.redeem(await h.grant())).json() as { binding: { ownerId: string; bindingId: string } };
    owner = 'owner_stranger';
    const stranger = await (await h.redeem(await h.grant(), 'bootstrap-s-1')).json() as { binding: { ownerId: string; bindingId: string } };
    expect(creator.binding.ownerId).toBe('owner_a');
    expect(stranger.binding.ownerId).toBe('owner_stranger');
    expect(stranger.binding.bindingId).not.toBe(creator.binding.bindingId);
  });

  it('does not let another session or generation of the same owner take over the room binding', async () => {
    const h = setup();
    expect((await h.redeem(await h.grant())).status).toBe(200);
    const admitted = h.admits.length;
    for (const [change, operationId] of [[{ session_id: 'thread-other' }, 'bootstrap-b-2'], [{ generation: '4' }, 'bootstrap-b-3']] as const) {
      const code = await h.code(change);
      const bodyChange = 'generation' in change ? { generation: 4 } : change;
      const grant = ((await (await h.exchange(code, bodyChange)).json()) as { grant: string }).grant;
      const response = await h.redeem(grant, operationId, bodyChange);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ code: 'binding_conflict' });
    }
    // The conflicting sessions' devices never joined the room.
    expect(h.admits).toHaveLength(admitted);
  });

  it('scopes the client operation ID to the owner and device before admission', async () => {
    let owner = 'owner_a';
    const h = setup({ signedIn: () => owner });
    await h.redeem(await h.grant(), 'shared-operation');
    owner = 'owner_b';
    await h.redeem(await h.grant(), 'shared-operation');
    expect(h.admitOperations).toHaveLength(2);
    expect(h.admitOperations[0]).not.toBe(h.admitOperations[1]);
    expect(h.admitOperations.join()).not.toContain('shared-operation');
  });

  it('refuses an admission into a room other than the invite resolved to', async () => {
    const h = setup({
      agents: {
        room: async () => ({ kind: 'ok', value: 'room_1' as RoomId }),
        admit: async () => ({ kind: 'ok', value: { agentParticipantId: 'agent_x' as ParticipantId, roomId: 'room_2' as RoomId } }),
      },
    });
    expect(await (await h.redeem(await h.grant())).json()).toEqual({ code: 'admission_denied' });
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
