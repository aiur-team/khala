import { describe, expect, it } from 'vitest';
import type { AuthPrincipal, OwnerId, RoomId } from '@khala/contracts/messaging/index';
import { fakeStore, T0 } from '../../auth/support.test';
import { createRoomSendFence } from './room-send-fence';
import { createDeviceAdmission, type Replacement } from './device-admission';
import { createDeviceAdmissionRoutes, DEVICE_ADMISSION_PATH } from './device-admission-routes';

const roomId = '!replacement:example' as RoomId;
const ownerId = 'owner_A' as OwnerId;
const principal = { v: 1, ownerId, providerIssuer: 'https://id.example', providerSubject: 'owner_A',
  verifiedEmail: 'owner@example.test', sessionExpiresAt: new Date(T0 + 60_000).toISOString() } as AuthPrincipal;
const deviceKey = 'C'.repeat(43);
const operationId = 'replacement_1';

function setup() {
  const store = fakeStore(() => T0).store;
  const fence = createRoomSendFence(store);
  let signed = true;
  let originAllowed = true;
  let binding = { ownerId, roomId, deviceId: 'new_A', deviceKey, generation: 2,
    policyDigest: 'd'.repeat(64) };
  let consent = true;
  let position: number | null = 10;
  let distributed = false;
  let tokenKey = deviceKey;
  const authorize = async () => consent ? 'authorized' as const : 'refused' as const;
  const ledger = createDeviceAdmission({ store, authorize, currentPosition: async () => position,
    distributionReady: async () => distributed });
  const routes = createDeviceAdmissionRoutes({ store,
    auth: { async requireHumanMutation() {
      return !signed ? { kind: 'rejected' as const, code: 'signed_out' as const }
        : !originAllowed ? { kind: 'rejected' as const, code: 'forbidden_origin' as const }
          : { kind: 'authorized' as const, context: { principal } };
    } } as never,
    verifyBrowserSender: async (_principal, deviceId, token) => deviceId === 'new_A' && token === 'valid-token-123456789'
      ? { matrixUserId: '@owner_A:example', deviceKey: tokenKey } : null,
    bindingFor: async () => binding,
    authorize, currentPosition: async () => position, distributionReady: async () => distributed,
  });
  async function call(action: string, fields: Record<string, unknown> = {}) {
    return routes[0]!.handle(new Request(`https://khala.example${DEVICE_ADMISSION_PATH}`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        action, operationId, roomId, deviceId: 'new_A', matrixAccessToken: 'valid-token-123456789', ...fields,
      }) }));
  }
  return { call, fence, ledger,
    setSigned: (value: boolean) => { signed = value; },
    setOrigin: (value: boolean) => { originAllowed = value; },
    setBinding: (value: typeof binding) => { binding = value; },
    setTokenKey: (value: string) => { tokenKey = value; },
    setConsent: (value: boolean) => { consent = value; },
    setPosition: (value: number | null) => { position = value; },
    setDistributed: (value: boolean) => { distributed = value; } };
}

describe('owner replacement operation route', () => {
  it('refuses unauthenticated, wrong Origin, device, owner, channel, key and stale generation bindings', async () => {
    const h = setup();
    h.setSigned(false);
    expect((await h.call('reserve')).status).toBe(401);
    h.setSigned(true);
    h.setOrigin(false);
    expect((await h.call('reserve')).status).toBe(403);
    h.setOrigin(true);
    expect((await h.call('reserve', { deviceId: 'other' })).status).toBe(403);
    h.setBinding({ ownerId: 'other' as OwnerId, roomId, deviceId: 'new_A', deviceKey,
      generation: 2, policyDigest: 'd'.repeat(64) });
    expect((await h.call('reserve')).status).toBe(403);
    h.setBinding({ ownerId, roomId: '!other:example' as RoomId, deviceId: 'new_A', deviceKey,
      generation: 2, policyDigest: 'd'.repeat(64) });
    expect((await h.call('reserve')).status).toBe(403);
    h.setBinding({ ownerId, roomId, deviceId: 'new_A', deviceKey, generation: 2,
      policyDigest: 'd'.repeat(64) });
    h.setTokenKey('D'.repeat(43));
    expect((await h.call('reserve')).status).toBe(403);
    h.setTokenKey(deviceKey);
    h.setBinding({ ownerId, roomId, deviceId: 'new_A', deviceKey, generation: -1,
      policyDigest: 'd'.repeat(64) });
    expect((await h.call('reserve')).status).toBe(403);
    expect((await h.ledger.inspect(roomId)).value?.devices).toEqual([]);
  });

  it('requires consent and a trusted cutoff; retries remain pinned and content stays withheld', async () => {
    const h = setup();
    const sender = { senderId: 'owner_A', deviceId: 'old_A', deviceKey: 'A'.repeat(43) };
    expect(await h.fence.readySender(roomId, sender)).toBe('applied');
    expect(await h.fence.seedRoster(roomId, [sender])).toBe('applied');
    h.setConsent(false);
    expect((await h.call('reserve')).status).toBe(403);
    h.setConsent(true);
    h.setPosition(null);
    expect((await h.call('reserve')).status).toBe(503);
    h.setPosition(10);
    expect((await h.call('reserve')).status).toBe(202);
    expect((await h.call('reserve')).status).toBe(202);
    expect((await h.call('reserve', { operationId: 'replacement_2' })).status).toBe(409);
    h.setBinding({ ownerId, roomId, deviceId: 'new_A', deviceKey, generation: 1,
      policyDigest: 'd'.repeat(64) });
    expect((await h.call('reserve')).status).toBe(409);
    h.setBinding({ ownerId, roomId, deviceId: 'new_A', deviceKey, generation: 2,
      policyDigest: 'e'.repeat(64) });
    expect((await h.call('reserve')).status).toBe(409);
    h.setBinding({ ownerId, roomId, deviceId: 'new_A', deviceKey, generation: 2,
      policyDigest: 'd'.repeat(64) });
    const replacement: Replacement = { ownerId, roomId, deviceId: 'new_A', deviceKey, generation: 2,
      policyDigest: 'd'.repeat(64), operationId };
    expect(await h.ledger.allows({ ...replacement, position: 11 })).toBe(false);
    expect((await h.call('activate')).status).toBe(202);
    expect(await h.fence.acknowledgeRotation(roomId, sender, operationId, 1)).toBe('applied');
    expect((await h.call('activate')).status).toBe(202);
    h.setDistributed(true);
    expect((await h.call('activate')).status).toBe(200);
    expect(await h.ledger.allows({ ...replacement, position: 10 })).toBe(false);
    expect(await h.ledger.allows({ ...replacement, position: 11 })).toBe(true);
    h.setConsent(false);
    expect((await h.call('revoke')).status).toBe(403);
  });
});
