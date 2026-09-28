import { describe, expect, it } from 'vitest';
import type { AuthPrincipal, RoomId } from '@khala/contracts/messaging/index';
import { createMatrixHumanEventReceiptVerifier } from './matrix-event-receipt';
import { ownerMatrixUserId } from './matrix-identity';

const principal = { v: 1, ownerId: 'owner_a', providerIssuer: 'https://id.example',
  providerSubject: 'owner_a', verifiedEmail: 'owner@example.test',
  sessionExpiresAt: '2026-09-29T00:00:00.000Z' } as AuthPrincipal;
const roomId = '!room:example.test' as RoomId;
const deviceId = 'device_a';
const deviceKey = 'A'.repeat(43);
const eventId = '$event:example.test';
const transactionId = 'server_secret_txn';
const matrixUserId = ownerMatrixUserId(principal.ownerId, 'example.test');
const expected = { principal, roomId, deviceId, deviceKey, accessToken: 'device-access-token', eventId, transactionId };
const goodEvent = { event_id: eventId, room_id: roomId, sender: matrixUserId,
  type: 'm.room.encrypted', unsigned: { transaction_id: transactionId } };

function harness(event: unknown, overrides: Readonly<{ who?: unknown; keys?: unknown; eventStatus?: number }> = {}) {
  let eventRequests = 0;
  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    expect(init?.headers).toMatchObject({ authorization: `Bearer ${expected.accessToken}` });
    const path = String(url);
    if (path.endsWith('/account/whoami')) return Response.json(overrides.who ?? { user_id: matrixUserId, device_id: deviceId });
    if (path.endsWith('/keys/query')) return Response.json(overrides.keys ?? { device_keys: {
      [matrixUserId]: { [deviceId]: { user_id: matrixUserId, device_id: deviceId,
        keys: { [`curve25519:${deviceId}`]: deviceKey } } },
    } });
    eventRequests++;
    expect(path).toContain(`/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(eventId)}`);
    return Response.json(event, { status: overrides.eventStatus ?? 200 });
  };
  return { verify: createMatrixHumanEventReceiptVerifier({ homeserverOrigin: 'https://matrix.example.test',
    serverName: 'example.test', fetch: fetch as typeof globalThis.fetch }), eventRequests: () => eventRequests };
}

describe('same-device Matrix event receipt', () => {
  it('accepts an encrypted event only when Matrix reports the exact same-device transaction', async () => {
    const h = harness(goodEvent);
    expect(await h.verify(expected)).toBe(true);
    expect(h.eventRequests()).toBe(1);
  });
  it('rejects a wrong device or published key before fetching an event', async () => {
    const wrongDevice = harness(goodEvent, { who: { user_id: matrixUserId, device_id: 'other' } });
    expect(await wrongDevice.verify(expected)).toBe(false);
    expect(wrongDevice.eventRequests()).toBe(0);
    const wrongKey = harness(goodEvent);
    expect(await wrongKey.verify({ ...expected, deviceKey: 'B'.repeat(43) })).toBe(false);
    expect(wrongKey.eventRequests()).toBe(0);
  });
  it.each([
    { ...goodEvent, event_id: '$other' },
    { ...goodEvent, room_id: '!other:example.test' },
    { ...goodEvent, sender: '@other:example.test' },
    { ...goodEvent, type: 'm.room.message' },
    { ...goodEvent, unsigned: {} },
    { ...goodEvent, unsigned: { transaction_id: 'browser_claim' } },
  ])('rejects an event with a mismatched receipt field', async event => {
    expect(await harness(event).verify(expected)).toBe(false);
  });
  it('fails closed when Matrix cannot return the event', async () => {
    expect(await harness({ error: 'not found' }, { eventStatus: 404 }).verify(expected)).toBe(false);
  });
});
