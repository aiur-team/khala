import { describe, expect, it } from 'vitest';
import type { OwnerId, RoomId } from '@khala/contracts/messaging/ids';
import { createHumanPendingSendStore } from './pending-send-store';

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe('human pending-send store', () => {
  it('restores only the same owner and channel, then removes reconciled sends', () => {
    const disk = storage();
    const owner = 'owner_a' as OwnerId;
    const room = 'room_a' as RoomId;
    const entry = { clientTxnId: 'txn_123', content: { v: 1 as const, kind: 'text' as const, body: 'pending body' }, phase: 'pending' as const };
    createHumanPendingSendStore(owner, room, disk).save([entry]);
    expect(createHumanPendingSendStore(owner, room, disk).load()).toEqual([entry]);
    expect(createHumanPendingSendStore('owner_b' as OwnerId, room, disk).load()).toEqual([]);
    expect(createHumanPendingSendStore(owner, 'room_b' as RoomId, disk).load()).toEqual([]);
    createHumanPendingSendStore(owner, room, disk).save([]);
    expect(createHumanPendingSendStore(owner, room, disk).load()).toEqual([]);
  });

  it('discards malformed session data instead of rendering it as a message', () => {
    const disk = storage();
    const owner = 'owner_a' as OwnerId;
    const room = 'room_a' as RoomId;
    const key = `khala.pending-send.v1:${JSON.stringify([owner, room])}`;
    disk.setItem(key, '[{"clientTxnId":"txn_123","content":{"v":1,"kind":"text","body":"x"},"phase":"forged"}]');
    expect(createHumanPendingSendStore(owner, room, disk).load()).toEqual([]);
    expect(disk.getItem(key)).toBeNull();
  });
});
