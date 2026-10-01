import { describe, expect, it } from 'vitest';
import type { AuthPrincipal, RoomId, SessionBinding } from '@khala/contracts/messaging/index';
import type { AuthService } from '../../auth/index';
import type { AdapterCapabilities } from '../../agent-bootstrap/handler';
import { createAgentBindingStore } from '../../agent-bootstrap/store';
import { createOwnerRoomIndex } from '../../agent-bootstrap/owner-room-index';
import type { AdmissionGateway } from '../../invitations/index';
import { fakeStore, T0 } from '../../auth/support.test';
import { ownerMatrixUserId } from '../human/matrix-identity';
import { createMatrixBrowserDeviceVerifier, createOwnerDeviceProofRoutes,
  OWNER_DEVICE_CHALLENGE, OWNER_DEVICE_LOOKUP, OWNER_DEVICE_REGISTER, OWNER_DEVICE_RETIRE } from './owner-device-proof';
import type { OwnerDeviceProofDependencies } from './owner-device-proof';

const origin = 'https://khala.aiur.team';
const roomId = '!owner-proof:example' as RoomId;
const binding = { v: 1, bindingId: 'binding-owner-proof', ownerId: 'owner-proof',
  agentParticipantId: 'agent-owner-proof', deviceId: 'agent-device', harness: 'claude',
  sessionId: 'session-owner-proof', generation: 2 } as SessionBinding;
const principal = { v: 1, ownerId: binding.ownerId, providerIssuer: 'https://id.example',
  providerSubject: 'owner-subject', verifiedEmail: 'owner@example.test',
  sessionExpiresAt: new Date(T0 + 60_000).toISOString() } as AuthPrincipal;
const browserDeviceId = 'BROWSER_DEVICE';
const currentDeviceId = 'CURRENT_BROWSER';
const fingerprint = 'A'.repeat(43);
const matrixAccessToken = 'test-browser-token-never-persist';

async function setup() {
  const state = fakeStore(() => T0);
  const bindings = createAgentBindingStore({ store: state.store });
  expect((await bindings.putParticipant({ ownerId: binding.ownerId, roomId,
    agentParticipantId: binding.agentParticipantId, expectedBindingId: null,
    record: { binding, revokedGeneration: null, capability: null } })).kind).toBe('applied');
  const index = createOwnerRoomIndex(state.store);
  expect((await index.activate(binding, roomId)).kind).toBe('ok');
  let signedIn = true;
  let csrf = true;
  let member = true;
  let current = true;
  let browserVerified = true;
  let verifiedFingerprint = fingerprint;
  let publishedKey: 'matched' | 'missing' | 'mismatch' | 'unavailable' = 'matched';
  let now = T0;
  let challengeCount = 0;
  let owner = principal;
  let agentBinding = binding;
  const diagnostics: Array<{ stage: string; code: string; scope: string }> = [];
  const auth = {
    async authenticateRequest() { return signedIn ? { kind: 'authenticated', context: { principal: owner } } : { kind: 'signed_out' }; },
    async requireHumanMutation() { return signedIn && csrf ? { kind: 'authorized', context: { principal: owner } }
      : { kind: 'rejected', code: signedIn ? 'csrf_mismatch' : 'signed_out' }; },
  } as unknown as AuthService;
  const gateway = { async inspectMembership() { return { kind: member ? 'joined' : 'absent', historyReady: false }; } } as unknown as AdmissionGateway;
  const capabilities = {
    async authorize() { return { kind: 'authorized', ownerId: agentBinding.ownerId, roomId,
      binding: agentBinding, action: 'receive_released' }; },
    async lookupBinding() { return { kind: 'found', ownerId: agentBinding.ownerId, deviceId: agentBinding.deviceId,
      generation: current ? agentBinding.generation : agentBinding.generation + 1,
      status: current ? 'active' : 'revoked' }; },
  } as unknown as AdapterCapabilities;
  const verifiedTokens: string[] = [];
  const dependencies: OwnerDeviceProofDependencies = { auth, gateway, capabilities, store: state.store,
    diagnostic: entry => diagnostics.push(entry),
    inspectOwnerMembership: async () => ({ kind: member ? 'joined' : 'absent' }), clock: () => now,
    inspectOwnerDeviceKey: async () => publishedKey,
    random: () => new Uint8Array(32).fill(++challengeCount),
    verifyBrowserDevice: async (who, device, key, token) => {
      verifiedTokens.push(token);
      return browserVerified && who.ownerId === binding.ownerId && (device === browserDeviceId || device === currentDeviceId)
        && key === verifiedFingerprint && token === matrixAccessToken ? 'verified' : 'mismatch';
    },
  };
  let routes = createOwnerDeviceProofRoutes(dependencies);
  async function call(path: string, method = 'GET', body?: unknown, query = ''): Promise<Response> {
    const route = [...routes.human, ...routes.agent].find(item => item.path === path)!;
    return route.handle(new Request(`${origin}${path}${query}`, { method,
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) }));
  }
  async function challenge(forBinding: SessionBinding = binding) {
    const result = await call(OWNER_DEVICE_CHALLENGE, 'GET', undefined,
      `?room_id=${encodeURIComponent(roomId)}&device_id=${browserDeviceId}`
      + `&binding_id=${forBinding.bindingId}&binding_generation=${forBinding.generation}`);
    expect(result.status).toBe(200);
    return (await result.json() as { nonce: string }).nonce;
  }
  const registration = (nonce: string, overrides: Record<string, unknown> = {}) => ({ v: 1, roomId,
    bindingId: binding.bindingId, generation: binding.generation,
    deviceId: browserDeviceId, fingerprint, nonce, matrixAccessToken, ...overrides });
  return { state, bindings, index, call, challenge, registration, verifiedTokens, diagnostics,
    setSignedIn: (value: boolean) => { signedIn = value; },
    setCsrf: (value: boolean) => { csrf = value; },
    setMember: (value: boolean) => { member = value; },
    setCurrent: (value: boolean) => { current = value; },
    setAgentBinding: (value: SessionBinding) => { agentBinding = value; },
    setOwner: (value: AuthPrincipal) => { owner = value; },
    setBrowserVerified: (value: boolean) => { browserVerified = value; },
    setVerifiedFingerprint: (value: string) => { verifiedFingerprint = value; },
    setPublishedKey: (value: typeof publishedKey) => { publishedKey = value; },
    advance: (ms: number) => { now += ms; },
    restart: () => { routes = createOwnerDeviceProofRoutes(dependencies); } };
}

describe('owner browser Matrix device proof', () => {
  it('accepts only the exact token-bound Matrix user, device, and published Ed25519 key', async () => {
    const userId = ownerMatrixUserId(binding.ownerId, 'example.test');
    let who = { user_id: userId, device_id: browserDeviceId };
    let key = fingerprint;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetch = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), ...(init ? { init } : {}) });
      return Response.json(String(url).endsWith('/account/whoami') ? who : { device_keys: { [userId]: {
        [browserDeviceId]: { user_id: userId, device_id: browserDeviceId,
          keys: { [`ed25519:${browserDeviceId}`]: key } },
      } } });
    };
    const verify = createMatrixBrowserDeviceVerifier({ homeserverOrigin: 'https://matrix.example.test',
      serverName: 'example.test', fetch: fetch as typeof globalThis.fetch });
    expect(await verify(principal, browserDeviceId as SessionBinding['deviceId'], fingerprint, matrixAccessToken)).toBe('verified');
    expect(calls[0]?.init?.headers).toMatchObject({ authorization: `Bearer ${matrixAccessToken}` });
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ device_keys: { [userId]: [browserDeviceId] } });
    who = { user_id: userId, device_id: 'ANOTHER_DEVICE' };
    expect(await verify(principal, browserDeviceId as SessionBinding['deviceId'], fingerprint, matrixAccessToken)).toBe('mismatch');
    who = { user_id: userId, device_id: browserDeviceId };
    key = 'B'.repeat(43);
    expect(await verify(principal, browserDeviceId as SessionBinding['deviceId'], fingerprint, matrixAccessToken)).toBe('mismatch');
  });

  it('pins one explicit verified browser key and exposes it only to the current agent binding', async () => {
    const env = await setup();
    const nonce = await env.challenge();
    expect((await env.call(OWNER_DEVICE_REGISTER, 'POST', env.registration(nonce))).status).toBe(200);
    const result = await env.call(OWNER_DEVICE_LOOKUP, 'GET', undefined, `?device_id=${browserDeviceId}`);
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ v: 1, roomId, deviceId: browserDeviceId, fingerprint });
    const listed = await env.call(OWNER_DEVICE_LOOKUP);
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual({ v: 1, roomId,
      devices: [{ deviceId: browserDeviceId, fingerprint }] });
    expect(env.verifiedTokens).toEqual([matrixAccessToken]);
    expect([...env.state.records.values()].some(record => JSON.stringify(record.value).includes(matrixAccessToken))).toBe(false);
    expect((await env.call(OWNER_DEVICE_LOOKUP, 'GET', undefined, '?device_id=UNREGISTERED')).status).toBe(404);
  });

  it('rejects missing CSRF, wrong owner, nonmembership, wrong browser token and challenge replay', async () => {
    const env = await setup();
    const nonce = await env.challenge();
    env.setCsrf(false);
    expect((await env.call(OWNER_DEVICE_REGISTER, 'POST', env.registration(nonce))).status).toBe(403);
    env.setCsrf(true);
    env.setOwner({ ...principal, ownerId: 'other-owner' as AuthPrincipal['ownerId'] });
    expect((await env.call(OWNER_DEVICE_REGISTER, 'POST', env.registration(nonce))).status).toBe(403);
    env.setOwner(principal);
    env.setMember(false);
    expect((await env.call(OWNER_DEVICE_REGISTER, 'POST', env.registration(nonce))).status).toBe(403);
    env.setMember(true);
    env.setBrowserVerified(false);
    expect((await env.call(OWNER_DEVICE_REGISTER, 'POST', env.registration(nonce))).status).toBe(403);
    env.setBrowserVerified(true);
    expect((await env.call(OWNER_DEVICE_REGISTER, 'POST', env.registration(nonce))).status).toBe(403);
    const second = await env.challenge();
    expect((await env.call(OWNER_DEVICE_REGISTER, 'POST', env.registration(second, { matrixAccessToken: 'forged-browser-token-000000' }))).status).toBe(403);
  });

  it('binds the nonce and public key pin to one current agent generation', async () => {
    const env = await setup();
    const nonce = await env.challenge();
    expect((await env.call(OWNER_DEVICE_REGISTER, 'POST', env.registration(nonce,
      { generation: binding.generation + 1 }))).status).toBe(403);
    expect((await env.call(OWNER_DEVICE_REGISTER, 'POST', env.registration(nonce,
      { bindingId: 'another-binding' }))).status).toBe(403);
    const staleChallenge = await env.call(OWNER_DEVICE_CHALLENGE, 'GET', undefined,
      `?room_id=${encodeURIComponent(roomId)}&device_id=${browserDeviceId}`
      + `&binding_id=${binding.bindingId}&binding_generation=${binding.generation + 1}`);
    expect(staleChallenge.status).toBe(403);
    const foreignChallenge = await env.call(OWNER_DEVICE_CHALLENGE, 'GET', undefined,
      `?room_id=${encodeURIComponent(roomId)}&device_id=${browserDeviceId}`
      + '&binding_id=another-binding&binding_generation=0');
    expect(foreignChallenge.status).toBe(403);
    expect((await env.call(OWNER_DEVICE_REGISTER, 'POST', env.registration(nonce))).status).toBe(200);
    const second = { ...binding, bindingId: 'binding-owner-proof-new',
      agentParticipantId: 'agent-owner-proof-new', deviceId: 'agent-device-new',
      sessionId: 'session-owner-proof-new', generation: 0 } as SessionBinding;
    expect((await env.bindings.putParticipant({ ownerId: binding.ownerId, roomId,
      agentParticipantId: second.agentParticipantId, expectedBindingId: null,
      record: { binding: second, revokedGeneration: null, capability: null } })).kind).toBe('applied');
    expect((await env.index.activate(second, roomId)).kind).toBe('ok');
    env.setAgentBinding(second);
    const newBindingPins = await env.call(OWNER_DEVICE_LOOKUP);
    expect(newBindingPins.status).toBe(200);
    expect(await newBindingPins.json()).toEqual({ v: 1, roomId, devices: [] });
  });

  it('indexes a fresh owner proof for the newly approved binding after an older proof', async () => {
    const env = await setup();
    expect((await env.call(OWNER_DEVICE_REGISTER, 'POST', env.registration(await env.challenge()))).status).toBe(200);
    const fresh = { ...binding, bindingId: 'binding-owner-proof-fresh',
      agentParticipantId: 'agent-owner-proof-fresh', deviceId: 'agent-device-fresh',
      sessionId: 'session-owner-proof-fresh', generation: 0 } as SessionBinding;
    expect((await env.bindings.putParticipant({ ownerId: binding.ownerId, roomId,
      agentParticipantId: fresh.agentParticipantId, expectedBindingId: null,
      record: { binding: fresh, revokedGeneration: null, capability: null } })).kind).toBe('applied');
    expect((await env.index.activate(fresh, roomId)).kind).toBe('ok');
    env.setAgentBinding(fresh);
    expect(await (await env.call(OWNER_DEVICE_LOOKUP)).json()).toEqual({ v: 1, roomId, devices: [] });
    const freshNonce = await env.challenge(fresh);
    expect((await env.call(OWNER_DEVICE_REGISTER, 'POST', env.registration(freshNonce,
      { bindingId: fresh.bindingId, generation: fresh.generation }))).status).toBe(200);
    expect(await (await env.call(OWNER_DEVICE_LOOKUP)).json()).toEqual({ v: 1, roomId,
      devices: [{ deviceId: browserDeviceId, fingerprint }] });
    const absent = env.diagnostics.find(entry => entry.code === 'index_absent');
    const indexed = [...env.diagnostics].reverse().find(entry => entry.code === 'indexed');
    const present = env.diagnostics.find(entry => entry.code === 'index_present');
    expect(absent?.scope).toBe(indexed?.scope);
    expect(present?.scope).toBe(indexed?.scope);
    expect(indexed?.scope).not.toBe(env.diagnostics.find(entry => entry.code === 'indexed')?.scope);
    expect(JSON.stringify(env.diagnostics)).not.toContain(binding.bindingId);
  });

  it('repairs a proof record whose first index write was unavailable', async () => {
    const env = await setup();
    const original = env.state.store.compareAndSet.bind(env.state.store);
    let failIndex = true;
    Object.defineProperty(env.state.store, 'compareAndSet', { configurable: true, value: async (input: { key: string }) => {
      if (input.key.startsWith('owner-device-index.v2.') && failIndex) {
        failIndex = false;
        return { kind: 'unavailable' };
      }
      return original(input as never);
    } });
    expect((await env.call(OWNER_DEVICE_REGISTER, 'POST', env.registration(await env.challenge()))).status).toBe(503);
    expect(env.diagnostics.at(-1)?.code).toBe('index_write_failed');
    expect(await (await env.call(OWNER_DEVICE_LOOKUP)).json()).toEqual({ v: 1, roomId, devices: [] });
    expect(env.diagnostics.at(-1)?.code).toBe('index_absent');
    expect((await env.call(OWNER_DEVICE_REGISTER, 'POST', env.registration(await env.challenge()))).status).toBe(200);
    expect(await (await env.call(OWNER_DEVICE_LOOKUP)).json()).toEqual({ v: 1, roomId,
      devices: [{ deviceId: browserDeviceId, fingerprint }] });
    expect(env.diagnostics.at(-1)?.code).toBe('index_present');
  });

  it('refuses key replacement and stale or revoked bindings on lookup', async () => {
    const env = await setup();
    const nonce = await env.challenge();
    expect((await env.call(OWNER_DEVICE_REGISTER, 'POST', env.registration(nonce))).status).toBe(200);
    const second = await env.challenge();
    env.setVerifiedFingerprint('B'.repeat(43));
    expect((await env.call(OWNER_DEVICE_REGISTER, 'POST', env.registration(second,
      { fingerprint: 'B'.repeat(43) }))).status).toBe(409);
    env.setCurrent(false);
    expect((await env.call(OWNER_DEVICE_LOOKUP, 'GET', undefined, `?device_id=${browserDeviceId}`)).status).toBe(403);
    expect((await env.call(OWNER_DEVICE_LOOKUP)).status).toBe(403);
    env.setCurrent(true);
    expect(await env.bindings.updateBinding(binding.bindingId, record => ({ ...record, revokedGeneration: 3 }))).toBe('applied');
    expect((await env.call(OWNER_DEVICE_LOOKUP, 'GET', undefined, `?device_id=${browserDeviceId}`)).status).toBe(403);
  });

  it('rechecks the exact published key and reconnects only after it appears', async () => {
    const env = await setup();
    expect((await env.call(OWNER_DEVICE_REGISTER, 'POST', env.registration(await env.challenge()))).status).toBe(200);
    env.setPublishedKey('missing');
    expect((await env.call(OWNER_DEVICE_LOOKUP)).status).toBe(503);
    expect(env.diagnostics.at(-1)?.code).toBe('key_missing');
    expect((await env.call(OWNER_DEVICE_LOOKUP, 'GET', undefined, `?device_id=${browserDeviceId}`)).status).toBe(503);
    env.advance(15_001);
    env.restart();
    env.setPublishedKey('matched');
    expect((await env.call(OWNER_DEVICE_LOOKUP)).status).toBe(200);
    env.setPublishedKey('mismatch');
    expect((await env.call(OWNER_DEVICE_LOOKUP)).status).toBe(403);
    expect(env.diagnostics.at(-1)?.code).toBe('key_mismatch');
    env.setPublishedKey('unavailable');
    expect((await env.call(OWNER_DEVICE_LOOKUP)).status).toBe(503);
    expect(env.diagnostics.at(-1)?.code).toBe('key_unavailable');
  });

  it('retires a missing key only after revocation and two separated observations', async () => {
    const env = await setup();
    expect((await env.call(OWNER_DEVICE_REGISTER, 'POST', env.registration(await env.challenge()))).status).toBe(200);
    const body = { v: 1, roomId, bindingId: binding.bindingId, generation: binding.generation, deviceId: browserDeviceId,
      currentDeviceId, currentFingerprint: fingerprint, matrixAccessToken };
    expect((await env.call(OWNER_DEVICE_RETIRE, 'POST', { ...body, currentDeviceId: browserDeviceId })).status).toBe(400);
    env.setPublishedKey('missing');
    expect((await env.call(OWNER_DEVICE_RETIRE, 'POST', body)).status).toBe(403);
    expect(await env.bindings.updateBinding(binding.bindingId, record => ({ ...record, revokedGeneration: 3 }))).toBe('applied');
    expect((await env.call(OWNER_DEVICE_RETIRE, 'POST', { ...body, generation: binding.generation + 1 })).status).toBe(403);
    env.setBrowserVerified(false);
    expect((await env.call(OWNER_DEVICE_RETIRE, 'POST', body)).status).toBe(403);
    env.setBrowserVerified(true);
    expect((await env.call(OWNER_DEVICE_RETIRE, 'POST', body)).status).toBe(202);
    env.advance(15_000);
    expect((await env.call(OWNER_DEVICE_RETIRE, 'POST', body)).status).toBe(202);
    env.advance(1);
    env.setPublishedKey('matched');
    expect((await env.call(OWNER_DEVICE_RETIRE, 'POST', body)).status).toBe(409);
    env.setPublishedKey('mismatch');
    expect((await env.call(OWNER_DEVICE_RETIRE, 'POST', body)).status).toBe(409);
    env.setPublishedKey('unavailable');
    expect((await env.call(OWNER_DEVICE_RETIRE, 'POST', body)).status).toBe(503);
    env.setPublishedKey('missing');
    env.restart();
    expect((await env.call(OWNER_DEVICE_RETIRE, 'POST', body)).status).toBe(202);
    env.advance(15_001);
    expect((await env.call(OWNER_DEVICE_RETIRE, 'POST', body)).status).toBe(200);
    expect((await env.call(OWNER_DEVICE_RETIRE, 'POST', body)).status).toBe(200);
    expect((await env.call(OWNER_DEVICE_LOOKUP)).status).toBe(403);
    expect([...env.state.records.values()].some(record => JSON.stringify(record.value).includes(matrixAccessToken))).toBe(false);
  });

  it('keeps a durable tombstone through failed index cleanup and restart', async () => {
    const env = await setup();
    expect((await env.call(OWNER_DEVICE_REGISTER, 'POST', env.registration(await env.challenge()))).status).toBe(200);
    expect(await env.bindings.updateBinding(binding.bindingId, record => ({ ...record, revokedGeneration: 3 }))).toBe('applied');
    env.setPublishedKey('missing');
    const body = { v: 1, roomId, bindingId: binding.bindingId, generation: binding.generation, deviceId: browserDeviceId,
      currentDeviceId, currentFingerprint: fingerprint, matrixAccessToken };
    expect((await env.call(OWNER_DEVICE_RETIRE, 'POST', body)).status).toBe(202);
    env.advance(15_001);
    const original = env.state.store.compareAndSet.bind(env.state.store);
    Object.defineProperty(env.state.store, 'compareAndSet', { configurable: true, value: async (input: { key: string }) =>
      input.key.startsWith('owner-device-index.v2.') ? { kind: 'unavailable' } : original(input as never) });
    expect((await env.call(OWNER_DEVICE_RETIRE, 'POST', body)).status).toBe(503);
    const absenceKey = env.state.keys('owner-device-absence.v1.')[0]!;
    expect((env.state.records.get(absenceKey)?.value as { retired?: boolean }).retired).toBe(true);
    const indexKey = env.state.keys('owner-device-index.v2.')[0]!;
    expect((env.state.records.get(indexKey)?.value as { deviceIds: string[] }).deviceIds).toEqual([browserDeviceId]);
    Object.defineProperty(env.state.store, 'compareAndSet', { configurable: true, value: original });
    env.restart();
    expect((await env.call(OWNER_DEVICE_RETIRE, 'POST', body)).status).toBe(200);
    expect((env.state.records.get(indexKey)?.value as { deviceIds: string[] }).deviceIds).toEqual([]);
  });

  it('does not retire when a concurrent key recovery clears absence evidence', async () => {
    const env = await setup();
    expect((await env.call(OWNER_DEVICE_REGISTER, 'POST', env.registration(await env.challenge()))).status).toBe(200);
    expect(await env.bindings.updateBinding(binding.bindingId, record => ({ ...record, revokedGeneration: 3 }))).toBe('applied');
    env.setPublishedKey('missing');
    const body = { v: 1, roomId, bindingId: binding.bindingId, generation: binding.generation, deviceId: browserDeviceId,
      currentDeviceId, currentFingerprint: fingerprint, matrixAccessToken };
    expect((await env.call(OWNER_DEVICE_RETIRE, 'POST', body)).status).toBe(202);
    env.advance(15_001);
    const original = env.state.store.compareAndSet.bind(env.state.store);
    Object.defineProperty(env.state.store, 'compareAndSet', { configurable: true, value: async (input: {
      key: string; expectedRevision: string; operationId: string }) => {
      if (input.operationId.startsWith('owner-device-retire.')) {
        await original({ key: input.key, expectedRevision: input.expectedRevision,
          operationId: 'test-key-recovered', next: { value: { v: 1, firstMissingAt: null }, expiresAt: null } });
      }
      return original(input as never);
    } });
    expect((await env.call(OWNER_DEVICE_RETIRE, 'POST', body)).status).toBe(503);
    const absenceKey = env.state.keys('owner-device-absence.v1.')[0]!;
    expect(env.state.records.get(absenceKey)?.value).toEqual({ v: 1, firstMissingAt: null });
    Object.defineProperty(env.state.store, 'compareAndSet', { configurable: true, value: original });
    env.restart();
    expect((await env.call(OWNER_DEVICE_RETIRE, 'POST', body)).status).toBe(202);
  });

  it('blocks lookup after owner leaves the room or closure begins', async () => {
    const env = await setup();
    const nonce = await env.challenge();
    expect((await env.call(OWNER_DEVICE_REGISTER, 'POST', env.registration(nonce))).status).toBe(200);
    env.setMember(false);
    expect((await env.call(OWNER_DEVICE_LOOKUP, 'GET', undefined, `?device_id=${browserDeviceId}`)).status).toBe(403);
    expect((await env.call(OWNER_DEVICE_LOOKUP)).status).toBe(403);
    env.setMember(true);
    expect((await env.index.markClosing(binding.ownerId, roomId, 'close_owner_proof', 0)).kind).toBe('ok');
    expect((await env.call(OWNER_DEVICE_LOOKUP, 'GET', undefined, `?device_id=${browserDeviceId}`)).status).toBe(403);
  });
});
