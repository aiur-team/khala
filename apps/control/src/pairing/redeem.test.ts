// End to end over fakes: create, claim, owner approval, result, then the shared
// bootstrap redeem route and an adapter request under the issued capability.

import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import type { AuthPrincipal, OwnerId, ParticipantId, RoomId } from '@khala/contracts/messaging/index';
import { describe, expect, it } from 'vitest';
import { REDEEM_PATH, DESCRIPTOR_PATH, createAgentBootstrapHandlers } from '../agent-bootstrap/handler';
import { thumbprint } from '../agent-bootstrap/proof';
import type { Authentication, MutationAuthorization } from '../auth';
import { T0, fakeStore, secureRandom } from '../auth/support.test';
import {
  AGENT_PAIRING_CLAIM_PATH, AGENT_PAIRING_RESULT_PATH, HUMAN_PAIRING_DECISION_PATH, HUMAN_PAIRING_REQUEST_PATH, createPairingHandlers,
} from './handler';
import { createPairingPolicy } from './policy';
import { createPairingStore } from './store';

const ORIGIN = 'https://khala.aiur.team';
const OWNER = 'owner_1' as OwnerId;
const CHANNEL = 'room_1' as RoomId;
const SESSION = { harness: 'codex', sessionId: 'thread-1', generation: 2 };
const DEVICE = 'KHALADEV1';
const DIGEST = 'e'.repeat(43);
const ADAPTER_URL = `${ORIGIN}/api/agent/adapter/publish`;

function connectorKey(clock: () => number) {
  const { privateKey } = generateKeyPairSync('ed25519');
  const x = createPublicKey(privateKey).export({ format: 'jwk' }).x!;
  return {
    jkt: thumbprint(x),
    proof(url: string, accessToken?: string) {
      const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'dpop+jwt', jwk: { kty: 'OKP', crv: 'Ed25519', x } })).toString('base64url');
      const claims: Record<string, unknown> = { htm: 'POST', htu: url, iat: Math.floor(clock() / 1000), jti: randomBytes(16).toString('base64url') };
      if (accessToken !== undefined) claims.ath = createHash('sha256').update(accessToken).digest('base64url');
      const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
      return `${header}.${payload}.${sign(null, Buffer.from(`${header}.${payload}`), privateKey).toString('base64url')}`;
    },
  };
}

function setup() {
  let now = T0;
  const clock = () => now;
  const { store } = fakeStore(clock);
  const policy = createPairingPolicy({ v: 1, activeKeyId: 'k1', keys: [{ id: 'k1', key: new Uint8Array(32).fill(9) }] });
  const pairingStore = createPairingStore({ store, policy, clock });
  const principal: AuthPrincipal = {
    v: 1, ownerId: OWNER, providerIssuer: 'https://id.example.test', providerSubject: 'sub-1',
    verifiedEmail: 'owner@example.test', sessionExpiresAt: '2026-09-18T20:00:00Z',
  };
  const authenticated = { kind: 'authenticated', context: { principal, csrfToken: 'csrf' } } as const;
  const pairing = createPairingHandlers({
    origin: ORIGIN,
    clock,
    store: pairingStore,
    policy,
    limiter: {
      reserve: async () => ({ kind: 'reserved', permit: { permitId: 'permit_1', leaseExpiresAt: new Date(now + 300_000).toISOString() } }),
      finalize: async input => input.disposition === 'release' ? { kind: 'released' } : { kind: 'finalized' },
    },
    auth: {
      authenticateRequest: async (): Promise<Authentication> => authenticated,
      requireHumanMutation: async (): Promise<MutationAuthorization> => ({ kind: 'authorized', context: authenticated.context }),
    },
    trustedSource: async () => ({ kind: 'trusted', source: 'platform:203.0.113.7' }),
    authorizeTarget: async () => ({ kind: 'allowed', origin: ORIGIN, descriptorId: 'descriptor_v1' }),
  });
  const admissions: string[] = [];
  const bootstrap = createAgentBootstrapHandlers({
    origin: ORIGIN,
    store,
    clock,
    random: secureRandom,
    authenticate: async () => authenticated,
    inviteFromLink: () => null,
    admissionFor: () => ({ inspect: async () => 'eligible' }),
    admissionPolicy: async () => 'deny',
    legacyMigrationWritesEnabled: true,
    pairingGrants: pairing.grantPort,
    pairingDescriptor: pairing.descriptor,
    agents: {
      inspect: async ({ ownerId, inviteRef }) => {
        admissions.push(inviteRef);
        return { kind: 'ok', value: { agentParticipantId: `agent_${ownerId}` as ParticipantId, roomId: CHANNEL } };
      },
      admit: async ({ expectedAgentParticipantId, expectedRoomId }) => (
        { kind: 'ok', value: { agentParticipantId: expectedAgentParticipantId, roomId: expectedRoomId } }
      ),
    },
  });
  const routes = [...pairing.human, ...pairing.agent, ...bootstrap.agent];
  const call = (path: string, init: RequestInit & { search?: string } = {}) => {
    const { search = '', ...rest } = init;
    return routes.find(route => route.path === path)!.handle(new Request(`${ORIGIN}${path}${search}`, rest));
  };
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => call(path, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers }, body: JSON.stringify(body),
  });
  const key = connectorKey(clock);

  async function issueCode() {
    const created = await (await post(HUMAN_PAIRING_REQUEST_PATH, {
      v: 1, channelId: CHANNEL, origin: ORIGIN, descriptorId: 'descriptor_v1', operationId: 'create_operation_1',
    })).json() as { code: string; requestHandle: string };
    return created;
  }

  async function claim(code: string, agentKey = key, overrides: Record<string, unknown> = {}) {
    return post(AGENT_PAIRING_CLAIM_PATH, {
      v: 1, code, operationId: 'claim_operation_1', jkt: agentKey.jkt, ...SESSION, deviceId: DEVICE, evidenceDigest: DIGEST, ...overrides,
    }, { dpop: agentKey.proof(`${ORIGIN}${AGENT_PAIRING_CLAIM_PATH}`) });
  }

  /** Claim, owner approves exactly that claim, connector polls its result. */
  async function approvedGrant() {
    const created = await issueCode();
    const claimed = await (await claim(created.code)).json() as { receipt: string; requestHandle: string };
    const inspected = await (await call(HUMAN_PAIRING_REQUEST_PATH, { search: `?request_id=${created.requestHandle}` })).json() as {
      revision: string; claim: { fingerprint: string };
    };
    const decided = await post(HUMAN_PAIRING_DECISION_PATH, {
      v: 1, requestHandle: created.requestHandle, revision: inspected.revision,
      claimFingerprint: inspected.claim.fingerprint, decision: 'approve', operationId: 'decision_operation_1',
    });
    expect(decided.status).toBe(200);
    const result = await post(AGENT_PAIRING_RESULT_PATH, {
      v: 1, requestHandle: claimed.requestHandle, receipt: claimed.receipt, operationId: 'claim_operation_1', jkt: key.jkt,
    }, { dpop: key.proof(`${ORIGIN}${AGENT_PAIRING_RESULT_PATH}`) });
    const body = await result.json() as { state: string; grant: string };
    expect(body.state).toBe('approved');
    return body.grant;
  }

  function redeem(grant: string, options: { key?: ReturnType<typeof connectorKey>; operationId?: string; body?: Record<string, unknown> } = {}) {
    const signer = options.key ?? key;
    return post(REDEEM_PATH, {
      operation_id: options.operationId ?? 'redeem_operation_1', harness: SESSION.harness, session_id: SESSION.sessionId,
      generation: SESSION.generation, device_id: DEVICE, ...options.body,
    }, { authorization: `DPoP ${grant}`, dpop: signer.proof(`${ORIGIN}${REDEEM_PATH}`, grant) });
  }

  return { call, key, approvedGrant, redeem, issueCode, claim, admissions, bootstrap, advance: (ms: number) => { now += ms; } };
}

describe('pairing descriptor', () => {
  it('serves the fixed code-only descriptor with no-store and nothing about any channel', async () => {
    const h = setup();
    const response = await h.call(DESCRIPTOR_PATH, { search: '?method=pairing-code-v1' });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.json()).toEqual({
      v: 1, methods: ['pairing-code-v1'],
      claim: `${ORIGIN}${AGENT_PAIRING_CLAIM_PATH}`, result: `${ORIGIN}${AGENT_PAIRING_RESULT_PATH}`, redeem: `${ORIGIN}${REDEEM_PATH}`,
    });
    // Nothing a caller sends changes it, and a live code is never a descriptor input.
    const created = await h.issueCode();
    const other = await h.call(DESCRIPTOR_PATH, { search: '?method=pairing-code-v1' });
    expect(JSON.stringify(await other.json())).not.toContain(created.code);
  });

  it.each(['?method=other', '?method=pairing-code-v1&code=01234-56789', '?method=pairing-code-v1&method=pairing-code-v1', `?method=pairing-code-v1&link=${ORIGIN}/i/x`])(
    'refuses %s without echoing input', async search => {
      const response = await setup().call(DESCRIPTOR_PATH, { search });
      expect(response.status).toBe(404);
      expect(response.headers.get('cache-control')).toBe('no-store');
    });

  it('leaves link descriptors to the bootstrap handler', async () => {
    const response = await setup().call(DESCRIPTOR_PATH, { search: '' });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ code: 'unknown_link' });
  });
});

describe('pairing grant redeem', () => {
  it('claims, is approved, redeems and activates an adapter capability', async () => {
    const h = setup();
    const response = await h.redeem(await h.approvedGrant());
    expect(response.status).toBe(200);
    const body = await response.json() as { binding: { ownerId: string; deviceId: string; sessionId: string; generation: number }; adapter_capability: { token: string; scope: string[] } };
    expect(body.binding).toMatchObject({ ownerId: OWNER, deviceId: DEVICE, sessionId: SESSION.sessionId, generation: SESSION.generation });
    expect(body.adapter_capability.scope).toEqual(['publish_own', 'receive_released', 'ack_delivery']);
    expect(h.admissions).toEqual([`pairing:${CHANNEL}`]);
    const activated = await h.bootstrap.capabilities.authorize(new Request(ADAPTER_URL, {
      method: 'POST', headers: { authorization: `DPoP ${body.adapter_capability.token}`, dpop: h.key.proof(ADAPTER_URL, body.adapter_capability.token) },
    }), 'publish_own');
    expect(activated).toMatchObject({ kind: 'authorized', roomId: CHANNEL });
  });

  it('refuses a different DPoP key and leaves the grant usable by the right one', async () => {
    const h = setup();
    const grant = await h.approvedGrant();
    const thief = connectorKey(() => T0);
    const stolen = await h.redeem(grant, { key: thief, operationId: 'redeem_operation_2' });
    expect(stolen.status).toBe(401);
    expect(await stolen.json()).toEqual({ code: 'invalid_grant' });
    expect((await h.redeem(grant)).status).toBe(200);
  });

  it.each([
    ['session', { session_id: 'thread-other' }],
    ['generation', { generation: 3 }],
    ['device', { device_id: 'KHALADEV2' }],
  ])('refuses a mismatched %s without spending the grant', async (_name, body) => {
    const h = setup();
    const grant = await h.approvedGrant();
    expect((await h.redeem(grant, { body })).status).toBe(401);
    expect((await h.redeem(grant)).status).toBe(200);
  });

  it('refuses a replay by another operation and by a retry after issuance', async () => {
    const h = setup();
    const grant = await h.approvedGrant();
    expect((await h.redeem(grant)).status).toBe(200);
    const retry = await h.redeem(grant);
    expect(retry.status).toBe(401);
    expect(await retry.json()).toEqual({ code: 'grant_replayed' });
    const replay = await h.redeem(grant, { operationId: 'redeem_operation_2' });
    expect(replay.status).toBe(401);
    expect(await replay.json()).toEqual({ code: 'invalid_grant' });
  });

  it('mints no capability for a same-operation retry seven days later', async () => {
    const h = setup();
    const grant = await h.approvedGrant();
    expect((await h.redeem(grant)).status).toBe(200);
    h.advance(7 * 24 * 60 * 60 * 1000);
    const late = await h.redeem(grant);
    expect(late.status).toBe(401);
    expect(await late.json()).toEqual({ code: 'grant_replayed' });
  });

  it('refuses an expired grant', async () => {
    const h = setup();
    const grant = await h.approvedGrant();
    h.advance(61_000);
    expect((await h.redeem(grant)).status).toBe(401);
  });

  it('refuses an unknown grant and a request with no proof', async () => {
    const h = setup();
    expect((await h.redeem('x'.repeat(43))).status).toBe(401);
    const grant = await h.approvedGrant();
    const bare = await h.call(REDEEM_PATH, {
      method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, authorization: `DPoP ${grant}` },
      body: JSON.stringify({ operation_id: 'redeem_operation_1', harness: SESSION.harness, session_id: SESSION.sessionId, generation: SESSION.generation, device_id: DEVICE }),
    });
    expect(bare.status).toBe(401);
  });
});
