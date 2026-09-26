import { describe, expect, it } from 'vitest';
import type { OwnerId, RoomId } from '@khala/contracts/messaging/index';
import { createPendingSendStore } from './pending-store';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

const content = (body: string) => ({ v: 1 as const, kind: 'text' as const, body });

describe('pending send store', () => {
  it('keeps only sends that may have landed, per owner and channel, across a reload', () => {
    const storage = memoryStorage();
    const first = createPendingSendStore('owner_1' as OwnerId, 'ch_1' as RoomId, storage);
    first.save([
      { clientTxnId: 'txn_a', content: content('a'), phase: 'outcome_unknown' },
      { clientTxnId: 'txn_b', content: content('b'), phase: 'accepted' },
      { clientTxnId: 'txn_c', content: content('c'), phase: 'failed' },
    ]);
    const reloaded = createPendingSendStore('owner_1' as OwnerId, 'ch_1' as RoomId, storage);
    // A failed send provably did not land, so only the unknown one keeps its identity.
    expect(reloaded.load().map(entry => entry.clientTxnId)).toEqual(['txn_a']);
    expect(createPendingSendStore('owner_1' as OwnerId, 'ch_2' as RoomId, storage).load()).toEqual([]);
    reloaded.save([]);
    expect(storage.values.size).toBe(0);
  });

  it('drops malformed entries and survives unavailable storage', () => {
    const storage = memoryStorage();
    const store = createPendingSendStore('owner_1' as OwnerId, 'ch_1' as RoomId, storage);
    storage.values.set([...storage.values.keys()][0] ?? 'khala.internal.pending.v1:owner_1:ch_1', JSON.stringify([
      { clientTxnId: 'txn_a', content: content('a'), phase: 'outcome_unknown' },
      { clientTxnId: 'txn_f', content: content('f'), phase: 'failed' },
      { clientTxnId: 'txn_b', content: { v: 2, kind: 'text', body: 'b' }, phase: 'pending' },
      { clientTxnId: '', content: content('c'), phase: 'pending' },
      { clientTxnId: 'txn_d', content: content('d'), phase: 'pending', extra: true },
    ]));
    expect(store.load().map(entry => entry.clientTxnId)).toEqual(['txn_a']);
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => undefined };
    const unavailable = createPendingSendStore('owner_1' as OwnerId, 'ch_1' as RoomId, broken);
    expect(unavailable.load()).toEqual([]);
    expect(() => unavailable.save([{ clientTxnId: 'x', content: content('x'), phase: 'failed' }])).not.toThrow();
  });
});
