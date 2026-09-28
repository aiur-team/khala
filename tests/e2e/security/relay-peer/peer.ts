/// <reference lib="dom" />
// Test-only Matrix SDK peer. Keys stay in its disposable browser profile except
// the exact Megolm session keys exported to the in-memory relay scanner.
import { ClientEvent, MatrixEvent, SyncState, createClient, type MatrixClient } from '../../../../apps/connector/node_modules/matrix-js-sdk';

type Login = Readonly<{ baseUrl: string; userId: string; deviceId: string; accessToken: string; storeName: string }>;
let client: MatrixClient | null = null;

const peer = {
  async open(login: Login) {
    if (client) throw new Error('relay_peer_already_open');
    const next = createClient(login);
    await next.initRustCrypto({ useIndexedDB: true, cryptoDatabasePrefix: login.storeName });
    const ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { next.off(ClientEvent.Sync, onSync); reject(new Error('relay_peer_sync_timeout')); }, 30_000);
      const onSync = (state: SyncState) => {
        if (state !== SyncState.Prepared && state !== SyncState.Syncing) return;
        clearTimeout(timeout); next.off(ClientEvent.Sync, onSync); resolve();
      };
      next.on(ClientEvent.Sync, onSync);
    });
    await next.startClient({ initialSyncLimit: 50 });
    await ready;
    client = next;
  },
  async send(roomId: string, body: string): Promise<string> {
    if (!client) throw new Error('relay_peer_closed');
    return (await client.sendTextMessage(roomId, body)).event_id;
  },
  async peerDeviceKnown(userId: string, deviceId: string): Promise<boolean> {
    if (!client) throw new Error('relay_peer_closed');
    const devices = await client.getCrypto()!.getUserDeviceInfo([userId], true);
    return Boolean(devices.get(userId)?.get(deviceId)?.getFingerprint());
  },
  async decrypt(raw: Record<string, unknown>): Promise<{ kind: 'clear'; body: unknown } | { kind: 'missing'; reason: string }> {
    if (!client || raw.type !== 'm.room.encrypted') throw new Error('relay_peer_invalid_ciphertext');
    const event = new MatrixEvent(raw);
    try { await client.decryptEventIfNeeded(event); } catch { return { kind: 'missing', reason: 'exception' }; }
    if (event.isDecryptionFailure()) return { kind: 'missing', reason: event.decryptionFailureReason ?? 'unknown' };
    return { kind: 'clear', body: event.getContent().body as unknown };
  },
  async sessionKeys(roomId: string): Promise<string[]> {
    if (!client) throw new Error('relay_peer_closed');
    const keys = await client.getCrypto()!.exportRoomKeys();
    return keys.filter(key => key.room_id === roomId && typeof key.session_key === 'string')
      .map(key => key.session_key);
  },
  close() { client?.stopClient(); client = null; },
};
(window as unknown as { relayPeer: typeof peer }).relayPeer = peer;
