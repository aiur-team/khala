import { describe, expect, it } from 'vitest';
import type { RoomId } from '@khala/contracts/messaging/index';
import { fakeStore, T0 } from '../../auth/support.test';
import { createRoomSendFence } from './room-send-fence';

const roomId = '!fence:example' as RoomId;
const sender = { senderId: 'owner_device_A', deviceId: 'device_A', deviceKey: 'A'.repeat(43) };
const excludedKey = 'B'.repeat(43);

describe('durable room send fence', () => {
  it('holds a room before revocation protocol work and waits for the active send result', async () => {
    const fence = createRoomSendFence(fakeStore(() => T0).store);
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
});
