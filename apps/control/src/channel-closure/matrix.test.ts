import { describe, expect, it, vi } from 'vitest';
import type { AuthPrincipal, OwnerId, RoomId } from '@khala/contracts/messaging/index';
import type { MatrixSessionIssuer } from '../composition/human/matrix';
import { createMatrixClosureTransport } from './matrix';

const ownerId = 'owner_alice' as OwnerId;
const principal: AuthPrincipal = {
  v: 1, ownerId, providerIssuer: 'https://issuer.example', providerSubject: 'alice',
  verifiedEmail: 'alice@example.test', sessionExpiresAt: '2030-01-01T00:00:00Z',
};
const roomId = '!room:matrix.example' as RoomId;

describe('Matrix channel closure transport', () => {
  it('checks the owner membership and leaves only that room with the owner account', async () => {
    const sessions = { issue: vi.fn(async () => ({ kind: 'ok' as const, session: {
      homeserverOrigin: 'https://matrix.example', userId: '@alice:matrix.example', accessToken: 'secret',
      deviceId: 'device_1' as never, publishedFingerprint: null,
    } })) } as unknown as MatrixSessionIssuer;
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'POST'
      ? new Response('{}', { status: 200 })
      : new Response('{"membership":"join"}', { status: 200 }));
    const transport = createMatrixClosureTransport({ principal, sessions, homeserverOrigin: 'https://matrix.example', fetch: fetch as typeof globalThis.fetch });

    expect(transport.connectorConfigured).toBe(false);
    expect(await transport.stopConnectorDelivery({ operationId: 'close_1', ownerId, roomId, expectedRoomRevision: 0 })).toEqual({ kind: 'unavailable' });
    expect(await transport.membership(ownerId, roomId)).toBe('joined');
    expect(await transport.leave(ownerId, roomId)).toBe('left');
    expect(fetch.mock.calls[1]?.[0]).toBe('https://matrix.example/_matrix/client/v3/rooms/!room%3Amatrix.example/leave');
    expect(fetch.mock.calls[1]?.[1]?.headers).toMatchObject({ authorization: 'Bearer secret' });
    expect(await transport.leave('owner_other' as OwnerId, roomId)).toBe('unknown');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await transport.requestLocalCleanup({ operationId: 'close_1', ownerId, roomId, expectedRoomRevision: 0 })).toBe('unavailable');
  });
});
