import { describe, expect, it } from 'vitest';
import type { CompareAndSetInput, ControlStore, JsonValue, RoomId } from '@khala/contracts/messaging/index';
import { fakeStore, T0 } from '../../auth/support.test';
import { createDeviceAdmission, type Replacement } from './device-admission';
import { createRoomSendFence } from './room-send-fence';

const roomId = '!replacement:example' as RoomId;
const sender = { senderId: 'owner_A', deviceId: 'old_A', deviceKey: 'A'.repeat(43) };
const other = { senderId: 'owner_B', deviceId: 'old_B', deviceKey: 'B'.repeat(43) };
const replacement: Replacement = { roomId, ownerId: 'owner_A' as Replacement['ownerId'], deviceId: 'new_A',
  deviceKey: 'C'.repeat(43), generation: 2, policyDigest: 'd'.repeat(64), operationId: 'replacement_1' };

async function setup() {
  const raw = fakeStore(() => T0).store;
  let failRelease: 'rotated' | 'refused' | null = null;
  const store: ControlStore = { ...raw,
    async compareAndSet<T extends JsonValue>(write: CompareAndSetInput<T>) {
      const value = write.next.value;
      if (failRelease && write.key.startsWith('room-send-fence.v1.')
        && typeof value === 'object' && value !== null && !Array.isArray(value)
        && 'settled' in value && value.settled !== null && typeof value.settled === 'object'
        && !Array.isArray(value.settled)
        && (value.settled as Record<string, JsonValue>).kind === failRelease) return { kind: 'unavailable' as const };
      return raw.compareAndSet(write);
    } };
  const fence = createRoomSendFence(store);
  await fence.readySender(roomId, sender);
  await fence.readySender(roomId, other);
  await fence.seedRoster(roomId, [sender, other]);
  let authorized = true;
  let distributed = false;
  let position: number | null = 10;
  const deps = { store,
    authorize: async () => authorized ? 'authorized' as const : 'refused' as const,
    currentPosition: async () => position,
    distributionReady: async () => distributed };
  return { ledger: createDeviceAdmission(deps), restart: () => createDeviceAdmission(deps), fence,
    setAuthorized(value: boolean) { authorized = value; }, setDistributed(value: boolean) { distributed = value; },
    setPosition(value: number | null) { position = value; },
    setFailRelease(value: 'rotated' | 'refused' | null) { failRelease = value; } };
}

describe('replacement device admission boundary', () => {
  it('keeps content withheld until all senders rotate and verified distribution completes', async () => {
    const h = await setup();
    expect(await h.ledger.reserve(replacement)).toBe('pending');
    expect(await h.ledger.allows({ ...replacement, position: 11 })).toBe(false);
    expect(await h.ledger.activate(replacement)).toBe('pending');
    expect(await h.fence.acknowledgeRotation(roomId, sender, replacement.operationId, 1)).toBe('applied');
    expect(await h.ledger.activate(replacement)).toBe('pending');
    expect(await h.fence.acknowledgeRotation(roomId, other, replacement.operationId, 1)).toBe('applied');
    expect(await h.ledger.activate(replacement)).toBe('pending');
    h.setDistributed(true);
    expect(await h.ledger.activate({ ...replacement, deviceKey: 'D'.repeat(43) })).toBe('conflict');
    h.setAuthorized(false);
    expect(await h.ledger.activate(replacement)).toBe('refused');
    h.setAuthorized(true);
    expect(await h.restart().activate(replacement)).toBe('applied');
    expect(await h.restart().allows({ ...replacement, position: 10 })).toBe(false);
    expect(await h.restart().allows({ ...replacement, position: 11 })).toBe(true);
    expect(await h.restart().allows({ ...replacement, position: 100, deviceKey: 'D'.repeat(43) })).toBe(false);
    expect(await h.restart().allows({ ...replacement, position: 100, generation: 1 })).toBe(false);
    expect(await h.restart().allows({ ...replacement, position: 100, ownerId: 'owner_B' as Replacement['ownerId'] })).toBe(false);
  });

  it('pins operation, owner, channel, device, key and policy through retries and revocation', async () => {
    const h = await setup();
    expect(await h.ledger.reserve(replacement)).toBe('pending');
    expect(await h.restart().reserve(replacement)).toBe('pending');
    for (const changed of [
      { ...replacement, ownerId: 'owner_B' as Replacement['ownerId'] },
      { ...replacement, deviceId: 'new_B' },
      { ...replacement, deviceKey: 'D'.repeat(43) },
      { ...replacement, generation: 3 },
      { ...replacement, policyDigest: 'e'.repeat(64) },
      { ...replacement, roomId: '!other:example' as RoomId },
    ]) expect(await h.ledger.reserve(changed)).toBe('conflict');
    expect(await h.ledger.reserve({ ...replacement, operationId: 'replacement_2' })).toBe('conflict');
    expect(await h.ledger.revoke(replacement)).toBe('applied');
    expect(await h.fence.acquire(roomId, sender, 'after_cancellation')).toMatchObject({ kind: 'granted' });
    expect(await h.restart().revoke(replacement)).toBe('applied');
    expect(await h.restart().reserve(replacement)).toBe('conflict');
    expect(await h.restart().allows({ ...replacement, position: 100 })).toBe(false);
  });

  it('withholds reads if the send hold release fails after activation is prepared', async () => {
    const h = await setup();
    expect(await h.ledger.reserve(replacement)).toBe('pending');
    await h.fence.acknowledgeRotation(roomId, sender, replacement.operationId, 1);
    await h.fence.acknowledgeRotation(roomId, other, replacement.operationId, 1);
    h.setDistributed(true);
    h.setFailRelease('rotated');
    expect(await h.ledger.activate(replacement)).toBe('pending');
    expect(await h.restart().allows({ ...replacement, position: 11 })).toBe(false);
    expect(await h.restart().revoke(replacement)).toBe('refused');
    h.setFailRelease(null);
    expect(await h.restart().activate(replacement)).toBe('applied');
    expect(await h.restart().allows({ ...replacement, position: 11 })).toBe(true);
  });

  it('refuses ledger-only revocation once an admitted device can retain room keys', async () => {
    const h = await setup();
    await h.ledger.reserve(replacement);
    await h.fence.acknowledgeRotation(roomId, sender, replacement.operationId, 1);
    await h.fence.acknowledgeRotation(roomId, other, replacement.operationId, 1);
    h.setDistributed(true);
    expect(await h.ledger.activate(replacement)).toBe('applied');
    expect(await h.restart().revoke(replacement)).toBe('refused');
    expect(await h.restart().allows({ ...replacement, position: 11 })).toBe(true);
  });

  it('withholds active-device reads during a later hold and until a new sender is rotation-ready', async () => {
    const h = await setup();
    await h.ledger.reserve(replacement);
    await h.fence.acknowledgeRotation(roomId, sender, replacement.operationId, 1);
    await h.fence.acknowledgeRotation(roomId, other, replacement.operationId, 1);
    h.setDistributed(true);
    expect(await h.ledger.activate(replacement)).toBe('applied');
    expect(await h.restart().allows({ ...replacement, position: 11 })).toBe(true);

    expect(await h.fence.beginHold(roomId, 'later_rotation', null)).toBe('held');
    expect(await h.restart().allows({ ...replacement, position: 11 })).toBe(false);
    await h.fence.acknowledgeRotation(roomId, sender, 'later_rotation', 2);
    await h.fence.acknowledgeRotation(roomId, other, 'later_rotation', 2);
    expect(await h.restart().allows({ ...replacement, position: 11 })).toBe(false);
    expect(await h.fence.releaseHold(roomId, 'later_rotation', 'rotated')).toBe('applied');
    expect(await h.restart().allows({ ...replacement, position: 11 })).toBe(true);

    const added = { senderId: 'owner_C', deviceId: 'old_C', deviceKey: 'D'.repeat(43) };
    expect(await h.fence.seedRoster(roomId, [sender, other, added])).toBe('applied');
    expect(await h.restart().allows({ ...replacement, position: 11 })).toBe(false);
    expect(await h.fence.readySender(roomId, added)).toBe('applied');
    expect(await h.restart().allows({ ...replacement, position: 11 })).toBe(true);
  });

  it('retries a failed pending-cancellation release after restart before reporting success', async () => {
    const h = await setup();
    expect(await h.ledger.reserve(replacement)).toBe('pending');
    h.setFailRelease('refused');
    expect(await h.ledger.revoke(replacement)).toBe('pending');
    expect(await h.fence.acquire(roomId, sender, 'still_held')).toMatchObject({ kind: 'held' });
    expect(await h.restart().revoke(replacement)).toBe('pending');
    h.setFailRelease(null);
    expect(await h.restart().revoke(replacement)).toBe('applied');
    expect(await h.fence.acquire(roomId, sender, 'after_retry')).toMatchObject({ kind: 'granted' });
    expect(await h.restart().reserve(replacement)).toBe('conflict');
  });

  it('requires current owner authority before cancelling a pending replacement', async () => {
    const h = await setup();
    expect(await h.ledger.reserve(replacement)).toBe('pending');
    h.setAuthorized(false);
    expect(await h.ledger.revoke(replacement)).toBe('refused');
    expect(await h.restart().inspect(roomId)).toMatchObject({
      kind: 'found', value: { devices: [{ state: 'pending' }] },
    });
    expect(await h.fence.acquire(roomId, sender, 'still_pending')).toMatchObject({ kind: 'held' });
    h.setAuthorized(true);
    expect(await h.ledger.revoke(replacement)).toBe('applied');
  });

  it('leaves a partially rotated cancelled reservation fenced for key cleanup', async () => {
    const h = await setup();
    await h.ledger.reserve(replacement);
    await h.fence.acknowledgeRotation(roomId, sender, replacement.operationId, 1);
    expect(await h.ledger.revoke(replacement)).toBe('pending');
    expect(await h.restart().revoke(replacement)).toBe('pending');
    expect(await h.fence.acquire(roomId, other, 'unsafe_release')).toMatchObject({ kind: 'held' });
    expect(await h.fence.releaseHold(roomId, replacement.operationId, 'refused')).toBe('unavailable');
  });

  it('refuses absent authority or an unavailable cutoff without granting reads', async () => {
    const h = await setup();
    h.setAuthorized(false);
    expect(await h.ledger.reserve(replacement)).toBe('refused');
    expect(await h.ledger.allows({ ...replacement, position: 11 })).toBe(false);
    h.setAuthorized(true);
    h.setPosition(null);
    expect(await h.ledger.reserve(replacement)).toBe('unavailable');
    expect(await h.ledger.allows({ ...replacement, position: 11 })).toBe(false);
  });
});
