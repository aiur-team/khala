import { describe, expect, it } from 'vitest';
import type { CompareAndSetInput, ControlStore, JsonValue, RoomId } from '@khala/contracts/messaging/index';
import { fakeStore, T0 } from '../../auth/support.test';
import { createRoomSendFence } from './room-send-fence';

const roomId = '!fence:example' as RoomId;
const sender = { senderId: 'owner_device_A', deviceId: 'device_A', deviceKey: 'A'.repeat(43) };
const excludedKey = 'B'.repeat(43);

describe('durable room send fence', () => {
  it('resolves a completed transaction without granting another send, even during a hold', async () => {
    const store = fakeStore(() => T0).store;
    const fence = createRoomSendFence(store);
    expect(await fence.readySender(roomId, sender)).toBe('applied');
    expect(await fence.seedRoster(roomId, [sender])).toBe('applied');
    const first = await fence.acquire(roomId, sender, 'txn_completed');
    if (first.kind !== 'granted') throw new Error('permit not granted');
    expect(await fence.finish(roomId, sender.senderId, first.permitId,
      { kind: 'complete', eventId: '$sent:example' })).toBe('applied');
    const restarted = createRoomSendFence(store);
    expect(await restarted.acquire(roomId, sender, 'txn_completed'))
      .toEqual({ kind: 'complete', eventId: '$sent:example' });
    expect(await restarted.beginHold(roomId, 'operation_after_send', excludedKey)).toBe('held');
    expect(await restarted.acquire(roomId, sender, 'txn_completed'))
      .toEqual({ kind: 'complete', eventId: '$sent:example' });
    expect(await restarted.acquire(roomId, sender, 'txn_new')).toMatchObject({ kind: 'held' });
  });
  it('refuses admission against an empty sender snapshot', async () => {
    const fence = createRoomSendFence(fakeStore(() => T0).store);
    expect(await fence.seedRoster(roomId, [])).toBe('applied');
    expect(await fence.beginHold(roomId, 'replacement_empty', null)).toBe('unavailable');
  });
  it('holds replacement admission until every verified sender rotates, including the former device', async () => {
    const store = fakeStore(() => T0).store;
    const fence = createRoomSendFence(store);
    const other = { senderId: 'agent_device_B', deviceId: 'device_B', deviceKey: 'C'.repeat(43) };
    await fence.readySender(roomId, sender);
    await fence.readySender(roomId, other);
    await fence.seedRoster(roomId, [sender, other]);
    expect(await fence.beginHold(roomId, 'replacement_1', null)).toBe('held');
    expect(await fence.acquire(roomId, sender, 'after_admission')).toMatchObject({ kind: 'held' });
    expect(await fence.acknowledgeRotation(roomId, sender, 'replacement_1', 1)).toBe('applied');
    expect(await fence.rotationStatus(roomId, 'replacement_1')).toBe('pending');
    expect(await fence.releaseHold(roomId, 'replacement_1', 'rotated')).toBe('unavailable');
    const restarted = createRoomSendFence(store);
    expect(await restarted.acknowledgeRotation(roomId, other, 'replacement_1', 1)).toBe('applied');
    expect(await restarted.rotationStatus(roomId, 'replacement_1')).toBe('rotated');
    expect(await restarted.releaseHold(roomId, 'replacement_1', 'rotated')).toBe('applied');
    expect(await restarted.acquire(roomId, sender, 'after_admission')).toMatchObject({ kind: 'granted' });
  });
  it('keeps a post-admission human transaction unsent until two active agent senders rotate', async () => {
    const fence = createRoomSendFence(fakeStore(() => T0).store);
    const codex = { senderId: 'codex_device', deviceId: 'CODEX', deviceKey: 'C'.repeat(43) };
    const claude = { senderId: 'claude_device', deviceId: 'CLAUDE', deviceKey: 'D'.repeat(43) };
    for (const device of [sender, codex, claude]) expect(await fence.readySender(roomId, device)).toBe('applied');
    expect(await fence.seedRoster(roomId, [sender, codex, claude])).toBe('applied');

    expect(await fence.beginHold(roomId, 'admit_agent', null)).toBe('held');
    expect(await fence.acquire(roomId, sender, 'txn_canary')).toEqual({
      kind: 'held', epoch: 1, operationId: 'admit_agent',
    });
    expect(await fence.acknowledgeRotation(roomId, sender, 'admit_agent', 1)).toBe('applied');
    expect(await fence.acknowledgeRotation(roomId, codex, 'admit_agent', 1)).toBe('applied');
    expect(await fence.rotationStatus(roomId, 'admit_agent')).toBe('pending');
    expect(await fence.acquire(roomId, sender, 'txn_canary')).toMatchObject({ kind: 'held' });
    expect(await fence.acknowledgeRotation(roomId, claude, 'admit_agent', 1)).toBe('applied');
    expect(await fence.releaseHold(roomId, 'admit_agent', 'rotated')).toBe('applied');

    const permitted = await fence.acquire(roomId, sender, 'txn_canary');
    expect(permitted.kind).toBe('granted');
    if (permitted.kind !== 'granted') return;
    expect(await fence.finish(roomId, sender.senderId, permitted.permitId,
      { kind: 'complete', eventId: '$canary:example' })).toBe('applied');
    expect(await fence.acquire(roomId, sender, 'txn_canary')).toEqual({
      kind: 'complete', eventId: '$canary:example',
    });
  });
  it('refuses revocation protocol admission until a trusted legacy sender inventory is seeded', async () => {
    const fence = createRoomSendFence(fakeStore(() => T0).store);
    expect(await fence.beginHold(roomId, 'operation_unseeded', excludedKey)).toBe('unavailable');
    expect(await fence.acquire(roomId, sender, 'txn_unregistered')).toMatchObject({ kind: 'held',
      operationId: 'rotation_required' });
  });
  it('holds a room before revocation protocol work and waits for the active send result', async () => {
    const fence = createRoomSendFence(fakeStore(() => T0).store);
    expect(await fence.readySender(roomId, sender)).toBe('applied');
    expect(await fence.seedRoster(roomId, [sender])).toBe('applied');
    const sent = await fence.acquire(roomId, sender, 'txn_1');
    expect(sent.kind).toBe('granted');
    if (sent.kind !== 'granted') return;
    expect(await fence.beginHold(roomId, 'operation_1', excludedKey)).toBe('held');
    expect(await fence.acquire(roomId, sender, 'txn_2')).toMatchObject({ kind: 'held' });
    expect(await fence.drained(roomId, 'operation_1')).toBe('pending');
    expect(await fence.finish(roomId, sender.senderId, sent.permitId, { kind: 'unknown' })).toBe('applied');
    expect(await fence.drained(roomId, 'operation_1')).toBe('pending');
    expect(await fence.acquire(roomId, sender, 'txn_1')).toMatchObject({ kind: 'granted', permitId: sent.permitId });
    expect(await fence.finish(roomId, sender.senderId, sent.permitId,
      { kind: 'complete', eventId: '$sent:example' })).toBe('applied');
    expect(await fence.drained(roomId, 'operation_1')).toBe('drained');
  });

  it('serializes a racing acquire and hold and rejects wrong sender completion', async () => {
    const fence = createRoomSendFence(fakeStore(() => T0).store);
    expect(await fence.readySender(roomId, sender)).toBe('applied');
    expect(await fence.seedRoster(roomId, [sender])).toBe('applied');
    const [acquired, held] = await Promise.all([
      fence.acquire(roomId, sender, 'txn_1'),
      fence.beginHold(roomId, 'operation_1', excludedKey),
    ]);
    expect(held).toBe('held');
    expect(await fence.acquire(roomId, sender, 'txn_2')).toMatchObject({ kind: 'held' });
    if (acquired.kind === 'granted') {
      expect(await fence.finish(roomId, 'wrong_sender', acquired.permitId,
        { kind: 'complete', eventId: '$wrong:example' })).toBe('unavailable');
      expect(await fence.drained(roomId, 'operation_1')).toBe('pending');
      expect(await fence.finish(roomId, sender.senderId, acquired.permitId,
        { kind: 'complete', eventId: '$right:example' })).toBe('applied');
      expect(await fence.drained(roomId, 'operation_1')).toBe('drained');
    } else {
      expect(acquired.kind).toBe('held');
      expect(await fence.drained(roomId, 'operation_1')).toBe('drained');
    }
  });

  it('requires a receipt from every registered surviving sender before releasing the hold', async () => {
    const fence = createRoomSendFence(fakeStore(() => T0).store);
    const second = { senderId: 'agent_device_B', deviceId: 'device_B', deviceKey: 'C'.repeat(43) };
    await fence.readySender(roomId, sender);
    await fence.readySender(roomId, second);
    await fence.seedRoster(roomId, [sender, second]);
    expect(await fence.beginHold(roomId, 'operation_2', excludedKey)).toBe('held');
    expect(await fence.rotationStatus(roomId, 'operation_2')).toBe('pending');
    expect(await fence.acknowledgeRotation(roomId, { ...sender, deviceKey: excludedKey }, 'operation_2', 1))
      .toBe('unavailable');
    expect(await fence.acknowledgeRotation(roomId, sender, 'operation_2', 1)).toBe('applied');
    expect(await fence.rotationStatus(roomId, 'operation_2')).toBe('pending');
    expect(await fence.releaseHold(roomId, 'operation_2', 'rotated')).toBe('unavailable');
    expect(await fence.acknowledgeRotation(roomId, second, 'operation_2', 1)).toBe('applied');
    expect(await fence.releaseHold(roomId, 'operation_2', 'rotated')).toBe('applied');
    expect(await fence.rotationStatus(roomId, 'operation_2')).toBe('rotated');
    expect(await fence.acquire(roomId, sender, 'txn_after_rotate')).toMatchObject({ kind: 'granted' });
  });

  it('drains a permit cancelled before invoking the SDK without treating an unknown send as cancelled', async () => {
    const fence = createRoomSendFence(fakeStore(() => T0).store);
    await fence.readySender(roomId, sender);
    await fence.seedRoster(roomId, [sender]);
    const first = await fence.acquire(roomId, sender, 'txn_cancel');
    if (first.kind !== 'granted') throw new Error('permit not granted');
    expect(await fence.finish(roomId, sender.senderId, first.permitId, { kind: 'cancelled' })).toBe('applied');
    expect(await fence.beginHold(roomId, 'operation_cancel', excludedKey)).toBe('held');
    expect(await fence.drained(roomId, 'operation_cancel')).toBe('drained');
    expect(await fence.finish(roomId, sender.senderId, first.permitId, { kind: 'unknown' })).toBe('unavailable');
  });

  it('reacquires a durably cancelled unsent permit for the same transaction until a hold begins', async () => {
    const store = fakeStore(() => T0).store;
    const fence = createRoomSendFence(store);
    await fence.readySender(roomId, sender);
    await fence.seedRoster(roomId, [sender]);
    const first = await fence.acquire(roomId, sender, 'txn_retry');
    if (first.kind !== 'granted') throw new Error('permit not granted');
    expect(await fence.finish(roomId, sender.senderId, first.permitId, { kind: 'cancelled' })).toBe('applied');
    const restarted = createRoomSendFence(store);
    const retried = await restarted.acquire(roomId, sender, 'txn_retry', true);
    expect(retried).toMatchObject({ kind: 'granted', permitId: first.permitId, attempt: 1 });
    if (retried.kind !== 'granted') throw new Error('retry permit not granted');
    expect(await restarted.finish(roomId, sender.senderId, first.permitId,
      { kind: 'cancelled' }, first.attempt)).toBe('unavailable');
    expect(await restarted.beginHold(roomId, 'operation_retry', excludedKey)).toBe('held');
    expect(await restarted.drained(roomId, 'operation_retry')).toBe('pending');
    expect(await restarted.finish(roomId, sender.senderId, first.permitId,
      { kind: 'cancelled' }, retried.attempt)).toBe('applied');
    expect(await restarted.drained(roomId, 'operation_retry')).toBe('drained');
    expect(await restarted.acquire(roomId, sender, 'txn_retry', true)).toMatchObject({ kind: 'held' });
  });

  it('recovers the stored attempt after the permit write succeeds but the room write fails', async () => {
    const backing = fakeStore(() => T0);
    let failRoomSave = false;
    const store: ControlStore = { ...backing.store, async compareAndSet<T extends JsonValue>(input: CompareAndSetInput<T>) {
      if (failRoomSave && input.key.startsWith('room-send-fence.v1.')) {
        failRoomSave = false;
        return { kind: 'unavailable' as const };
      }
      return backing.store.compareAndSet(input);
    } };
    const fence = createRoomSendFence(store);
    expect(await fence.readySender(roomId, sender)).toBe('applied');
    expect(await fence.seedRoster(roomId, [sender])).toBe('applied');
    failRoomSave = true;
    expect(await fence.acquire(roomId, sender, 'txn_orphaned')).toEqual({ kind: 'unavailable' });
    expect((await fence.inspect(roomId)).kind).toBe('found');
    const restarted = createRoomSendFence(store);
    const retried = await restarted.acquire(roomId, sender, 'txn_orphaned');
    expect(retried).toMatchObject({ kind: 'granted', attempt: 0 });
    if (retried.kind !== 'granted') throw new Error('permit recovery failed');
    expect(await restarted.beginHold(roomId, 'operation_orphaned', excludedKey)).toBe('held');
    expect(await restarted.drained(roomId, 'operation_orphaned')).toBe('pending');
    expect(await restarted.finish(roomId, sender.senderId, retried.permitId,
      { kind: 'cancelled' }, retried.attempt)).toBe('applied');
    expect(await restarted.drained(roomId, 'operation_orphaned')).toBe('drained');
  });

  it('uses the current verified Matrix sender snapshot while retaining no hidden legacy sender', async () => {
    const fence = createRoomSendFence(fakeStore(() => T0).store);
    const departed = { senderId: 'departed_device', deviceId: 'departed', deviceKey: 'D'.repeat(43) };
    await fence.readySender(roomId, sender);
    await fence.readySender(roomId, departed);
    expect(await fence.seedRoster(roomId, [sender])).toBe('applied');
    expect(await fence.beginHold(roomId, 'operation_snapshot', excludedKey)).toBe('held');
    expect(await fence.acknowledgeRotation(roomId, sender, 'operation_snapshot', 1)).toBe('applied');
    expect(await fence.rotationStatus(roomId, 'operation_snapshot')).toBe('rotated');
  });
});
