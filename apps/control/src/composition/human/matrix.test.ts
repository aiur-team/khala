import { humanInitialsRecordKey } from '@khala/contracts/m1/initials';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { AuthPrincipal, ControlRecord, ControlStore, DeviceId, JsonValue, OwnerId, RoomId, ParticipantId } from '@khala/contracts/messaging/index';
import { profileRecordKey } from '@khala/contracts/m1/profile';
import { defaultHumanColor, humanColorRecordKey } from '@khala/contracts/m1/colors';
import { agentOwnerRecordKey, humanEmailRecordKey } from '@khala/contracts/m1/participants';
import { createMatrixHumanServices } from './matrix';
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
  it('reads a room name using the owner control session and returns null for empty names or failed login', async () => {
    const roomId = '!room:matrix.example.test' as RoomId;
    let name = 'Release planning';
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      if (path.endsWith('/login')) {
        const request = JSON.parse(String(init?.body));
        return json(200, { user_id: request.identifier.user, device_id: request.device_id, access_token: 'control-token' });
      }
      expect(path).toBe(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.name/`);
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer control-token');
      return json(200, { name });
    });
    const matrix = services(fetch);
    expect(await matrix.roomName(principal.ownerId, roomId)).toBe('Release planning');
    expect(fetch).toHaveBeenCalledTimes(2);
    name = '';
    expect(await matrix.roomName(principal.ownerId, roomId)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(3);

    const failedLogin = vi.fn<typeof globalThis.fetch>(async input => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      expect(path).toBe('/_matrix/client/v3/login');
      return json(403, { errcode: 'M_FORBIDDEN' });
    });
    expect(await services(failedLogin).roomName(principal.ownerId, roomId)).toBeNull();
    expect(failedLogin).toHaveBeenCalledTimes(1);
  });
  it('lists a channel\'s members with the names they hold there, only for a joined owner', async () => {
    const roomId = '!room:matrix.example.test' as RoomId;
    let membership = 'join';
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
      if (path.endsWith('/login')) {
        const request = JSON.parse(String(init?.body));
        return json(200, { user_id: request.identifier.user, device_id: request.device_id, access_token: 'control-token' });
      }
      if (path.includes('/state/m.room.member/')) return json(200, { membership });
      if (path.endsWith('/joined_members')) return json(200, { joined: { '@a:matrix.example.test': { display_name: 'alice2' }, '@b:matrix.example.test': {} } });
      throw new Error(`unexpected ${path}`);
    });
    const matrix = services(fetch);
    expect(await matrix.roomMembers(principal.ownerId, roomId)).toEqual([
      { userId: '@a:matrix.example.test', name: 'alice2' }, { userId: '@b:matrix.example.test', name: '@b:matrix.example.test' }]);
    membership = 'leave';
    expect(await matrix.roomMembers(principal.ownerId, roomId)).toBeNull();
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
        if (path.endsWith('/displayname')) return json(200, { displayname: 'Alice' });
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

  it('retries a rate-limited control login after Synapse permits it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-28T20:00:00Z'));
    try {
      const roomId = '!room:matrix.example.test' as RoomId;
      const userId = ownerMatrixUserId(principal.ownerId, 'matrix.example.test');
      let logins = 0;
      const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
        const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
        if (path.endsWith('/login')) {
          logins += 1;
          if (logins === 1) return json(429, { errcode: 'M_LIMIT_EXCEEDED', retry_after_ms: 500 });
          const request = JSON.parse(String(init?.body)) as { device_id: string };
          return json(200, { user_id: userId, device_id: request.device_id, access_token: 'control-token' });
        }
        if (path.includes('/state/m.room.member/')) return json(200, { membership: 'join' });
        throw new Error(`unexpected request ${path}`);
      });
      const matrix = services(fetch);
      const inspect = () => matrix.gateway.inspectMembership({ principal, roomId, history: 'none' });
      expect((await inspect()).kind).toBe('unavailable');
      expect((await inspect()).kind).toBe('unavailable');
      expect(logins).toBe(1);
      vi.setSystemTime(new Date('2026-09-28T20:00:00.501Z'));
      expect((await inspect()).kind).toBe('joined');
      expect(logins).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains the normal cooldown after a later non-rate-limit control failure', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-28T20:00:00Z'));
    try {
      const roomId = '!room:matrix.example.test' as RoomId;
      let logins = 0;
      const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
        const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
        if (path.endsWith('/login')) {
          logins += 1;
          if (logins === 1) return json(429, { errcode: 'M_LIMIT_EXCEEDED', retry_after_ms: 500 });
          if (logins === 2) return json(503, { errcode: 'M_UNAVAILABLE' });
          const request = JSON.parse(String(init?.body)) as { device_id: string };
          return json(200, { user_id: ownerMatrixUserId(principal.ownerId, 'matrix.example.test'),
            device_id: request.device_id, access_token: 'control-token' });
        }
        if (path.includes('/state/m.room.member/')) return json(200, { membership: 'join' });
        throw new Error(`unexpected request ${path}`);
      });
      const matrix = services(fetch);
      const inspect = () => matrix.gateway.inspectMembership({ principal, roomId, history: 'none' });
      expect((await inspect()).kind).toBe('unavailable');
      vi.setSystemTime(new Date('2026-09-28T20:00:00.501Z'));
      expect((await inspect()).kind).toBe('unavailable');
      vi.setSystemTime(new Date('2026-09-28T20:00:01.001Z'));
      expect((await inspect()).kind).toBe('unavailable');
      expect(logins).toBe(2);
      vi.setSystemTime(new Date('2026-09-28T20:01:00.502Z'));
      expect((await inspect()).kind).toBe('joined');
      expect(logins).toBe(3);
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
        if (path.endsWith('/displayname')) return json(200, { displayname: 'Alice' });
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
      if (path.endsWith('/displayname')) return json(200, { displayname: 'Alice' });
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
      if (url.pathname.endsWith('/displayname')) return json(200, { displayname: 'Alice' });
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

  it.each(['none', 'full'] as const)('joins an admitted %s-history participant', async (history) => {
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
      history,
      inviteRevision: 'r1',
    };

    expect(await matrix.gateway.admit(request)).toEqual({
      kind: 'joined',
      room: { roomId, title: 'Shared room', membership: 'joined', revision: `matrix:${roomId}` },
      historyReady: true,
    });
    expect(membershipWrites).toEqual(['invite', 'join']);
  });

  it.each(['absent', 'corrupt', 'mismatch', 'unavailable', 'throw'])('returns unknown for an %s owner map without reading legacy stores', async defect => {
    const userId = '@agent:matrix.example.test';
    const human = ownerMatrixUserId(principal.ownerId, 'matrix.example.test');
    const store = memoryStore();
    store.read = vi.fn(async key => {
      if (key === humanEmailRecordKey(principal.ownerId)) return { kind: 'absent' };
      expect(key).toBe(agentOwnerRecordKey(userId));
      if (defect === 'throw') throw new Error('store offline');
      if (defect === 'absent') return { kind: 'absent' };
      if (defect === 'unavailable') return { kind: 'unavailable' };
      return { kind: 'record', record: { key, revision: 'r1', operationId: 'op', expiresAt: null,
        value: defect === 'corrupt' ? {} : { matrixUserId: '@other:matrix.example.test', ownerId: principal.ownerId,
          ownerLabel: 'Alice', harness: 'codex', label: 'Codex', createdAt: '2026-10-01T00:00:00Z' } } };
    }) as ControlStore['read'];
    const fetch = vi.fn<typeof globalThis.fetch>(async input => {
      const path = new URL(String(input)).pathname;
      if (path.includes('/state/m.room.member/')) return json(200, { membership: 'join' });
      if (path.endsWith('/joined_members')) return json(200, { joined: { [human]: { display_name: 'Alice' }, [userId]: { display_name: 'Agent label' } } });
      throw new Error('unexpected request');
    });
    expect(await services(fetch, store).sessions.resolveRoomParticipants(principal.ownerId, '!room:matrix.example.test' as RoomId,
      [userId, human], undefined, [], { matrixUserId: human, accessToken: 'browser-token' }))
      .toMatchObject({ kind: 'ok', participants: [{ matrixUserId: userId, displayName: 'Agent label', kind: 'unknown' },
        { matrixUserId: human, displayName: 'Alice', kind: 'human' }] });
  });

  it('records the verified email at session mint and returns it only to joined channel members', async () => {
    const userId = ownerMatrixUserId(principal.ownerId, 'matrix.example.test');
    const store = memoryStore();
    let membership = 'join';
    const fetch = vi.fn<typeof globalThis.fetch>(async input => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/login')) return json(200, { user_id: userId, device_id: 'WEB', access_token: 'token' });
      if (path.endsWith('/displayname')) return json(200, { displayname: 'Alice' });
      if (path.includes('/state/m.room.member/')) return json(200, { membership });
      if (path.endsWith('/joined_members')) return json(200, { joined: { [userId]: { display_name: 'Alice' } } });
      return json(200, { device_keys: {} });
    });
    const matrix = services(fetch, store);
    const room = '!room:matrix.example.test' as RoomId;
    const session = { matrixUserId: userId, accessToken: 'browser-token' };
    expect(await matrix.sessions.resolveRoomParticipants(principal.ownerId, room, [userId], undefined, [], session))
      .toEqual({ kind: 'ok', participants: [expect.not.objectContaining({ email: expect.anything() })] });
    expect((await matrix.sessions.issue(principal, 'WEB' as DeviceId)).kind).toBe('ok');
    expect(await store.read(humanEmailRecordKey(principal.ownerId))).toMatchObject({ kind: 'record',
      record: { value: { v: 1, ownerId: principal.ownerId, email: principal.verifiedEmail } } });
    expect(await matrix.sessions.resolveRoomParticipants(principal.ownerId, room, [userId], undefined, [], session))
      .toMatchObject({ kind: 'ok', participants: [{ kind: 'human', displayName: 'Alice', email: principal.verifiedEmail }] });
    expect(await matrix.sessions.resolveParticipants([userId]))
      .toEqual({ kind: 'ok', participants: [expect.not.objectContaining({ email: expect.anything() })] });
    membership = 'leave';
    expect((await matrix.sessions.resolveRoomParticipants(principal.ownerId, room, [userId], undefined, [], session)).kind).not.toBe('ok');
  });

  it.each([undefined, '', 'x'.repeat(257), 'bad\u0000label', 'bad\u0080label'])('falls back for invalid joined display names', async name => {
    const human = ownerMatrixUserId(principal.ownerId, 'matrix.example.test');
    const fetch = vi.fn<typeof globalThis.fetch>(async input => String(input).endsWith('/joined_members')
      ? json(200, { joined: { [human]: { display_name: name } } }) : json(200, { membership: 'join' }));
    expect(await services(fetch).sessions.resolveRoomParticipants(principal.ownerId, '!room:matrix.example.test' as RoomId,
      [human], undefined, [], { matrixUserId: human, accessToken: 'browser-token' }))
      .toMatchObject({ kind: 'ok', participants: [{ displayName: human, kind: 'human' }] });
  });

  it.each(['Alice', 'Old label'])('sets the browser display name only when different from %s', async current => {
    const userId = ownerMatrixUserId(principal.ownerId, 'matrix.example.test');
    const writes: unknown[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/login')) return json(200, { user_id: userId, device_id: 'WEB', access_token: 'token' });
      if (path.endsWith('/displayname')) {
        if (init?.headers) expect(new Headers(init.headers).get('authorization')).toBe('Bearer token');
        if (init?.method === 'PUT') writes.push(JSON.parse(String(init.body)));
        return json(200, { displayname: current });
      }
      return json(200, { device_keys: {} });
    });
    expect((await services(fetch).sessions.issue(principal, 'WEB' as DeviceId)).kind).toBe('ok');
    expect(writes).toEqual(current === 'Alice' ? [] : [{ displayname: 'Alice' }]);
    expect(await services(fetch).sessions.resolveParticipants([userId]))
      .toMatchObject({ kind: 'ok', participants: [{ kind: 'human', displayName: userId }] });
  });

  it.each(['same', 'different', 'read_failure', 'write_failure', 'throw', 'login_failure'])('sets the owner display name with a %s response', async state => {
    const userId = ownerMatrixUserId(principal.ownerId, 'matrix.example.test');
    const writes: unknown[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/login')) {
        const payload = JSON.parse(String(init?.body));
        return state === 'login_failure' ? json(503, {})
          : json(200, { user_id: userId, device_id: payload.device_id, access_token: 'control-token' });
      }
      if (path.endsWith('/displayname')) {
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer control-token');
        if (state === 'throw') throw new Error('offline');
        if (init?.method === 'PUT') {
          writes.push(JSON.parse(String(init.body)));
          return json(state === 'write_failure' ? 503 : 200, {});
        }
        return json(state === 'read_failure' ? 503 : 200, { displayname: state === 'same' ? 'Alice.W' : 'Old' });
      }
      return json(503, {});
    });
    expect(await services(fetch).setOwnerDisplayName(principal.ownerId, 'Alice.W'))
      .toBe(state === 'same' || state === 'different');
    expect(writes).toEqual(['different', 'write_failure'].includes(state) ? [{ displayname: 'Alice.W' }] : []);
  });

  it.each(['stored', 'unavailable', 'throw'])('reconciles the session display name safely with a %s profile', async state => {
    const store = memoryStore();
    const key = `profiles/${encodeURIComponent(principal.ownerId)}`;
    await store.compareAndSet({ key, expectedRevision: null, operationId: 'profile-test', next: {
      value: { v: 1, ownerId: principal.ownerId, username: 'Alice.W', updatedAt: '2026-10-02T18:00:00.000Z' }, expiresAt: null,
    } });
    const read = store.read.bind(store);
    store.read = async (requested, options) => {
      if (requested === key && state === 'unavailable') return { kind: 'unavailable' };
      if (requested === key && state === 'throw') throw new Error('offline');
      return read(requested, options);
    };
    const userId = ownerMatrixUserId(principal.ownerId, 'matrix.example.test');
    const writes: unknown[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/login')) return json(200, { user_id: userId, device_id: 'WEB', access_token: 'token' });
      if (path.endsWith('/displayname')) {
        if (init?.method === 'PUT') writes.push(JSON.parse(String(init.body)));
        return json(200, { displayname: 'Old' });
      }
      return json(200, { device_keys: {} });
    });
    expect(await services(fetch, store).sessions.issue(principal, 'WEB' as DeviceId)).toMatchObject({ kind: 'ok' });
    expect(writes).toEqual(state === 'stored' ? [{ displayname: 'Alice.W' }] : []);
  });

  it.each(['missing', 'read', 'write', 'throw', 'malformed'])('mints a session despite a %s display-name response', async failure => {
    const userId = ownerMatrixUserId(principal.ownerId, 'matrix.example.test');
    const writes: unknown[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/login')) return json(200, { user_id: userId, device_id: 'WEB', access_token: 'token' });
      if (path.endsWith('/keys/query')) return json(200, { device_keys: {} });
      if (init?.method === 'PUT') {
        writes.push(JSON.parse(String(init.body)));
        return json(failure === 'write' ? 500 : 200, {});
      }
      if (failure === 'throw') throw new Error('offline');
      if (failure === 'malformed') return new Response('invalid JSON', { status: 200 });
      return json(failure === 'missing' ? 404 : failure === 'read' ? 503 : 200, { displayname: 'Old' });
    });
    expect(await services(fetch).sessions.issue(principal, 'WEB' as DeviceId)).toMatchObject({ kind: 'ok' });
    expect(writes).toEqual(['missing', 'write', 'malformed'].includes(failure) ? [{ displayname: 'Alice' }] : []);
  });

  it('resolves only canonical local participant accounts', async () => {
    const fetch = vi.fn();
    const matrix = services(fetch);
    const userId = ownerMatrixUserId(principal.ownerId, 'matrix.example.test');
    const result = await matrix.sessions.resolveParticipants([userId]);
    expect(result).toMatchObject({
      kind: 'ok',
      participants: [{ matrixUserId: userId, ownerId: principal.ownerId, displayName: userId }],
    });
    expect(await matrix.sessions.resolveParticipants(['@khala_bad:elsewhere.test'])).toEqual({ kind: 'ok',
      participants: [{ matrixUserId: '@khala_bad:elsewhere.test', displayName: '@khala_bad:elsewhere.test', kind: 'unknown' }] });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('owner-map room participants', () => {
  const room = '!roster:matrix.example.test' as RoomId;
  const user = ownerMatrixUserId(principal.ownerId, 'matrix.example.test');
  async function fixture() {
    const store = memoryStore();
    const identity = { userId: '@khala_a_roster:matrix.example.test', participantId: 'agent_roster' as never };
    await store.compareAndSet({ key: agentOwnerRecordKey(identity.userId), expectedRevision: null, operationId: 'owner-map', next: { expiresAt: null, value: { matrixUserId: identity.userId, ownerId: principal.ownerId, ownerLabel: 'Alice', harness: 'codex', label: 'Codex', createdAt: '2026-10-01T00:00:00Z' } } });
    const joined: Record<string, unknown> = { [user]: {}, [identity.userId]: {} };
    let denied = false;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (path.endsWith('/login')) {
        const request = JSON.parse(String(init?.body));
        return json(200, { user_id: request.identifier.user, device_id: request.device_id, access_token: 'private-roster-token' });
      }
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer private-roster-token');
      if (path.includes('/state/m.room.member/')) return denied ? json(403, { errcode: 'M_FORBIDDEN' })
        : json(200, { membership: 'join' });
      if (path.endsWith('/joined_members')) return json(200, { joined });
    if (path.endsWith('/state')) return json(200, []);
      throw new Error('unexpected participant request');
    });
    return { store, matrix: services(fetch, store), identity, joined, deny: () => { denied = true; } };
  }
  it('shares stored colours across humans and agents and defaults unconfigured humans', async () => {
    const f = await fixture();
    const key = humanColorRecordKey(principal.ownerId);
    await f.store.compareAndSet({ key, expectedRevision: null, operationId: 'color',
      next: { expiresAt: null, value: { v: 1, ownerId: principal.ownerId, color: 'pink' } } });
    const otherOwner = 'owner_bob' as OwnerId;
    const otherUser = ownerMatrixUserId(otherOwner, 'matrix.example.test');
    f.joined[otherUser] = {};
    const spy = vi.spyOn(f.store, 'read');
    expect(await f.matrix.sessions.resolveRoomParticipants(principal.ownerId, room, [user, f.identity.userId, otherUser]))
      .toMatchObject({ kind: 'ok', participants: [
        { kind: 'human', color: 'pink' }, { kind: 'agent', ownerColor: 'pink' },
        { kind: 'human', color: defaultHumanColor(otherOwner) },
      ] });
    expect(spy.mock.calls.filter(([readKey]) => readKey === key)).toHaveLength(1);
    // An owner's agent still receives the colour when the owner is not in this channel.
    delete f.joined[user];
    expect(await f.matrix.sessions.resolveRoomParticipants(principal.ownerId, room, [f.identity.userId]))
      .toMatchObject({ kind: 'ok', participants: [{ kind: 'agent', ownerColor: 'pink' }] });
    spy.mockClear();
    expect(await f.matrix.sessions.resolveParticipants([user]))
      .toEqual({ kind: 'ok', participants: [expect.not.objectContaining({ color: expect.anything() })] });
    expect(spy.mock.calls.filter(([readKey]) => readKey === key)).toHaveLength(0);
  });
  it.each(['absent', 'invalid', 'foreign', 'unavailable', 'throw'] as const)('defaults human and agent colours on %s records', async failure => {
    const f = await fixture();
    const key = humanColorRecordKey(principal.ownerId);
    const read = f.store.read;
    vi.spyOn(f.store, 'read').mockImplementation(async <T extends JsonValue>(readKey: string) => {
      if (readKey !== key) return read<T>(readKey);
      if (failure === 'throw') throw Error('offline');
      if (failure === 'unavailable' || failure === 'absent') return { kind: failure };
      return { kind: 'record', record: { key, revision: 'color-r1', operationId: 'color', expiresAt: null,
        value: { v: 1, ownerId: failure === 'foreign' ? 'owner_other' : principal.ownerId,
          color: failure === 'invalid' ? 'chartreuse' : 'pink' } as unknown as T } };
    });
    expect(await f.matrix.sessions.resolveRoomParticipants(principal.ownerId, room, [user, f.identity.userId]))
      .toMatchObject({ kind: 'ok', participants: [
        { color: defaultHumanColor(principal.ownerId) }, { ownerColor: defaultHumanColor(principal.ownerId) },
      ] });
  });
  it('shares stored initials across humans and agents and defaults unconfigured humans', async () => {
    const f = await fixture();
    const key = humanInitialsRecordKey(principal.ownerId);
    await f.store.compareAndSet({ key, expectedRevision: null, operationId: 'initials',
      next: { expiresAt: null, value: { v: 1, ownerId: principal.ownerId, initials: 'KW' } } });
    const otherOwner = 'owner_bob' as OwnerId;
    const otherUser = ownerMatrixUserId(otherOwner, 'matrix.example.test');
    f.joined[otherUser] = {};
    const spy = vi.spyOn(f.store, 'read');
    expect(await f.matrix.sessions.resolveRoomParticipants(principal.ownerId, room, [user, f.identity.userId, otherUser]))
      .toMatchObject({ kind: 'ok', participants: [
        { kind: 'human', initials: 'KW' }, { kind: 'agent', ownerInitials: 'KW' },
        expect.not.objectContaining({ initials: expect.anything() }),
      ] });
    expect(spy.mock.calls.filter(([readKey]) => readKey === key)).toHaveLength(1);
    // An owner's agent still receives the initials when the owner is not in this channel.
    delete f.joined[user];
    expect(await f.matrix.sessions.resolveRoomParticipants(principal.ownerId, room, [f.identity.userId]))
      .toMatchObject({ kind: 'ok', participants: [{ kind: 'agent', ownerInitials: 'KW' }] });
    spy.mockClear();
    expect(await f.matrix.sessions.resolveParticipants([user]))
      .toEqual({ kind: 'ok', participants: [expect.not.objectContaining({ initials: expect.anything() })] });
    expect(spy.mock.calls.filter(([readKey]) => readKey.endsWith('/initials'))).toHaveLength(0);
  });
  it.each(['absent', 'invalid', 'foreign', 'unavailable', 'throw', 'cleared'] as const)('defaults human and agent initials on %s records', async failure => {
    const f = await fixture();
    const key = humanInitialsRecordKey(principal.ownerId);
    const read = f.store.read;
    vi.spyOn(f.store, 'read').mockImplementation(async <T extends JsonValue>(readKey: string) => {
      if (readKey !== key) return read<T>(readKey);
      if (failure === 'throw') throw Error('offline');
      if (failure === 'unavailable' || failure === 'absent') return { kind: failure };
      return { kind: 'record', record: { key, revision: 'initials-r1', operationId: 'initials', expiresAt: null,
        value: { v: 1, ownerId: failure === 'foreign' ? 'owner_other' : principal.ownerId,
          initials: failure === 'invalid' ? 'kw' : failure === 'cleared' ? null : 'KW' } as unknown as T } };
    });
    const result = await f.matrix.sessions.resolveRoomParticipants(principal.ownerId, room, [user, f.identity.userId]);
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.participants[0]).not.toHaveProperty('initials');
      expect(result.participants[1]).not.toHaveProperty('ownerInitials');
    }
  });
  it('resolves an agent from its owner map only for a joined human', async () => {
    const f = await fixture();
    f.joined[user] = { display_name: 'Alice' };
    f.joined[f.identity.userId] = { display_name: 'Codex · Alice' };
    const result = await f.matrix.sessions.resolveRoomParticipants(principal.ownerId, room, [user, f.identity.userId]);
    expect(result).toMatchObject({ kind: 'ok', participants: [
      { matrixUserId: user, ownerId: principal.ownerId, kind: 'human', displayName: 'Alice' },
      { matrixUserId: f.identity.userId, kind: 'agent', ownerId: principal.ownerId, displayName: 'Codex · Alice', ownerLabel: 'Alice', harness: 'codex',
        participantId: `agent_${createHash('sha256').update(f.identity.userId).digest('hex').slice(0, 40)}` },
    ] });
    delete f.joined[f.identity.userId];
    expect(await f.matrix.sessions.resolveRoomParticipants(principal.ownerId, room, [f.identity.userId]))
      .toMatchObject({ kind: 'ok', participants: [{ kind: 'agent', participantId: `agent_${createHash('sha256').update(f.identity.userId).digest('hex').slice(0, 40)}` }] });
    expect(await f.matrix.sessions.resolveRoomParticipants(principal.ownerId, room, [user], undefined, [f.identity.participantId]))
      .toMatchObject({ kind: 'ok', participants: [expect.objectContaining({ kind: 'human' })] });
    f.deny();
    expect(await f.matrix.sessions.resolveRoomParticipants(principal.ownerId, room, [f.identity.userId]))
      .toEqual({ kind: 'forbidden' });
  });
  it('reads current owner usernames once per owner per resolution and falls back on profile failures', async () => {
    const f = await fixture();
    const peer = '@second:matrix.example.test';
    await f.store.compareAndSet({ key: agentOwnerRecordKey(peer), expectedRevision: null, operationId: 'second-agent',
      next: { expiresAt: null, value: { matrixUserId: peer, ownerId: principal.ownerId, ownerLabel: 'Alice', harness: 'claude', label: 'Alice-Claude', createdAt: '2026-10-01T00:00:00Z' } } });
    const key = profileRecordKey(principal.ownerId);
    const profile = await f.store.compareAndSet({ key, expectedRevision: null, operationId: 'profile',
      next: { expiresAt: null, value: { v: 1, ownerId: principal.ownerId, username: 'Kev', updatedAt: '2026-10-01T00:00:00Z' } } });
    if (profile.kind !== 'applied') throw Error();
    const read = f.store.read;
    const spy = vi.spyOn(f.store, 'read');
    expect(await f.matrix.sessions.resolveRoomParticipants(principal.ownerId, room, [f.identity.userId, peer]))
      .toMatchObject({ kind: 'ok', participants: [{ ownerLabel: 'Kev' }, { ownerLabel: 'Kev' }] });
    expect(spy.mock.calls.filter(([readKey]) => readKey === key)).toHaveLength(1);
    await f.store.compareAndSet({ key, expectedRevision: profile.record.revision, operationId: 'rename',
      next: { expiresAt: null, value: { v: 1, ownerId: principal.ownerId, username: 'Kevin', updatedAt: '2026-10-01T00:00:01Z' } } });
    expect(await f.matrix.sessions.resolveRoomParticipants(principal.ownerId, room, [f.identity.userId]))
      .toMatchObject({ kind: 'ok', participants: [{ ownerLabel: 'Kevin' }] });
    for (const failure of ['unavailable', 'throw', 'invalid', 'foreign'] as const) {
      spy.mockImplementation(async <T extends JsonValue>(readKey: string) => {
        if (readKey !== key) return read<T>(readKey);
        if (failure === 'throw') throw Error('offline');
        if (failure === 'unavailable') return { kind: 'unavailable' };
        const stored = await read<T>(readKey);
        if (stored.kind !== 'record') throw Error();
        return { ...stored, record: { ...stored.record, value: (failure === 'invalid' ? {} : { v: 1, ownerId: 'other', username: 'Other', updatedAt: '2026-10-01T00:00:00Z' }) as T } };
      });
      expect(await f.matrix.sessions.resolveRoomParticipants(principal.ownerId, room, [f.identity.userId]))
        .toMatchObject({ kind: 'ok', participants: [{ ownerLabel: 'Alice' }] });
    }
  });
  it('ignores target ids and preserves departed agent attribution', async () => {
    const f = await fixture();
    delete f.joined[f.identity.userId];
    expect(await f.matrix.sessions.resolveRoomParticipants(principal.ownerId, room, [], undefined, [f.identity.participantId]))
      .toEqual({ kind: 'ok', participants: [] });
    expect(await f.matrix.sessions.resolveRoomParticipants(principal.ownerId, room, [f.identity.userId]))
      .toMatchObject({ kind: 'ok', participants: [{ kind: 'agent' }] });
  });
});

describe('browser-backed room participant reads', () => {
  it('uses the verified browser bearer across fresh Control instances without consuming the 20-login burst', async () => {
    const roomId = '!history:matrix.example.test' as RoomId;
    const userId = ownerMatrixUserId(principal.ownerId, 'matrix.example.test');
    const peer = ownerMatrixUserId('owner_bob' as OwnerId, 'matrix.example.test');
    let logins = 0;
    let reads = 0;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      if (path.endsWith('/login')) {
        logins++;
        return json(logins > 20 ? 429 : 200, {});
      }
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer browser-token-123456789');
      reads++;
      if (path.includes('/state/m.room.member/')) return json(200, { membership: 'join' });
      if (path.endsWith('/joined_members')) return json(200, { joined: { [userId]: {}, [peer]: {} } });
      throw new Error('unexpected Matrix request');
    });
    for (let i = 0; i < 25; i++) {
      const matrix = services(fetch);
      expect(await matrix.sessions.resolveRoomParticipants(principal.ownerId, roomId, [userId, peer], undefined, [],
        { matrixUserId: userId, accessToken: 'browser-token-123456789' }))
        .toMatchObject({ kind: 'ok', participants: [{ matrixUserId: userId }, { matrixUserId: peer }] });
    }
    expect(reads).toBe(50);
    expect(logins).toBe(0);
    expect(await services(fetch).sessions.resolveRoomParticipants(principal.ownerId, roomId, [peer], undefined, [],
      { matrixUserId: peer, accessToken: 'browser-token-123456789' })).toEqual({ kind: 'forbidden' });
  });

  it('denies a nonmember and fails closed when Matrix rejects the browser bearer', async () => {
    const roomId = '!history:matrix.example.test' as RoomId;
    const userId = ownerMatrixUserId(principal.ownerId, 'matrix.example.test');
    let membershipStatus = 403;
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      expect(path).not.toContain('/login');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer browser-token-123456789');
      return json(membershipStatus, { errcode: membershipStatus === 401 ? 'M_UNKNOWN_TOKEN' : 'M_FORBIDDEN' });
    });
    const matrix = services(fetch);
    const session = { matrixUserId: userId, accessToken: 'browser-token-123456789' };
    expect(await matrix.sessions.resolveRoomParticipants(principal.ownerId, roomId, [userId], undefined, [], session))
      .toEqual({ kind: 'forbidden' });
    membershipStatus = 401;
    expect(await matrix.sessions.resolveRoomParticipants(principal.ownerId, roomId, [userId], undefined, [], session))
      .toEqual({ kind: 'unavailable', localDiagnostic: { stage: 'membership', status: 401 } });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('uses the browser bearer and ignores participant-id targets', async () => {
    const roomId = '!history:matrix.example.test' as RoomId;
    const userId = ownerMatrixUserId(principal.ownerId, 'matrix.example.test');
    const identity = { participantId: 'agent_history' as ParticipantId };
    const store = memoryStore();
    const seen: string[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const path = new URL(input instanceof Request ? input.url : String(input)).pathname;
      expect(path).not.toContain('/login');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer browser-token-123456789');
      seen.push(path);
      if (path.includes('/state/m.room.member/')) return json(200, { membership: 'join' });
      if (path.endsWith('/joined_members')) return json(200, { joined: { [userId]: {} } });
      throw new Error('unexpected Matrix request');
    });
    const result = await services(fetch, store).sessions.resolveRoomParticipants(principal.ownerId, roomId, [], undefined,
      [identity.participantId], { matrixUserId: userId, accessToken: 'browser-token-123456789' });
    expect(result).toEqual({ kind: 'ok', participants: [] });
    expect(seen).toHaveLength(2);
  });
});

it('uses the Matrix creator and removes only the selected human and their verified agents, retrying partial failure', async () => {
  const roomId = '!removal:matrix.example.test' as RoomId;
  const target = 'owner_bob' as OwnerId;
  const creatorUser = ownerMatrixUserId(principal.ownerId, 'matrix.example.test');
  const targetUser = ownerMatrixUserId(target, 'matrix.example.test');
  const joined: Record<string, object> = { [creatorUser]: {}, [targetUser]: {}, '@agent1:matrix.example.test': {}, '@agent2:matrix.example.test': {}, '@other:matrix.example.test': {} };
  const store = memoryStore();
  for (const [user, owner] of [['@agent1:matrix.example.test', target], ['@agent2:matrix.example.test', target], ['@other:matrix.example.test', principal.ownerId]]) {
    await store.compareAndSet({ key: agentOwnerRecordKey(user!), expectedRevision: null, operationId: user!, next: { value: { matrixUserId: user!, ownerId: owner!, ownerLabel: 'Bob', harness: 'codex', label: 'Agent', createdAt: '2026-10-05T00:00:00Z' }, expiresAt: null } });
  }
  let fail = true;
  const kicked: string[] = [];
  const revoked: string[] = [];
  const notices: { transaction: string; content: Record<string, unknown> }[] = [];
  let lastLogin = '';
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
    if (path.endsWith('/login')) {
      const value = JSON.parse(String(init?.body));
      lastLogin = value.identifier.user;
      return json(200, { user_id: value.identifier.user, device_id: value.device_id, access_token: value.identifier.user });
    }
    if (path.includes('/state/m.room.member/')) return json(200, { membership: 'join' });
    if (path.includes('/state/m.room.create/')) return json(200, { creator: creatorUser });
    if (path.endsWith('/joined_members')) return json(200, { joined });
    if (path.endsWith('/state')) return json(200, []);
    if (path.endsWith('/joined_rooms')) return json(200, { joined_rooms: [] });
    if (path.endsWith('/logout/all')) { revoked.push(lastLogin); return json(200, {}); }
    if (path.endsWith('/logout')) return json(200, {});
    if (path.includes('/send/com.khala.event.v1/')) { notices.push({ transaction: path, content: JSON.parse(String(init?.body)) }); return json(200, { event_id: '$left' }); }
    if (path.endsWith('/kick') || path.endsWith('/ban')) {
      const user = JSON.parse(String(init?.body)).user_id;
      if (user === '@agent2:matrix.example.test' && fail) return json(503, {});
      kicked.push(user); delete joined[user]; return json(200, {});
    }
    throw new Error(path);
  });
  const matrix = services(fetch, store);
  expect(await matrix.administration.creator(principal, roomId)).toEqual({ kind: 'ok', ownerId: principal.ownerId });
  expect(await matrix.administration.removeHuman({ ...principal, ownerId: target }, roomId, principal.ownerId)).toEqual({ kind: 'forbidden' });
  expect(await matrix.administration.removeHuman(principal, roomId, principal.ownerId)).toEqual({ kind: 'forbidden' });
  expect(await matrix.administration.removeHuman(principal, roomId, 'missing' as OwnerId)).toEqual({ kind: 'not_found' });
  expect(await matrix.administration.removeHuman(principal, roomId, target)).toEqual({ kind: 'unavailable' });
  expect(joined[targetUser]).toBeUndefined();
  fail = false;
  expect(await matrix.administration.removeHuman(principal, roomId, target)).toEqual({ kind: 'ok' });
  expect(kicked).toEqual([targetUser, '@agent1:matrix.example.test', '@agent2:matrix.example.test']);
  expect(joined['@other:matrix.example.test']).toBeDefined();
  expect(new Set(revoked)).toEqual(new Set(['@agent1:matrix.example.test', '@agent2:matrix.example.test']));
  expect(notices).toHaveLength(1);
  expect(notices[0]?.content.summary).toBe(`${targetUser} left`);
  expect(await matrix.administration.removeHuman(principal, roomId, target)).toEqual({ kind: 'ok' });
  expect(notices).toHaveLength(1);
});

it('serializes a second removal against a paused owner-authorized unban and then rejects the old generation', async () => {
  const roomId = '!lease:matrix.example.test' as RoomId;
  const target = 'owner_bob' as OwnerId;
  const creatorUser = ownerMatrixUserId(principal.ownerId, 'matrix.example.test');
  const targetUser = ownerMatrixUserId(target, 'matrix.example.test');
  let targetMembership = 'join';
  let unbanStarted!: () => void; let releaseUnban!: () => void;
  const started = new Promise<void>(resolve => { unbanStarted = resolve; });
  const pause = new Promise<void>(resolve => { releaseUnban = resolve; });
  const mutations: string[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
    if (path.endsWith('/login')) {
      const value = JSON.parse(String(init?.body));
      return json(200, { user_id: value.identifier.user, device_id: value.device_id, access_token: value.identifier.user });
    }
    if (path.includes('/state/m.room.member/')) return json(200, { membership: path.endsWith(encodeURIComponent(targetUser)) ? targetMembership : 'join' });
    if (path.includes('/state/m.room.create/')) return json(200, { creator: creatorUser });
    if (path.includes('/state/m.room.name/')) return json(200, { name: 'Room' });
    if (path.endsWith('/joined_members')) return json(200, { joined: { [creatorUser]: {}, ...(targetMembership === 'join' ? { [targetUser]: {} } : {}) } });
    if (path.endsWith('/state')) return json(200, []);
    if (path.endsWith('/ban')) { mutations.push('ban'); targetMembership = 'ban'; return json(200, {}); }
    if (path.endsWith('/unban')) { mutations.push('unban'); unbanStarted(); await pause; targetMembership = 'leave'; return json(200, {}); }
    if (path.endsWith('/invite')) { mutations.push('invite'); targetMembership = 'invite'; return json(200, {}); }
    if (path.includes('/v3/join/')) { mutations.push('join'); targetMembership = 'join'; return json(200, { room_id: roomId }); }
    if (path.includes('/send/com.khala.event.v1/')) return json(200, { event_id: '$left' });
    throw new Error(path);
  });
  const matrix = services(fetch);
  expect(await matrix.administration.removeHuman(principal, roomId, target)).toEqual({ kind: 'ok' });
  const input = { operationId: 'fresh', roomId, principal: { ...principal, ownerId: target }, deviceId: 'DEVICE' as DeviceId,
    history: 'none' as const, inviteRevision: 'r1', removalGeneration: 1, inviteCreatorOwnerId: principal.ownerId };
  const admission = matrix.gateway.admit(input);
  await started;
  expect(await matrix.administration.removeHuman(principal, roomId, target)).toEqual({ kind: 'unavailable' });
  expect(mutations).toEqual(['ban', 'unban']);
  releaseUnban();
  expect((await admission).kind).toBe('joined');
  expect(await matrix.administration.removeHuman(principal, roomId, target)).toEqual({ kind: 'ok' });
  expect(targetMembership).toBe('ban');
  expect(await matrix.gateway.admit(input)).toEqual({ kind: 'forbidden' });
  expect(targetMembership).toBe('ban');
  expect(mutations).toEqual(['ban', 'unban', 'invite', 'join', 'ban']);
});
