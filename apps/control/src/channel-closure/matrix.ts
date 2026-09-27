import { createHash } from 'node:crypto';
import type { AuthPrincipal, CallOptions, DeviceId, OwnerId, RoomId } from '@khala/contracts/messaging/index';
import type { MatrixSessionIssuer } from '../composition/human/matrix';
import type { ClosureTransport } from './service';

/**
 * Uses the owner's Matrix account on a dedicated control device. A successful
 * Matrix leave ends delivery to that account; it is not a room deletion.
 */
export function createMatrixClosureTransport(input: Readonly<{
  principal: AuthPrincipal;
  sessions: MatrixSessionIssuer;
  homeserverOrigin: string;
  fetch?: typeof globalThis.fetch;
}>): ClosureTransport {
  const origin = new URL(input.homeserverOrigin);
  if (origin.protocol !== 'https:' || origin.origin !== input.homeserverOrigin) throw new Error('invalid Matrix origin');
  const send = input.fetch ?? globalThis.fetch.bind(globalThis);

  async function session(ownerId: OwnerId, options?: CallOptions) {
    if (ownerId !== input.principal.ownerId) return null;
    // Reuse the server-side Matrix control device used by invitation authority.
    const deviceId = `KHALA_CONTROL_${createHash('sha256').update(ownerId).digest('hex').slice(0, 24)}` as DeviceId;
    const result = await input.sessions.issue(input.principal, deviceId, options);
    return result.kind === 'ok' ? result.session : null;
  }

  async function membership(ownerId: OwnerId, roomId: RoomId, options?: CallOptions): Promise<'joined' | 'left' | 'forbidden' | 'unavailable'> {
    try {
      const active = await session(ownerId, options);
      if (!active) return 'unavailable';
      const path = `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.member/${encodeURIComponent(active.userId)}`;
      const response = await send(`${origin.origin}${path}`, {
        headers: { authorization: `Bearer ${active.accessToken}` }, ...(options?.signal ? { signal: options.signal } : {}),
      });
      if (response.status === 403 || response.status === 404) return 'forbidden';
      if (response.status !== 200) return 'unavailable';
      const data: unknown = await response.json();
      const membership = typeof data === 'object' && data !== null ? (data as { membership?: unknown }).membership : null;
      return membership === 'join' ? 'joined' : membership === 'leave' ? 'left' : 'forbidden';
    } catch { return 'unavailable'; }
  }

  return {
    membership,
    async leave(ownerId, roomId, options) {
      try {
        const active = await session(ownerId, options);
        if (!active) return 'unknown';
        const response = await send(`${origin.origin}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/leave`, {
          method: 'POST',
          headers: { authorization: `Bearer ${active.accessToken}`, 'content-type': 'application/json' },
          body: '{}', ...(options?.signal ? { signal: options.signal } : {}),
        });
        if (response.status === 200) return 'left';
        // A retry may encounter an already-left membership. Prove it with a
        // fresh server read instead of treating every 4xx as success.
        return await membership(ownerId, roomId, options) === 'left' ? 'left' : response.status === 403 ? 'forbidden' : 'unknown';
      } catch { return 'unknown'; }
    },
    async requestLocalCleanup() {
      // The server cannot attest that an offline browser or connector cleared
      // local state. The caller receives `partial` until a real cleanup receipt
      // is integrated; transport leave alone never upgrades this to complete.
      return 'unavailable';
    },
  };
}
