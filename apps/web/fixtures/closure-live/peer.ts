/// <reference lib="dom" />
// Acceptance-only owner browser: production cleanup consumer and HTTP decoder with real Matrix SDK local forget.
import { ClientEvent, SyncState, createClient, type MatrixClient } from 'matrix-js-sdk';
import { decodeContentLimits, type OwnerId, type RoomId } from '@khala/contracts/messaging/index';
import { createHumanBrowserApi } from '../../src/composition/human/browser-api';
import { createOwnerCleanupConsumer } from '../../src/composition/human/cleanup-consumer';

type OpenInput = Readonly<{ appOrigin: string; baseUrl: string; ownerId: string; userId: string;
  deviceId: string; accessToken: string; roomId: string; storeName: string }>;
let client: MatrixClient | null = null;
let consumer: ReturnType<typeof createOwnerCleanupConsumer> | null = null;
let attempts = 0;
let successes = 0;
let roomId: string | null = null;
const api = {
  async open(input: OpenInput) {
    if (client) throw new Error('closure_browser_open');
    const next = createClient({ baseUrl: input.baseUrl, userId: input.userId,
      accessToken: input.accessToken, deviceId: input.deviceId });
    await next.initRustCrypto({ useIndexedDB: true, cryptoDatabasePrefix: input.storeName });
    const ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { next.off(ClientEvent.Sync, onSync); reject(new Error('closure_browser_sync_timeout')); }, 30_000);
      const onSync = (state: SyncState) => {
        if (state !== SyncState.Prepared && state !== SyncState.Syncing) return;
        clearTimeout(timeout); next.off(ClientEvent.Sync, onSync); resolve();
      };
      next.on(ClientEvent.Sync, onSync);
    });
    await next.startClient({ initialSyncLimit: 50 });
    await ready;
    const limits = decodeContentLimits({ maxBodyBytes: 32_768, maxDisplayNameBytes: 255, maxRoomTitleBytes: 255 });
    if (!limits.ok) throw new Error('closure_browser_limits');
    const control = createHumanBrowserApi({ origin: input.appOrigin,
      homeserverOrigin: 'https://matrix.invalid', limits: limits.value });
    client = next;
    roomId = input.roomId;
    consumer = createOwnerCleanupConsumer({
      ownerId: () => input.ownerId as OwnerId,
      requests: ownerId => control.cleanupRequests(ownerId),
      async cleanupRoom(ownerId, targetRoomId) {
        if (ownerId !== input.ownerId || targetRoomId !== input.roomId) return false;
        attempts += 1;
        try { await next.forget(targetRoomId, true); successes += 1; return true; }
        catch { return false; }
      },
    });
    return { roomKnown: next.getRoom(input.roomId) !== null,
      deviceId: next.getDeviceId(), fingerprint: (await next.getCrypto()!.getOwnDeviceKeys()).ed25519 };
  },
  start() { if (!consumer) throw new Error('closure_browser_closed'); consumer.start(); },
  async poll() { if (!consumer) throw new Error('closure_browser_closed'); await consumer.poll(); },
  status() { return { attempts, successes, roomKnown: roomId !== null && client?.getRoom(roomId as RoomId) !== null }; },
  close() { consumer?.dispose(); consumer = null; client?.stopClient(); client = null; },
};
(window as unknown as { closureFixture: typeof api }).closureFixture = api;
