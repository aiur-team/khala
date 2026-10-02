import { describe, expect, it } from 'vitest';
import type { AuthPrincipal } from '@khala/contracts/messaging/index';
import { T0 } from '../../auth/support.test';
import { ownerMatrixUserId } from './matrix-identity';
import { createMatrixBrowserSenderVerifier } from './browser-sender';
const principal = { v: 1, ownerId: 'owner_a', providerIssuer: 'https://id.example', providerSubject: 'owner_a', verifiedEmail: 'owner@example.test', sessionExpiresAt: new Date(T0 + 60_000).toISOString() } as AuthPrincipal;
const human = { deviceId: 'browser_device', deviceKey: 'A'.repeat(43) };
describe('createMatrixBrowserSenderVerifier', () => {
  it('verifies the transient browser Matrix token and exact published Curve25519 device key', async () => {
    const userId = ownerMatrixUserId(principal.ownerId, 'example.test');
    const fetch = async (url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({ authorization: 'Bearer valid-browser-token-123456789' });
      return Response.json(String(url).endsWith('/account/whoami')
        ? { user_id: userId, device_id: human.deviceId }
        : { device_keys: { [userId]: { [human.deviceId]: { user_id: userId, device_id: human.deviceId,
          keys: { [`curve25519:${human.deviceId}`]: human.deviceKey } } } } });
    };
    const verify = createMatrixBrowserSenderVerifier({ homeserverOrigin: 'https://matrix.example.test',
      serverName: 'example.test', fetch: fetch as typeof globalThis.fetch });
    expect(await verify(principal, human.deviceId, 'valid-browser-token-123456789'))
      .toEqual({ matrixUserId: userId, deviceKey: human.deviceKey });
    expect(await verify(principal, 'other_device', 'valid-browser-token-123456789')).toBeNull();
    const rejected = (who: unknown, keys: unknown) => createMatrixBrowserSenderVerifier({
      homeserverOrigin: 'https://matrix.example.test', serverName: 'example.test',
      fetch: (async (url: string | URL | Request) => Response.json(String(url).endsWith('/account/whoami') ? who : keys)) as typeof globalThis.fetch,
    });
    const wrongOwner = rejected({ user_id: '@other:example.test', device_id: human.deviceId }, {});
    expect(await wrongOwner(principal, human.deviceId, 'valid-browser-token-123456789')).toBeNull();
    const unpublished = rejected({ user_id: userId, device_id: human.deviceId }, { device_keys: { [userId]: {} } });
    expect(await unpublished(principal, human.deviceId, 'valid-browser-token-123456789')).toBeNull();
    const expired = createMatrixBrowserSenderVerifier({ homeserverOrigin: 'https://matrix.example.test',
      serverName: 'example.test', fetch: (async () => Response.json({ errcode: 'M_UNKNOWN_TOKEN' }, { status: 401 })) as typeof globalThis.fetch });
    expect(await expired(principal, human.deviceId, 'expired-browser-token-123456789')).toBeNull();
  });
});
