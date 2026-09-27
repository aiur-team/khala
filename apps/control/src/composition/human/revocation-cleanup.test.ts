import { describe, expect, it } from 'vitest';
import type { OwnerId, RoomId } from '@khala/contracts/messaging/index';
import { fakeStore, T0 } from '../../auth/support.test';
import { createRoomSendFence } from './room-send-fence';
import { createCleanupProtocolPort, createRevocationCleanupStore } from './revocation-cleanup';

const ownerId = 'owner_revoke' as OwnerId;
const roomId = '!cleanup:example' as RoomId;
const operationId = 'operation_cleanup';
const senderA = { senderId: 'owner_A', deviceId: 'owner_device', deviceKey: 'A'.repeat(43) };
const senderB = { senderId: 'agent_B', deviceId: 'agent_device', deviceKey: 'B'.repeat(43) };

async function setup() {
  const store = fakeStore(() => T0).store;
  const fence = createRoomSendFence(store);
  await fence.readySender(roomId, senderA);
  await fence.readySender(roomId, senderB);
  await fence.seedRoster(roomId, [senderA, senderB]);
  await fence.beginHold(roomId, operationId, senderB.deviceKey);
  const cleanup = createRevocationCleanupStore(store);
  expect(await cleanup.prepare({ ownerId, operationId, bindingId: 'binding_B', roomId,
    deviceId: senderB.deviceId, deviceKey: senderB.deviceKey, expectedGeneration: 2,
    revokedGeneration: 3, capabilityDigest: 'a'.repeat(43) })).toBe('applied');
  return { store, fence, cleanup, protocol: createCleanupProtocolPort(store, ownerId) };
}

describe('durable protocol receipt reconciliation', () => {
  it('returns unavailable until exact device removal and every surviving sender rotation is recorded', async () => {
    const h = await setup();
    const input = { operationId, deviceId: senderB.deviceId as never, deviceKey: senderB.deviceKey };
    expect(await h.protocol.removeDevice(input)).toEqual({ kind: 'unavailable' });
    expect(await h.cleanup.recordRemoval(ownerId, operationId, 'removed')).toBe('applied');
    expect(await h.protocol.removeDevice(input)).toEqual({ kind: 'removed' });
    expect(await h.protocol.rotateSessions(input)).toEqual({ kind: 'unavailable' });
    expect(await h.fence.acknowledgeRotation(roomId, senderA, operationId, 1)).toBe('applied');
    expect(await h.protocol.rotateSessions(input)).toEqual({ kind: 'rotated' });
    expect(await h.protocol.rotateSessions(input)).toEqual({ kind: 'rotated' });
    expect((await h.fence.acquire(roomId, senderA, 'txn_after')).kind).toBe('granted');
  });

  it('lifts the temporary protocol hold on a definite refusal while keeping exclusion partial', async () => {
    const h = await setup();
    const input = { operationId, deviceId: senderB.deviceId as never, deviceKey: senderB.deviceKey };
    await h.cleanup.recordRemoval(ownerId, operationId, 'reauthentication_required');
    expect(await h.protocol.removeDevice(input)).toEqual({ kind: 'refused', reason: 'reauthentication_required' });
    expect(await h.protocol.rotateSessions(input)).toEqual({ kind: 'unavailable' });
    expect((await h.fence.acquire(roomId, senderA, 'txn_after_refusal')).kind).toBe('granted');
  });

  it('uses an independently verified same-account UIA result before reporting removed', async () => {
    const h = await setup();
    const input = { operationId, deviceId: senderB.deviceId as never, deviceKey: senderB.deviceKey };
    await h.cleanup.recordRemoval(ownerId, operationId, 'reauthentication_required');
    let attempts = 0;
    const protocol = createCleanupProtocolPort(h.store, ownerId, {
      async remove(target) { attempts += 1; expect(target).toMatchObject({ bindingId: 'binding_B',
        deviceId: senderB.deviceId, deviceKey: senderB.deviceKey, expectedGeneration: 2, revokedGeneration: 3 });
        return 'outcome_unknown'; },
      async status() { return 'removed'; },
    });
    expect(await protocol.removeDevice(input)).toEqual({ kind: 'outcome_unknown' });
    expect(await protocol.deviceStatus(input)).toEqual({ kind: 'removed' });
    expect(await protocol.removeDevice(input)).toEqual({ kind: 'removed' });
    expect(attempts).toBe(1);
    expect((await h.fence.acquire(roomId, senderA, 'txn_still_held')).kind).toBe('held');
  });

  it('removes an offline endpoint through the control account while its endpoint receipt stays pending', async () => {
    const h = await setup();
    const input = { operationId, deviceId: senderB.deviceId as never, deviceKey: senderB.deviceKey };
    let attempts = 0;
    const protocol = createCleanupProtocolPort(h.store, ownerId, {
      async remove(target) {
        attempts += 1;
        expect(target).toMatchObject({ bindingId: 'binding_B', deviceId: senderB.deviceId,
          deviceKey: senderB.deviceKey, expectedGeneration: 2, revokedGeneration: 3 });
        return 'removed';
      },
      async status() { return 'removed'; },
    });
    expect((await h.cleanup.read(ownerId, operationId)).kind).toBe('record');
    expect(await protocol.removeDevice(input)).toEqual({ kind: 'removed' });
    expect(attempts).toBe(1);
    const pending = await h.cleanup.read(ownerId, operationId);
    expect(pending.kind).toBe('record');
    if (pending.kind === 'record') {
      expect(pending.value.removal).toBeNull();
      expect(pending.value.verifiedRemoval).toBe('removed');
    }
    expect(await protocol.rotateSessions(input)).toEqual({ kind: 'unavailable' });
    expect(await h.fence.acknowledgeRotation(roomId, senderA, operationId, 1)).toBe('applied');
    expect(await protocol.rotateSessions(input)).toEqual({ kind: 'rotated' });
  });
});
