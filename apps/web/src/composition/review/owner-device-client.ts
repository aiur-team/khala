import type { BindingId } from '@khala/contracts/delivery/index';
import type { RoomId } from '@khala/contracts/messaging/index';
import { parsePublicOrigin } from '../human/hosted-config';

const CHALLENGE = '/api/human/owner-device-proof/challenge';
const REGISTER = '/api/human/owner-device-proof/register';
const NONCE = /^[A-Za-z0-9_-]{43}$/u;

/** Only the protected registration POST sees this transient Matrix access token. */
export function createOwnerDeviceClient(input: Readonly<{
  origin: string;
  allowInsecureLoopback?: boolean;
  csrf: () => Promise<string | null>;
  fetch?: typeof globalThis.fetch;
}>) {
  const origin = new URL(input.origin);
  if (parsePublicOrigin(input.origin, input.allowInsecureLoopback) !== input.origin) throw new Error('owner_device_origin_invalid');
  const request = input.fetch ?? globalThis.fetch.bind(globalThis);
  return {
    async register(roomId: RoomId, bindingId: BindingId, generation: number,
      device: Readonly<{ deviceId: string; fingerprint: string; matrixAccessToken: string }>): Promise<boolean> {
      const url = new URL(CHALLENGE, origin);
      url.searchParams.set('room_id', roomId);
      url.searchParams.set('binding_id', bindingId);
      url.searchParams.set('binding_generation', String(generation));
      url.searchParams.set('device_id', device.deviceId);
      try {
        const challenge = await request(url, { method: 'GET', credentials: 'same-origin',
          headers: { accept: 'application/json' } });
        if (!challenge.ok || !(challenge.headers.get('content-type') ?? '').startsWith('application/json')) return false;
        const answer: unknown = await challenge.json();
        if (typeof answer !== 'object' || answer === null || !('v' in answer) || answer.v !== 1
          || !('nonce' in answer) || typeof answer.nonce !== 'string' || !NONCE.test(answer.nonce)) return false;
        const csrf = await input.csrf();
        if (!csrf) return false;
        const registered = await request(new URL(REGISTER, origin), { method: 'POST', credentials: 'same-origin',
          headers: { accept: 'application/json', 'content-type': 'application/json', 'x-khala-csrf': csrf },
          body: JSON.stringify({ v: 1, roomId, bindingId, generation, deviceId: device.deviceId,
            fingerprint: device.fingerprint, nonce: answer.nonce, matrixAccessToken: device.matrixAccessToken }),
        });
        if (!registered.ok || !(registered.headers.get('content-type') ?? '').startsWith('application/json')) return false;
        const result: unknown = await registered.json();
        return typeof result === 'object' && result !== null && 'v' in result && result.v === 1
          && 'kind' in result && result.kind === 'pinned';
      } catch { return false; }
    },
  };
}
