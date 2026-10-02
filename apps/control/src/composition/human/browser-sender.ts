import type { AuthPrincipal } from '@khala/contracts/messaging/index';
import { ownerMatrixUserId } from './matrix-identity';

function object(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }

/** Browser token is checked against Matrix whoami and the exact published Curve25519 device key. */
export type BrowserSenderVerifier = (principal: AuthPrincipal, deviceId: string, accessToken: string) =>
  Promise<Readonly<{ matrixUserId: string; deviceKey: string }> | null>;

export function createMatrixBrowserSenderVerifier(input: Readonly<{
  homeserverOrigin: string; serverName: string; allowInsecureLoopback?: boolean; fetch?: typeof globalThis.fetch;
}>): BrowserSenderVerifier {
  const origin = new URL(input.homeserverOrigin);
  const loopback = input.allowInsecureLoopback === true && origin.protocol === 'http:'
    && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if (origin.origin !== input.homeserverOrigin || !(origin.protocol === 'https:' || loopback)) throw new Error('invalid_matrix_origin');
  const transport = input.fetch ?? globalThis.fetch.bind(globalThis);
  return async (principal, deviceId, accessToken) => {
    const matrixUserId = ownerMatrixUserId(principal.ownerId, input.serverName);
    const headers = { authorization: `Bearer ${accessToken}`, accept: 'application/json' };
    try {
      const who = await transport(`${input.homeserverOrigin}/_matrix/client/v3/account/whoami`, {
        headers, signal: AbortSignal.timeout(10_000), redirect: 'error',
      });
      if (who.status !== 200) return null;
      const identity: unknown = await who.json();
      if (!object(identity) || identity.user_id !== matrixUserId || identity.device_id !== deviceId) return null;
      const keys = await transport(`${input.homeserverOrigin}/_matrix/client/v3/keys/query`, {
        method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ device_keys: { [matrixUserId]: [deviceId] } }),
        signal: AbortSignal.timeout(10_000), redirect: 'error',
      });
      if (keys.status !== 200) return null;
      const result: unknown = await keys.json();
      const users = object(result) && object(result.device_keys) ? result.device_keys : null;
      const devices = users && object(users[matrixUserId]) ? users[matrixUserId] : null;
      const published = devices && object(devices[deviceId]) ? devices[deviceId] : null;
      const deviceKeys = published && object(published.keys) ? published.keys : null;
      const deviceKey = deviceKeys?.[`curve25519:${deviceId}`];
      return published?.user_id === matrixUserId && published.device_id === deviceId
        && typeof deviceKey === 'string' && /^[A-Za-z0-9+/]{43}=?$/u.test(deviceKey)
        ? { matrixUserId, deviceKey } : null;
    } catch { return null; }
  };
}

/** Every command is bound to the authenticated endpoint's own room and published device. */
