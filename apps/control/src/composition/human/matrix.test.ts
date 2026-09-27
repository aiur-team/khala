import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { AuthPrincipal, ControlRecord, ControlStore, DeviceId, JsonValue, OwnerId, RoomId, SessionBinding } from '@khala/contracts/messaging/index';
import { createMatrixHumanServices } from './matrix';
import { createAgentBindingStore } from '../../agent-bootstrap/store';
import { createOwnerRoomIndex } from '../../agent-bootstrap/owner-room-index';
import { agentMatrixIdentity } from '../agent/matrix-admission';

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
  it('provisions a deterministic non-admin account with the Synapse shared-secret MAC', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname.startsWith('/_matrix/client/v3/profile/')) return json(404, { errcode: 'M_NOT_FOUND' });
      if (url.pathname === '/_synapse/admin/v1/register' && init?.method !== 'POST') return json(200, { nonce: 'nonce_1' });
      if (url.pathname === '/_synapse/admin/v1/register') {
        const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(request.admin).toBe(false);
        expect(request.username).toBe(`khala_${Buffer.from(principal.ownerId).toString('base64url')}`);
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
      kind: 'created', accountId: `@khala_${Buffer.from(principal.ownerId).toString('base64url')}:matrix.example.test`,
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
          ? json(200, { user_id: `@khala_${Buffer.from(principal.ownerId).toString('base64url')}:matrix.example.test` })
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
          user_id: `@khala_${Buffer.from(principal.ownerId).toString('base64url')}:matrix.example.test`,
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
    const userId = `@khala_${Buffer.from(principal.ownerId).toString('base64url')}:matrix.example.test`;
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
  const user = `@khala_${Buffer.from(principal.ownerId).toString('base64url')}:matrix.example.test`;
  const otherOwner = 'owner_bob' as OwnerId;
  const other = `@khala_${Buffer.from(otherOwner).toString('base64url')}:matrix.example.test`;
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
    const joined: Record<string, unknown> = { [user]: {}, [other]: {}, [identity.userId]: {} };
    const keys: Record<string, Record<string, unknown>> = {
      [user]: { WEB_OFFLINE: device(user, 'WEB_OFFLINE') },
      [other]: { WEB_OTHER: device(other, 'WEB_OTHER') },
      [identity.userId]: { CONNECTOR_1: device(identity.userId, 'CONNECTOR_1') },
    };
    const expectedUsers = [user, other, identity.userId].sort();
    let afterQuery: (() => Promise<void>) | undefined;
    let denied = false;
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
      if (path.endsWith('/joined_members')) {
        expect(decodeURIComponent(path)).toContain(room);
        membershipReads++;
        if (denied) return json(403, { errcode: 'M_FORBIDDEN' });
        return json(200, { joined: mutateMembership && membershipReads > 1 ? { [user]: {} } : joined });
      }
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
      deny: () => { denied = true; }, fail: (value: unknown) => { failures = value; },
      changeMembers: () => { mutateMembership = true; },
      onQuery: (callback: () => Promise<void>) => { afterQuery = callback; } };
  }
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
