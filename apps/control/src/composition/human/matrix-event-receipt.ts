import type { AuthPrincipal, RoomId } from '@khala/contracts/messaging/index';
import { ownerMatrixUserId } from './matrix-identity';
import { createMatrixBrowserSenderVerifier } from './room-send-routes';

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A same-device Matrix receipt. This alone does not assign a trusted send epoch. */
export function createMatrixHumanEventReceiptVerifier(input: Readonly<{
  homeserverOrigin: string;
  serverName: string;
  fetch?: typeof globalThis.fetch;
}>) {
  const verifySender = createMatrixBrowserSenderVerifier(input);
  const transport = input.fetch ?? globalThis.fetch.bind(globalThis);
  return async (expected: Readonly<{
    principal: AuthPrincipal;
    roomId: RoomId;
    deviceId: string;
    deviceKey: string;
    accessToken: string;
    eventId: string;
    transactionId: string;
  }>): Promise<boolean> => {
    if (!expected.eventId.startsWith('$') || !expected.transactionId) return false;
    const sender = await verifySender(expected.principal, expected.deviceId, expected.accessToken);
    if (!sender || sender.deviceKey !== expected.deviceKey) return false;
    try {
      const response = await transport(`${input.homeserverOrigin}/_matrix/client/v3/rooms/${encodeURIComponent(expected.roomId)}/event/${encodeURIComponent(expected.eventId)}`, {
        headers: { authorization: `Bearer ${expected.accessToken}`, accept: 'application/json' },
        signal: AbortSignal.timeout(10_000), redirect: 'error',
      });
      if (response.status !== 200) return false;
      const event: unknown = await response.json();
      return object(event) && event.event_id === expected.eventId && event.room_id === expected.roomId
        && event.sender === ownerMatrixUserId(expected.principal.ownerId, input.serverName)
        && event.type === 'm.room.encrypted' && object(event.unsigned)
        && event.unsigned.transaction_id === expected.transactionId;
    } catch { return false; }
  };
}
