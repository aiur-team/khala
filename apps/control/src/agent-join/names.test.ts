import { expect, it, vi } from 'vitest';
import { defaultAgentName, nameKey, ownerAgentsKey } from '@khala/contracts/m1/names';
import type { OwnerId } from '@khala/contracts/messaging/index';
import { createControlStore } from '../runtime/control-store';
import { allocateAgentName, indexOwnerAgent, retainAgentName } from './names';
import { durableStores } from './testing/store';

function fixture() {
  const { storeFor } = durableStores();
  return createControlStore({ records: storeFor('records'), operations: storeFor('operations'), clock: () => Date.parse('2026-10-01T12:00:00Z') });
}
const input = { ownerId: 'owner' as OwnerId, matrixUserId: '@agent:matrix.test', username: 'Kevin', harness: 'claude' as const };
it('allocates the base name, suffixes a second agent and reuses each on retry', async () => {
  const store = fixture();
  expect(await allocateAgentName(store, input)).toBe('Kevin-Claude');
  const second = { ...input, matrixUserId: '@second:matrix.test' };
  expect(await allocateAgentName(store, second)).toBe('Kevin-Claude-2');
  expect(await allocateAgentName(store, input)).toBe('Kevin-Claude');
  expect(await allocateAgentName(store, second)).toBe('Kevin-Claude-2');
});
it.each(['owner', 'other'])('does not reuse a human reservation, held by %s', async ownerId => {
  const store = fixture();
  await store.compareAndSet({ key: nameKey('kevin-claude'), expectedRevision: null, operationId: 'human-name',
    next: { value: { v: 1, kind: 'human', ownerId }, expiresAt: null } });
  expect(await allocateAgentName(store, input)).toBe('Kevin-Claude-2');
});
it('does not reuse a malformed agent reservation', async () => {
  const store = fixture();
  await store.compareAndSet({ key: nameKey('Kevin-Claude'), expectedRevision: null, operationId: 'malformed',
    next: { value: { kind: 'agent', matrixUserId: input.matrixUserId }, expiresAt: null } });
  expect(await allocateAgentName(store, input)).toBe('Kevin-Claude-2');
});
it('returns null when all 20 candidates are taken', async () => {
  const store = fixture();
  for (let n = 1; n <= 20; n++) await store.compareAndSet({ key: nameKey(defaultAgentName('Kevin', 'claude', n)),
    expectedRevision: null, operationId: `taken-${n}`, next: { value: { v: 1, kind: 'agent', ownerId: 'other', matrixUserId: `@other${n}:matrix.test` }, expiresAt: null } });
  expect(await allocateAgentName(store, input)).toBeNull();
  expect(await store.read(nameKey('Kevin-Claude-21'))).toEqual({ kind: 'absent' });
});
it('returns null on unavailable and ambiguous writes', async () => {
  for (const kind of ['unavailable', 'outcome_unknown'] as const) {
    const store = fixture();
    vi.spyOn(store, 'compareAndSet').mockResolvedValue({ kind, operationId: 'unknown' });
    vi.spyOn(store, 'resolve').mockResolvedValue({ kind: 'outcome_unknown', operationId: 'unknown' });
    expect(await allocateAgentName(store, input)).toBeNull();
  }
});
it('serializes concurrent claims and owner index additions without losing agents', async () => {
  const store = fixture();
  const second = { ...input, matrixUserId: '@second:matrix.test' };
  expect(new Set(await Promise.all([allocateAgentName(store, input), allocateAgentName(store, second)])))
    .toEqual(new Set(['Kevin-Claude', 'Kevin-Claude-2']));
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

it('promotes only the staged agent claim and fails closed on promotion writes', async () => {
  const store = fixture();
  const expiresAt = '2026-10-01T12:10:00.000Z';
  const name = await allocateAgentName(store, { ...input, expiresAt });
  expect(name).toBe('Kevin-Claude');
  expect(await retainAgentName(store, name!, 'other', input.matrixUserId)).toBe(false);
  const write = store.compareAndSet;
  vi.spyOn(store, 'compareAndSet').mockResolvedValueOnce({ kind: 'unavailable' });
  expect(await retainAgentName(store, name!, input.ownerId, input.matrixUserId)).toBe(false);
  const temporary = await store.read(nameKey(name!));
  expect(temporary.kind === 'record' && temporary.record.expiresAt).toBe(expiresAt);
  vi.mocked(store.compareAndSet).mockImplementation(write);
  expect(await retainAgentName(store, name!, input.ownerId, input.matrixUserId)).toBe(true);
  const permanent = await store.read(nameKey(name!));
  expect(permanent.kind === 'record' && permanent.record.expiresAt).toBeNull();
});
