import { describe, expect, it } from 'vitest';
import type { OwnerId } from '@khala/contracts/messaging/index';
import type { RoomJournal } from '@khala/messaging/rooms/index';
import { createBrowserRoomJournal } from './room-journal';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    values,
  };
}

const locks = {
  async request<T>(_name: string, _options: { mode: 'exclusive' }, callback: () => T | PromiseLike<T>): Promise<T> {
    return await callback();
  },
};

const alice = 'owner_alice' as OwnerId;
const pending: Parameters<RoomJournal['claim']>[1] = {
  type: 'create', ownerId: alice, title: 'Planning', state: 'attempting', leaseUntilMs: 123, room: null,
};

describe('createBrowserRoomJournal', () => {
  it('persists claims across journal instances and compares revisions', async () => {
    const storage = memoryStorage();
    let sequence = 0;
    const options = { storage, locks, newRevision: () => `revision_${++sequence}` };
    const first = createBrowserRoomJournal(alice, options);
    const second = createBrowserRoomJournal(alice, options);

    expect(await first.claim('room.create:operation_1', pending)).toEqual({ kind: 'claimed', revision: 'revision_1' });
    expect(await second.read('room.create:operation_1')).toEqual({ kind: 'record', value: pending, revision: 'revision_1' });
    expect(await second.claim('room.create:operation_1', pending)).toEqual({ kind: 'exists', value: pending, revision: 'revision_1' });
    expect(await first.replace('room.create:operation_1', 'stale', pending)).toEqual({ kind: 'conflict' });
    expect(await first.replace('room.create:operation_1', 'revision_1', { ...pending, state: 'unknown', leaseUntilMs: null }))
      .toEqual({ kind: 'stored', revision: 'revision_2' });
  });

  it('keeps different owners in separate storage keys', async () => {
    const storage = memoryStorage();
    const options = { storage, locks, newRevision: () => 'revision' };
    const bob = createBrowserRoomJournal('owner_bob' as OwnerId, options);
    await createBrowserRoomJournal(alice, options).claim('same-operation', pending);

    expect(await bob.read('same-operation')).toEqual({ kind: 'absent' });
  });

  it('fails closed when persistence, locking, or stored data is unavailable', async () => {
    expect(await createBrowserRoomJournal(alice, { storage: null, locks }).read('operation')).toEqual({ kind: 'unavailable' });
    expect(await createBrowserRoomJournal(alice, { storage: memoryStorage(), locks: null }).claim('operation', pending))
      .toEqual({ kind: 'unavailable' });

    const storage = memoryStorage();
    storage.setItem(`khala.room-journal.v1:${encodeURIComponent(alice)}:operation`, '{not-json');
    expect(await createBrowserRoomJournal(alice, { storage, locks }).read('operation')).toEqual({ kind: 'unavailable' });
  });
});
