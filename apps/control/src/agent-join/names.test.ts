import { expect, it, vi } from 'vitest';
import { ownerAgentsKey } from '@khala/contracts/m1/names';
import type { OwnerId } from '@khala/contracts/messaging/index';
import { createControlStore } from '../runtime/control-store';
import { indexOwnerAgent } from './names';
import { durableStores } from './testing/store';

function fixture() {
  const { storeFor } = durableStores();
  return createControlStore({ records: storeFor('records'), operations: storeFor('operations'), clock: () => Date.parse('2026-10-01T12:00:00Z') });
}
const input = { ownerId: 'owner' as OwnerId, matrixUserId: '@agent:matrix.test', username: 'Kevin', harness: 'claude' as const };
it('serializes concurrent owner index additions without losing agents', async () => {
  const store = fixture();
  const second = { ...input, matrixUserId: '@second:matrix.test' };
  await Promise.all([indexOwnerAgent(store, input.ownerId, input.matrixUserId), indexOwnerAgent(store, input.ownerId, second.matrixUserId)]);
  await indexOwnerAgent(store, input.ownerId, input.matrixUserId);
  const index = await store.read(ownerAgentsKey(input.ownerId));
  expect(index.kind === 'record' && index.record.value).toEqual({ v: 1, ownerId: input.ownerId, agents: [input.matrixUserId, second.matrixUserId] });
});
it('bounds owner index retries and size', async () => {
  const store = fixture();
  vi.spyOn(store, 'compareAndSet').mockResolvedValue({ kind: 'conflict', current: null });
  await indexOwnerAgent(store, input.ownerId, input.matrixUserId);
  expect(store.compareAndSet).toHaveBeenCalledTimes(3);
  const full = fixture();
  const agents = Array.from({ length: 200 }, (_, n) => `@agent${n}:matrix.test`);
  await full.compareAndSet({ key: ownerAgentsKey(input.ownerId), expectedRevision: null, operationId: 'full',
    next: { value: { v: 1, ownerId: input.ownerId, agents }, expiresAt: null } });
  vi.spyOn(full, 'compareAndSet');
  await indexOwnerAgent(full, input.ownerId, input.matrixUserId);
  expect(full.compareAndSet).not.toHaveBeenCalled();
});
it('keeps index failures best effort and never overwrites corrupt or foreign records', async () => {
  for (const value of [{ v: 2 }, { v: 1, ownerId: 'other', agents: [] }]) {
    const store = fixture();
    await store.compareAndSet({ key: ownerAgentsKey(input.ownerId), expectedRevision: null, operationId: 'invalid', next: { value, expiresAt: null } });
    vi.spyOn(store, 'compareAndSet');
    await indexOwnerAgent(store, input.ownerId, input.matrixUserId);
    expect(store.compareAndSet).not.toHaveBeenCalled();
  }
  const store = fixture();
  vi.spyOn(store, 'compareAndSet').mockRejectedValue(Error('offline'));
  await expect(indexOwnerAgent(store, input.ownerId, input.matrixUserId)).resolves.toBeUndefined();
});
