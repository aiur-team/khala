import { describe, expect, it } from 'vitest';
import type { OwnerId, RoomId } from '@khala/contracts/messaging/index';
import { fakeStore, T0 } from '../auth/support.test';
import { createOwnerCleanupRequests } from './cleanup-requests';

const ownerId = 'cleanup_owner' as OwnerId;
const request = { operationId: 'close_cleanup_1', ownerId, roomId: '!cleanup:example' as RoomId, expectedRoomRevision: 0 };

describe('durable owner browser cleanup requests', () => {
  it('survives offline readers and preserves the exact request across retries', async () => {
    const state = fakeStore(() => T0);
    const writer = createOwnerCleanupRequests(state.store, ownerId);
    expect(await writer.record(request)).toBe('requested');
    const restartedBrowser = createOwnerCleanupRequests(state.store, ownerId);
    expect(await restartedBrowser.list()).toEqual({ kind: 'ok', requests: [request] });
    expect(await writer.record(request)).toBe('requested');
    expect(await writer.record({ ...request, operationId: 'close_cleanup_2' })).toBe('unavailable');
    expect(await writer.record({ ...request, roomId: '!other:example' as RoomId })).toBe('unavailable');
    expect(await writer.record({ ...request, expectedRoomRevision: 1 })).toBe('unavailable');
    expect(await createOwnerCleanupRequests(state.store, 'another_owner' as OwnerId).list())
      .toEqual({ kind: 'ok', requests: [] });
    expect(await createOwnerCleanupRequests(state.store, 'another_owner' as OwnerId).record(request)).toBe('unavailable');
  });

  it('does not report requested for a failed store write and verifies a lost response', async () => {
    const state = fakeStore(() => T0);
    const requests = createOwnerCleanupRequests(state.store, ownerId);
    state.inject('compareAndSet', 'unavailable');
    expect(await requests.record(request)).toBe('unavailable');
    expect(await requests.list()).toEqual({ kind: 'ok', requests: [] });
    state.inject('compareAndSet', 'lose_response');
    expect(await requests.record(request)).toBe('requested');
  });
});
