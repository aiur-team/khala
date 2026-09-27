import type { ClosureRequest, OwnerId, RoomId } from '@khala/contracts/messaging/index';

type CleanupPorts = Readonly<{
  ownerId(): OwnerId | null;
  requests(ownerId: OwnerId): Promise<readonly ClosureRequest[] | null>;
  cleanupRoom(ownerId: OwnerId, roomId: RoomId): Promise<boolean>;
}>;

/** Each browser processes its own durable requests when it is available; a failed SDK forget is retried. */
export function createOwnerCleanupConsumer(ports: CleanupPorts) {
  const processed = new Set<string>();
  let busy = false;
  let disposed = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  const onVisible = () => { if (document.visibilityState === 'visible') void poll(); };

  async function poll(): Promise<void> {
    if (disposed || busy) return;
    const ownerId = ports.ownerId();
    if (!ownerId) return;
    busy = true;
    try {
      const requests = await ports.requests(ownerId);
      if (!requests || disposed || ports.ownerId() !== ownerId) return;
      for (const request of requests) {
        if (disposed || ports.ownerId() !== ownerId) return;
        if (request.ownerId !== ownerId || request.expectedRoomRevision !== 0) continue;
        const key = JSON.stringify([ownerId, request.roomId, request.operationId]);
        if (processed.has(key)) continue;
        try {
          if (await ports.cleanupRoom(ownerId, request.roomId)) processed.add(key);
        } catch { /* Keep this request retryable on this device. */ }
      }
    } catch { /* An offline control route leaves all requests pending locally. */ }
    finally { busy = false; }
  }

  return {
    poll,
    start() {
      if (disposed || timer !== null) return;
      timer = setInterval(() => { void poll(); }, 15_000);
      document.addEventListener('visibilitychange', onVisible);
      void poll();
    },
    dispose() {
      disposed = true;
      if (timer !== null) {
        clearInterval(timer);
        document.removeEventListener('visibilitychange', onVisible);
      }
      timer = null;
    },
  };
}
