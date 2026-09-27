import { describe, expect, it, vi } from 'vitest';
import type { OwnerId, RoomId } from '@khala/contracts/messaging/index';
import { createOwnerCleanupConsumer } from './cleanup-consumer';

const ownerId = 'cleanup_owner' as OwnerId;
const request = { operationId: 'close_cleanup_1', ownerId, roomId: '!cleanup:example' as RoomId, expectedRoomRevision: 0 };

describe('owner browser cleanup consumer', () => {
  it('discovers an offline device request at startup and retries a failed SDK forget', async () => {
    const cleanupRoom = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const requests = vi.fn(async () => [request]);
    const consumer = createOwnerCleanupConsumer({ ownerId: () => ownerId, requests, cleanupRoom, roomPresent: () => false });
    await consumer.poll();
    expect(cleanupRoom).toHaveBeenCalledTimes(1);
    await consumer.poll();
    expect(cleanupRoom).toHaveBeenCalledTimes(2);
    await consumer.poll();
    expect(cleanupRoom).toHaveBeenCalledTimes(2);
    consumer.dispose();
  });

  it('never processes another owner request or a response after the active owner changes', async () => {
    const cleanupRoom = vi.fn(async () => true);
    let activeOwner = ownerId;
    const requests = vi.fn(async () => [{ ...request, ownerId: 'peer_owner' as OwnerId }]);
    const consumer = createOwnerCleanupConsumer({ ownerId: () => activeOwner, requests, cleanupRoom, roomPresent: () => false });
    await consumer.poll();
    expect(cleanupRoom).not.toHaveBeenCalled();
    requests.mockImplementationOnce(async () => [request]);
    activeOwner = 'peer_owner' as OwnerId;
    await consumer.poll();
    expect(cleanupRoom).not.toHaveBeenCalled();
    consumer.dispose();
  });

  it('checks on startup and again when an offline browser becomes visible', async () => {
    const listeners = new Map<string, () => void>();
    vi.stubGlobal('document', { visibilityState: 'visible',
      addEventListener: (name: string, listener: () => void) => listeners.set(name, listener),
      removeEventListener: (name: string) => listeners.delete(name) });
    const cleanupRoom = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const consumer = createOwnerCleanupConsumer({ ownerId: () => ownerId, requests: async () => [request], cleanupRoom,
      roomPresent: () => false });
    consumer.start();
    await vi.waitFor(() => expect(cleanupRoom).toHaveBeenCalledTimes(1));
    listeners.get('visibilitychange')?.();
    await vi.waitFor(() => expect(cleanupRoom).toHaveBeenCalledTimes(2));
    consumer.dispose();
    expect(listeners.size).toBe(0);
    vi.unstubAllGlobals();
  });

  it('retries a successful forget if sync later restores the room, then stops once absent', async () => {
    let present = false;
    const cleanupRoom = vi.fn(async () => true);
    const consumer = createOwnerCleanupConsumer({ ownerId: () => ownerId, requests: async () => [request], cleanupRoom,
      roomPresent: () => present });
    await consumer.poll();
    expect(cleanupRoom).toHaveBeenCalledTimes(1);
    await consumer.poll();
    expect(cleanupRoom).toHaveBeenCalledTimes(1);
    present = true;
    await consumer.poll();
    expect(cleanupRoom).toHaveBeenCalledTimes(2);
    present = false;
    await consumer.poll();
    expect(cleanupRoom).toHaveBeenCalledTimes(2);
    consumer.dispose();
  });
});
