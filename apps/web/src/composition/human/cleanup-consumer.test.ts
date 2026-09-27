import { describe, expect, it, vi } from 'vitest';
import type { OwnerId, RoomId } from '@khala/contracts/messaging/index';
import { createOwnerCleanupConsumer } from './cleanup-consumer';

const ownerId = 'cleanup_owner' as OwnerId;
const request = { operationId: 'close_cleanup_1', ownerId, roomId: '!cleanup:example' as RoomId, expectedRoomRevision: 0 };

describe('owner browser cleanup consumer', () => {
  it('discovers an offline device request at startup and retries a failed SDK forget', async () => {
    const cleanupRoom = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const requests = vi.fn(async () => [request]);
    const consumer = createOwnerCleanupConsumer({ ownerId: () => ownerId, requests, cleanupRoom });
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
    const consumer = createOwnerCleanupConsumer({ ownerId: () => activeOwner, requests, cleanupRoom });
    await consumer.poll();
    expect(cleanupRoom).not.toHaveBeenCalled();
    requests.mockImplementationOnce(async () => [request]);
    activeOwner = 'peer_owner' as OwnerId;
    await consumer.poll();
    expect(cleanupRoom).not.toHaveBeenCalled();
    consumer.dispose();
  });
});
