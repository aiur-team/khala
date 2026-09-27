/// <reference lib="dom" />
// Disposable acceptance peer. Its raw-event probe only tests local retained crypto and is never packaged with the connector.
import { ClientEvent, MatrixEvent, SyncState, createClient, type MatrixClient } from 'matrix-js-sdk';

type Configuration = Readonly<{ baseUrl: string; userId: string; deviceId: string; accessToken: string; storeName: string }>;
let client: MatrixClient | null = null;
const peer = {
  async open(configuration: Configuration) {
    if (client) throw new Error('peer_already_open');
    const next = createClient(configuration);
    await next.initRustCrypto({ useIndexedDB: true, cryptoDatabasePrefix: configuration.storeName });
    next.getCrypto()!.globalBlacklistUnverifiedDevices = true;
    const ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { next.off(ClientEvent.Sync, onSync); reject(new Error('peer_sync_timeout')); }, 30_000);
      const onSync = (state: SyncState) => {
        if (state !== SyncState.Prepared && state !== SyncState.Syncing) return;
        clearTimeout(timeout); next.off(ClientEvent.Sync, onSync); resolve();
      };
      next.on(ClientEvent.Sync, onSync);
    });
    await next.startClient({ initialSyncLimit: 50 });
    await ready;
    client = next;
    return next.getCrypto()!.getOwnDeviceKeys();
  },
  async trust(userId: string, deviceId: string, fingerprint: string) {
    const crypto = client?.getCrypto();
    if (!crypto) throw new Error('peer_closed');
    const device = (await crypto.getUserDeviceInfo([userId], true)).get(userId)?.get(deviceId);
    if (!device || device.getFingerprint() !== fingerprint) throw new Error('peer_fingerprint_mismatch');
    await crypto.setDeviceVerified(userId, deviceId, true);
    return (await crypto.getDeviceVerificationStatus(userId, deviceId))?.isVerified() === true;
  },
  async send(roomId: string, body: string) {
    if (!client) throw new Error('peer_closed');
    return (await client.sendTextMessage(roomId, body)).event_id;
  },
  async discard(roomId: string) {
    const crypto = client?.getCrypto();
    if (!crypto) throw new Error('peer_closed');
    await crypto.forceDiscardSession(roomId);
  },
  async decryptRaw(raw: Record<string, unknown>) {
    if (!client || raw.type !== 'm.room.encrypted') throw new Error('peer_invalid_ciphertext');
    const event = new MatrixEvent(raw);
    try { await client.decryptEventIfNeeded(event); } catch { return { kind: 'missing' as const }; }
    if (event.isDecryptionFailure()) return { kind: 'missing' as const };
    return { kind: 'clear' as const, body: event.getContent().body as unknown };
  },
  close() { client?.stopClient(); client = null; },
};
(window as unknown as { revocationPeer: typeof peer }).revocationPeer = peer;
