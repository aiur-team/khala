import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { AuthPrincipal, DeviceId, OwnerId, RoomId } from '@khala/contracts/messaging/index';
import { createMatrixHumanServices } from './matrix';

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

function services(fetch: typeof globalThis.fetch) {
  return createMatrixHumanServices({
    homeserverOrigin: 'https://matrix.example.test',
    serverName: 'matrix.example.test',
    registrationSharedSecret: registrationSecret,
    passwordDerivationSecret: passwordSecret,
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
        expect(request.username).toMatch(/^khala_[a-f0-9]{40}$/u);
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
      kind: 'created', accountId: expect.stringMatching(/^@khala_[a-f0-9]{40}:matrix\.example\.test$/u),
    });
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
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname.endsWith('/login')) {
        const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
        const identifier = request.identifier as Record<string, unknown>;
        return json(200, { user_id: identifier.user, access_token: 'control-token', device_id: request.device_id });
      }
      if (url.pathname.includes('/state/m.room.member/')) {
        return joined ? json(200, { membership: 'join' }) : json(404, { errcode: 'M_NOT_FOUND' });
      }
      if (url.pathname.includes('/_matrix/client/v3/join/')) {
        joined = true;
        return json(200, { room_id: roomId });
      }
      if (url.pathname.includes('/state/m.room.name/')) return json(200, { name: 'Shared room' });
      throw new Error(`unexpected request ${url.pathname}`);
    });
    const matrix = services(fetch);
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
  });
});
