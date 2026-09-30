import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { AuthPrincipal, ControlRecord, ControlStore, DeviceId, JsonValue, OwnerId, RoomId, SessionBinding } from '@khala/contracts/messaging/index';
import { createMatrixHumanServices } from './matrix';
import { createAgentBindingStore } from '../../agent-bootstrap/store';
import { createOwnerRoomIndex } from '../../agent-bootstrap/owner-room-index';
import { agentMatrixIdentity } from '../agent/matrix-admission';
import { createAgentIdentityDirectory } from '../agent/identity-directory';
import { ownerMatrixLocalpart, ownerMatrixUserId } from './matrix-identity';
import { ensureMessagingAccount } from '../../auth/provisioning';

const registrationSecret = 'registration-secret-with-more-than-32-bytes';
const passwordSecret = 'password-secret-with-more-than-32-bytes';
const principal: AuthPrincipal = {
  v: 1,
  ownerId: 'owner_alice' as OwnerId,
  providerIssuer: 'https://issuer.example',
  providerSubject: 'alice',
  verifiedEmail: 'alice@example.test',
  sessionExpiresAt: '2030-01-01T00:00:00Z',
};

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function memoryStore(): ControlStore {
  const records = new Map<string, ControlRecord>();
  let revision = 0;
  return {
    async read<T extends JsonValue>(key: string) {
      const record = records.get(key);
      return record ? { kind: 'record' as const, record: record as ControlRecord<T> } : { kind: 'absent' as const };
    },
    async compareAndSet<T extends JsonValue>(input: Parameters<ControlStore['compareAndSet']>[0]) {
      const current = records.get(input.key) ?? null;
      if ((current?.revision ?? null) !== input.expectedRevision) {
        return { kind: 'conflict' as const, current: current as ControlRecord<T> | null };
      }
      const record = {
        key: input.key,
        revision: `r${++revision}`,
        operationId: input.operationId,
        value: input.next.value,
        expiresAt: input.next.expiresAt,
      } as ControlRecord<T>;
      records.set(input.key, record);
      return { kind: 'applied' as const, record };
    },
    async resolve<T extends JsonValue>({ key, operationId }: { key: string; operationId: string }) {
      const record = records.get(key);
      return record?.operationId === operationId
        ? { kind: 'applied' as const, record: record as ControlRecord<T> }
        : { kind: 'not_applied' as const };
    },
  };
}

function services(fetch: typeof globalThis.fetch, store = memoryStore()) {
  return createMatrixHumanServices({
    homeserverOrigin: 'https://matrix.example.test',
    serverName: 'matrix.example.test',
    registrationSharedSecret: registrationSecret,
    passwordDerivationSecret: passwordSecret,
    store,
    fetch,
  });
}

describe('createMatrixHumanServices', () => {
  it('creates an owner-scoped encrypted room and reconciles its operation marker', async () => {
    const roomId = '!created:matrix.example.test' as RoomId;
    let creates = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      if (path.endsWith('/login')) {
        const request = JSON.parse(String(init?.body)) as { identifier: { user: string }; device_id: string };
        return json(200, { user_id: request.identifier.user, device_id: request.device_id,
          access_token: 'control-token' });
      }
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer control-token');
      if (path.endsWith('/createRoom')) {
        creates += 1;
        const request = JSON.parse(String(init?.body)) as { visibility: string; initial_state: readonly {
          type: string; content: Record<string, string> }[] };
        expect(request.visibility).toBe('private');
        expect(request.initial_state).toContainEqual({ type: 'm.room.encryption', state_key: '',
          content: { algorithm: 'm.megolm.v1.aes-sha2' } });
        expect(request.initial_state).toContainEqual({ type: 'com.aiur.khala.create.v1', state_key: '',
          content: { operation_id: 'create-key-1' } });
        return json(200, { room_id: roomId });
      }
      if (path.endsWith('/joined_rooms')) return json(200, { joined_rooms: [roomId] });
      if (path.endsWith('/state/com.aiur.khala.create.v1/')) return json(200, { operation_id: 'create-key-1' });
      throw new Error(`unexpected request ${path}`);
    });
    const matrix = services(fetch);
    const substrate = matrix.channelCreateFor(principal.ownerId);
    expect(await substrate.createRoom({ operationId: 'create-key-1', title: 'Planning' }))
      .toMatchObject({ kind: 'done', value: { roomId, title: 'Planning' } });
    expect(await substrate.findCreatedRoom({ operationId: 'create-key-1' }))
      .toMatchObject({ kind: 'found', room: { roomId } });
    expect(await substrate.findCreatedRoom({ operationId: 'other-key' })).toEqual({ kind: 'unknown' });
    expect(creates).toBe(1);
    expect(await matrix.inspectRoomAuthority(roomId)).toBe(principal.ownerId);
  });

  it('reuses one server-only control login across concurrent and repeated membership checks', async () => {
    const roomId = '!room:matrix.example.test' as RoomId;
    let logins = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      if (path.endsWith('/login')) {
        logins += 1;
        const request = JSON.parse(String(init?.body)) as { identifier: { user: string }; device_id: string };
        return json(200, { user_id: request.identifier.user, device_id: request.device_id, access_token: 'control-token' });
      }
      if (path.includes('/state/m.room.member/')) {
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer control-token');
        return json(200, { membership: 'join' });
      }
      throw new Error(`unexpected request ${path}`);
    });
    const matrix = services(fetch);
    const input = { principal, roomId, history: 'none' as const };
    expect(await Promise.all([matrix.gateway.inspectMembership(input), matrix.gateway.inspectMembership(input)]))
      .toEqual([{ kind: 'joined', historyReady: true }, { kind: 'joined', historyReady: true }]);
    expect(await matrix.gateway.inspectMembership(input)).toEqual({ kind: 'joined', historyReady: true });
    expect(logins).toBe(1);
  });

  it('discards a control token after Matrix rejects it, then logs in again', async () => {
    const roomId = '!room:matrix.example.test' as RoomId;
    let logins = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      if (path.endsWith('/login')) {
        logins += 1;
        const request = JSON.parse(String(init?.body)) as { identifier: { user: string }; device_id: string };
        return json(200, { user_id: request.identifier.user, device_id: request.device_id,
          access_token: `control-token-${logins}` });
      }
      if (path.includes('/state/m.room.member/')) {
        return new Headers(init?.headers).get('authorization') === 'Bearer control-token-1'
          ? json(401, { errcode: 'M_UNKNOWN_TOKEN' }) : json(200, { membership: 'join' });
      }
      throw new Error(`unexpected request ${path}`);
    });
    const matrix = services(fetch);
    expect((await matrix.gateway.inspectMembership({ principal, roomId, history: 'none' })).kind).toBe('unavailable');
    expect((await matrix.gateway.inspectMembership({ principal, roomId, history: 'none' })).kind).toBe('joined');
    expect(logins).toBe(2);
  });

  it('honors the Matrix 429 retry interval without blocking another owner', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-28T20:00:00Z'));
    try {
      let aliceLogins = 0;
      let bobLogins = 0;
      const bob = { ...principal, ownerId: 'owner_bob' as OwnerId, providerSubject: 'bob' };
      const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
        const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
        if (path.endsWith('/login')) {
          const request = JSON.parse(String(init?.body)) as { identifier: { user: string }; device_id: string };
          if (request.identifier.user === ownerMatrixUserId(principal.ownerId, 'matrix.example.test')) {
            aliceLogins += 1;
            if (aliceLogins === 1) return json(429, { errcode: 'M_LIMIT_EXCEEDED', retry_after_ms: 500 });
          } else bobLogins += 1;
          return json(200, { user_id: request.identifier.user, device_id: request.device_id, access_token: 'device-token' });
        }
        if (path.endsWith('/keys/query')) return json(200, { device_keys: {} });
        throw new Error(`unexpected request ${path}`);
      });
      const matrix = services(fetch);
      const deviceId = 'WEB_OWNER' as DeviceId;
      expect((await matrix.sessions.issue(principal, deviceId)).kind).toBe('unavailable');
      expect((await matrix.sessions.issue(principal, deviceId)).kind).toBe('unavailable');
      expect((await matrix.sessions.issue(bob, 'WEB_BOB' as DeviceId)).kind).toBe('ok');
      expect([aliceLogins, bobLogins]).toEqual([1, 1]);
      vi.setSystemTime(new Date('2026-09-28T20:00:00.501Z'));
      expect((await matrix.sessions.issue(principal, deviceId)).kind).toBe('ok');
      expect(aliceLogins).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats Synapse missing-profile M_UNKNOWN as absent, but refuses other unknown 404s', async () => {
    for (const [error, expected] of [
      ['No row found (profiles)', 'absent'],
      ['Unknown endpoint', 'unavailable'],
    ] as const) {
      const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
        const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
        if (path.startsWith('/_matrix/client/v3/profile/')) return json(404, { errcode: 'M_UNKNOWN', error });
        if (path === '/_synapse/admin/v1/register' && init?.method !== 'POST') return json(200, { nonce: 'nonce_1' });
        if (path === '/_synapse/admin/v1/register') {
          const request = JSON.parse(String(init?.body)) as { username: string };
          return json(200, { user_id: `@${request.username.toLowerCase()}:matrix.example.test` });
        }
        throw new Error(`unexpected request ${path}`);
      });
      const store = memoryStore();
      const directory = services(fetch, store).directory;
      expect((await directory.lookup(principal.ownerId)).kind).toBe(expected);
      const provisioned = await ensureMessagingAccount(store, directory,
        bytes => new Uint8Array(randomBytes(bytes)), principal.ownerId);
      expect(provisioned.kind).toBe(expected === 'absent' ? 'active' : 'unavailable');
      expect(fetch.mock.calls.some(([input, init]) =>
        new URL(input instanceof Request ? input.url : input.toString()).pathname === '/_synapse/admin/v1/register'
          && init?.method === 'POST')).toBe(expected === 'absent');
    }
  });

  it('registers an ordinary owner when Synapse canonicalizes shared-secret usernames to lowercase', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      if (path.startsWith('/_matrix/client/v3/profile/')) return json(404, { errcode: 'M_NOT_FOUND' });
      if (path === '/_synapse/admin/v1/register' && init?.method !== 'POST') return json(200, { nonce: 'nonce_1' });
      if (path === '/_synapse/admin/v1/register') {
        const request = JSON.parse(String(init?.body)) as { username: string };
        return json(200, { user_id: `@${request.username.toLowerCase()}:matrix.example.test` });
      }
      if (path.endsWith('/login')) {
        const request = JSON.parse(String(init?.body)) as { identifier: { user: string }; device_id: string };
        return json(200, { user_id: request.identifier.user.toLowerCase(), device_id: request.device_id,
          access_token: 'owner-device-token' });
      }
      if (path.endsWith('/keys/query')) return json(200, { device_keys: {} });
      throw new Error(`unexpected request ${path}`);
    });
    const created = await services(fetch).directory.create(principal.ownerId);
    expect(created).toMatchObject({ kind: 'created' });
    if (created.kind === 'created') {
      expect(created.accountId).toMatch(/^@khala_[a-z0-9_=\-]+:matrix\.example\.test$/u);
      expect(await services(fetch).sessions.issue(principal, 'WEB_OWNER' as DeviceId))
        .toMatchObject({ kind: 'ok', session: { userId: created.accountId } });
      expect(await services(fetch).sessions.resolveParticipants([created.accountId]))
        .toMatchObject({ kind: 'ok', participants: [{ matrixUserId: created.accountId, ownerId: principal.ownerId }] });
    }
  });

  it('provisions a deterministic non-admin account with the Synapse shared-secret MAC', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname.startsWith('/_matrix/client/v3/profile/')) return json(404, { errcode: 'M_NOT_FOUND' });
      if (url.pathname === '/_synapse/admin/v1/register' && init?.method !== 'POST') return json(200, { nonce: 'nonce_1' });
      if (url.pathname === '/_synapse/admin/v1/register') {
        const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(request.admin).toBe(false);
        expect(request.username).toBe(ownerMatrixLocalpart(principal.ownerId));
        expect(request).not.toHaveProperty('ownerId');
        const expected = createHmac('sha1', registrationSecret)
          .update('nonce_1\0').update(String(request.username)).update('\0')
          .update(String(request.password)).update('\0notadmin').digest('hex');
        expect(request.mac).toBe(expected);
        return json(200, { user_id: `@${request.username}:matrix.example.test` });
      }
      throw new Error(`unexpected request ${url.pathname}`);
    });
    const matrix = services(fetch);

    expect(await matrix.directory.lookup(principal.ownerId)).toEqual({ kind: 'absent' });
    expect(await matrix.directory.create(principal.ownerId)).toMatchObject({
      kind: 'created', accountId: ownerMatrixUserId(principal.ownerId, 'matrix.example.test'),
    });
  });

  it('sends the optional ingress credential only on the two registration requests', async () => {
    const ingress = 'preview-ingress-token-more-than-32-bytes';
    const seen: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const pathname = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      const header = new Headers(init?.headers).get('X-Khala-Registration-Ingress');
      if (pathname.startsWith('/_matrix/client/v3/profile/')) {
        expect(header).toBeNull();
        return json(404, { errcode: 'M_NOT_FOUND' });
      }
      if (pathname === '/_synapse/admin/v1/register') {
        expect(header).toBe(ingress);
        seen.push(init?.method ?? 'GET');
        return init?.method === 'POST'
          ? json(200, { user_id: ownerMatrixUserId(principal.ownerId, 'matrix.example.test') })
          : json(200, { nonce: 'nonce_1' });
      }
      throw new Error(`unexpected request ${pathname}`);
    });
    const matrix = createMatrixHumanServices({
      homeserverOrigin: 'https://matrix.example.test', serverName: 'matrix.example.test',
      registrationSharedSecret: registrationSecret, registrationIngressToken: ingress,
      passwordDerivationSecret: passwordSecret, store: memoryStore(), fetch,
    });
    expect(await matrix.directory.create(principal.ownerId)).toMatchObject({ kind: 'created' });
    expect(seen).toEqual(['GET', 'POST']);
  });

  it('mints a device-bound browser token and reports an already-published identity key', async () => {
    const deviceId = 'KH_WEB_1' as DeviceId;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname.endsWith('/login')) {
        const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const identifier = request.identifier as Record<string, unknown>;
        return json(200, { user_id: identifier.user, access_token: 'device-token', device_id: deviceId });
      }
      if (url.pathname.endsWith('/keys/query')) {
        const authorization = new Headers(init?.headers).get('authorization');
        expect(authorization).toBe('Bearer device-token');
        const request = JSON.parse(String(init?.body)) as { device_keys: Record<string, string[]> };
        const userId = Object.keys(request.device_keys)[0]!;
        return json(200, {
          device_keys: { [userId]: { [deviceId]: { keys: { [`ed25519:${deviceId}`]: 'published-key' } } } },
        });
      }
      throw new Error(`unexpected request ${url.pathname}`);
    });
    const matrix = services(fetch);

    expect(await matrix.sessions.issue(principal, deviceId)).toEqual({
      kind: 'ok',
      session: {
        homeserverOrigin: 'https://matrix.example.test',
        userId: expect.stringMatching(/^@khala_/u),
        accessToken: 'device-token',
        deviceId,
        publishedFingerprint: 'published-key',
      },
    });
  });

  it('joins an admitted no-history participant without claiming historical keys', async () => {
    const roomId = '!room:matrix.example.test' as RoomId;
    let joined = false;
    let sharing = true;
    const membershipWrites: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname.endsWith('/login')) {
        const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const identifier = request.identifier as Record<string, unknown>;
        return json(200, { user_id: identifier.user, access_token: 'control-token', device_id: request.device_id });
      }
      if (url.pathname.includes('/state/m.room.member/')) {
        return sharing || joined ? json(200, { membership: 'join' }) : json(404, { errcode: 'M_NOT_FOUND' });
      }
      if (url.pathname.includes('/_matrix/client/v3/join/')) {
        membershipWrites.push('join');
        joined = true;
        return json(200, { room_id: roomId });
      }
      if (url.pathname.endsWith('/invite')) {
        membershipWrites.push('invite');
        expect(JSON.parse(String(init?.body))).toEqual({
          user_id: ownerMatrixUserId(principal.ownerId, 'matrix.example.test'),
        });
        return json(200, {});
      }
      if (url.pathname.includes('/state/m.room.name/')) return json(200, { name: 'Shared room' });
      throw new Error(`unexpected request ${url.pathname}`);
    });
    const matrix = services(fetch);
    const creator = { ...principal, ownerId: 'owner_creator' as OwnerId, providerSubject: 'creator' };
    expect(await matrix.authority.canShare({ principal: creator, roomId })).toBe('allowed');
    sharing = false;
    const request = {
      operationId: 'admit_1',
      roomId,
      principal,
      deviceId: 'KH_WEB_1' as DeviceId,
      history: 'none' as const,
      inviteRevision: 'r1',
    };

    expect(await matrix.gateway.admit(request)).toEqual({
      kind: 'joined',
      room: { roomId, title: 'Shared room', membership: 'joined', revision: `matrix:${roomId}` },
      historyReady: true,
    });
    expect(membershipWrites).toEqual(['invite', 'join']);
  });

  it('resolves only canonical local participant accounts', async () => {
    const matrix = services(vi.fn());
    const userId = ownerMatrixUserId(principal.ownerId, 'matrix.example.test');
    const result = await matrix.sessions.resolveParticipants([userId]);
    expect(result).toMatchObject({
      kind: 'ok',
      participants: [{ matrixUserId: userId, ownerId: principal.ownerId, displayName: userId }],
    });
    expect(await matrix.sessions.resolveParticipants(['@khala_bad:elsewhere.test'])).toEqual({ kind: 'unavailable' });
  });
});

describe('Matrix room sender inventory', () => {
  const room = '!roster:matrix.example.test' as RoomId;
  const user = ownerMatrixUserId(principal.ownerId, 'matrix.example.test');
  const otherOwner = 'owner_bob' as OwnerId;
  const other = ownerMatrixUserId(otherOwner, 'matrix.example.test');
  const curve = Buffer.alloc(32, 7).toString('base64').replace(/=+$/u, '');
  const device = (userId: string, deviceId: string) => ({ user_id: userId, device_id: deviceId,
    keys: { [`curve25519:${deviceId}`]: curve } });
  async function fixture() {
    const store = memoryStore();
    const identity = agentMatrixIdentity(principal.ownerId, { harness: 'codex', sessionId: 'existing-session', generation: 0 }, 'matrix.example.test');
    const binding = { v: 1, bindingId: 'binding_roster', ownerId: principal.ownerId,
      agentParticipantId: identity.participantId, deviceId: 'CONNECTOR_1', harness: 'codex',
      sessionId: 'existing-session', generation: 0 } as SessionBinding;
    const bindings = createAgentBindingStore({ store });
    await bindings.putParticipant({ ownerId: binding.ownerId, roomId: room, agentParticipantId: binding.agentParticipantId,
      expectedBindingId: null, record: { binding, revokedGeneration: null, capability: null } });
    await createOwnerRoomIndex(store).activate(binding, room);
    await createAgentIdentityDirectory(store).remember({ v: 1, roomId: room, matrixUserId: identity.userId,
      participantId: identity.participantId, ownerId: principal.ownerId, harness: 'codex' });
    const joined: Record<string, unknown> = { [user]: {}, [other]: {}, [identity.userId]: {} };
    const keys: Record<string, Record<string, unknown>> = {
      [user]: { WEB_OFFLINE: device(user, 'WEB_OFFLINE') },
      [other]: { WEB_OTHER: device(other, 'WEB_OTHER') },
      [identity.userId]: { CONNECTOR_1: device(identity.userId, 'CONNECTOR_1') },
    };
    const expectedUsers = [user, other, identity.userId].sort();
    let afterQuery: (() => Promise<void>) | undefined;
    let denied = false;
    let hiddenHistory = false;
    let failures: unknown = {};
    let membershipReads = 0;
    let mutateMembership = false;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (path.endsWith('/login')) {
        const request = JSON.parse(String(init?.body));
        return json(200, { user_id: request.identifier.user, device_id: request.device_id, access_token: 'private-roster-token' });
      }
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer private-roster-token');
      if (path.includes('/state/m.room.member/')) return denied ? json(403, { errcode: 'M_FORBIDDEN' })
        : json(200, { membership: 'join' });
      if (path.endsWith('/joined_members')) {
        expect(decodeURIComponent(path)).toContain(room);
        membershipReads++;
        if (denied) return json(403, { errcode: 'M_FORBIDDEN' });
        return json(200, { joined: mutateMembership && membershipReads > 1 ? { [user]: {} } : joined });
      }
      if (path.endsWith('/state')) return json(200, [{ type: 'm.room.member', state_key: identity.userId, event_id: '$agent-left' }]);
      if (path.includes('/event/')) return hiddenHistory ? json(403, { errcode: 'M_FORBIDDEN' })
        : json(200, { type: 'm.room.member', state_key: identity.userId, event_id: '$agent-left' });
      if (path.endsWith('/keys/query')) {
        const query = JSON.parse(String(init?.body)) as { device_keys: Record<string, string[]> };
        expect(Object.keys(query.device_keys).sort()).toEqual(expectedUsers);
        expect(Object.values(query.device_keys).every(ids => ids.length === 0)).toBe(true);
        await afterQuery?.();
        return json(200, { device_keys: keys, failures });
      }
      throw new Error('unexpected roster request');
    });
    return { matrix: services(fetch, store), store, binding, identity, joined, keys, fetch,
      deny: () => { denied = true; }, hideHistory: () => { hiddenHistory = true; }, fail: (value: unknown) => { failures = value; },
      changeMembers: () => { mutateMembership = true; },
      onQuery: (callback: () => Promise<void>) => { afterQuery = callback; } };
  }
  it('resolves an agent with its indexed owner only for a joined human', async () => {
    const f = await fixture();
    const result = await f.matrix.sessions.resolveRoomParticipants(principal.ownerId, room, [user, f.identity.userId]);
    expect(result).toMatchObject({ kind: 'ok', participants: [
      { matrixUserId: user, ownerId: principal.ownerId },
      { matrixUserId: f.identity.userId, kind: 'agent', ownerId: principal.ownerId,
        participantId: f.identity.participantId },
    ] });
    delete f.joined[f.identity.userId];
    expect(await f.matrix.sessions.resolveRoomParticipants(principal.ownerId, room, [f.identity.userId]))
      .toMatchObject({ kind: 'ok', participants: [{ kind: 'agent', participantId: f.identity.participantId }] });
    expect(await f.matrix.sessions.resolveRoomParticipants(principal.ownerId, room, [user], undefined, [f.identity.participantId]))
      .toMatchObject({ kind: 'ok', participants: [expect.anything(), { kind: 'agent', participantId: f.identity.participantId }] });
    f.deny();
    expect(await f.matrix.sessions.resolveRoomParticipants(principal.ownerId, room, [f.identity.userId]))
      .toEqual({ kind: 'forbidden' });
  });
  it('does not disclose a departed identity by guessed target ID outside the reader history', async () => {
    const f = await fixture();
    delete f.joined[f.identity.userId];
    f.hideHistory();
    expect(await f.matrix.sessions.resolveRoomParticipants(principal.ownerId, room, [], undefined, [f.identity.participantId]))
      .toEqual({ kind: 'ok', participants: [] });
    expect(await f.matrix.sessions.resolveRoomParticipants(principal.ownerId, room, [f.identity.userId]))
      .toEqual({ kind: 'unavailable' });
  });
  it('includes offline browser devices from every owner and the exact indexed connector, without tokens', async () => {
    const f = await fixture();
    const result = await f.matrix.inspectRoomSenderDevices(principal.ownerId, room);
    expect(result).toEqual({ kind: 'ok', senders: expect.arrayContaining([
      { matrixUserId: user, deviceId: 'WEB_OFFLINE', curve25519: curve },
      { matrixUserId: other, deviceId: 'WEB_OTHER', curve25519: curve },
      { matrixUserId: f.identity.userId, deviceId: 'CONNECTOR_1', curve25519: curve },
    ]) });
    if (result.kind === 'ok') expect(result.senders).toHaveLength(3);
    expect(JSON.stringify(result)).not.toContain('private-roster-token');
  });
  it('ignores non-crypto control devices but retains every published human sender', async () => {
    const f = await fixture();
    f.keys[user]!.KHALA_CONTROL_TEST = { user_id: user, device_id: 'KHALA_CONTROL_TEST', keys: {} };
    f.keys[user]!.WEB_SECOND = device(user, 'WEB_SECOND');
    const result = await f.matrix.inspectRoomSenderDevices(principal.ownerId, room);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.senders).toHaveLength(4);
      expect(result.senders.map(sender => sender.deviceId)).toContain('WEB_SECOND');
      expect(result.senders.map(sender => sender.deviceId)).not.toContain('KHALA_CONTROL_TEST');
    }
  });
  it('refuses an index that changes while the key response is in flight', async () => {
    const f = await fixture();
    f.onQuery(async () => {
      expect((await createOwnerRoomIndex(f.store).markClosing(principal.ownerId, room, 'closing_operation', 0)).kind).toBe('ok');
    });
    expect(await f.matrix.inspectRoomSenderDevices(principal.ownerId, room)).toEqual({ kind: 'unavailable' });
  });
  it('refuses unreadable durable indexes before querying keys', async () => {
    const f = await fixture();
    vi.spyOn(f.store, 'read').mockResolvedValue({ kind: 'unavailable' });
    expect(await f.matrix.inspectRoomSenderDevices(principal.ownerId, room)).toEqual({ kind: 'unavailable' });
    expect(f.fetch.mock.calls.some(([input]) => String(input).endsWith('/keys/query'))).toBe(false);
  });
  it('refuses non-member access before querying keys', async () => {
    const f = await fixture(); f.deny();
    expect(await f.matrix.inspectRoomSenderDevices(principal.ownerId, room)).toEqual({ kind: 'unavailable' });
    expect(f.fetch.mock.calls.some(([input]) => String(input).endsWith('/keys/query'))).toBe(false);
  });
  it.each(['missing-user', 'wrong-device', 'wrong-user', 'bad-key', 'partial-failure', 'missing-owner', 'unindexed-agent', 'membership-change', 'extra-connector', 'missing-connector', 'unknown-human'])(
    'refuses an incomplete or mismatched roster: %s', async defect => {
      const f = await fixture();
      if (defect === 'extra-connector') f.keys[f.identity.userId]!.UNINDEXED = device(f.identity.userId, 'UNINDEXED');
      if (defect === 'missing-connector') delete f.keys[f.identity.userId]!.CONNECTOR_1;
      if (defect === 'unknown-human') f.joined['@khala_invalid:matrix.example.test'] = {};
      if (defect === 'missing-user') delete f.keys[other];
      if (defect === 'wrong-device') f.keys[user]!.WEB_OFFLINE = device(user, 'DIFFERENT');
      if (defect === 'wrong-user') f.keys[user]!.WEB_OFFLINE = device(other, 'WEB_OFFLINE');
      if (defect === 'bad-key') f.keys[user]!.WEB_OFFLINE = { ...device(user, 'WEB_OFFLINE'), keys: { 'curve25519:WEB_OFFLINE': 'invalid' } };
      if (defect === 'partial-failure') f.fail({ 'matrix.example.test': {} });
      if (defect === 'missing-owner') delete f.joined[user];
      if (defect === 'unindexed-agent') f.joined['@khala_a_00000000000000000000000000000000:matrix.example.test'] = {};
      if (defect === 'membership-change') f.changeMembers();
      expect(await f.matrix.inspectRoomSenderDevices(principal.ownerId, room)).toEqual({ kind: 'unavailable' });
    },
  );
});
