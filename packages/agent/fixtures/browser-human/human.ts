/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
import { createClient, ClientEvent, SyncState, Preset } from 'matrix-js-sdk';
import type { MatrixClient } from 'matrix-js-sdk';
import type { AgentCredentials } from '@khala/contracts/m1/agent-join';
let client: MatrixClient;
const human = {
  async open(creds: AgentCredentials) {
    client = createClient({ baseUrl: creds.homeserver, userId: creds.userId, accessToken: creds.accessToken, deviceId: creds.deviceId });
    await client.initRustCrypto({ useIndexedDB: true, cryptoDatabasePrefix: creds.deviceId });
    const prepared = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { client.removeListener(ClientEvent.Sync, listener); reject(new Error('sync_timeout')); }, 30_000);
      const listener = (state: SyncState) => {
        if (state === SyncState.Prepared || state === SyncState.Syncing) { clearTimeout(timer); client.removeListener(ClientEvent.Sync, listener); resolve(); }
      };
      client.on(ClientEvent.Sync, listener);
    });
    await Promise.all([client.startClient({ initialSyncLimit: 30 }), prepared]);
  },
  async createSharedRoom() {
    const room = await client.createRoom({ preset: Preset.PrivateChat, name: 'Node crypto spike', initial_state: [
      { type: 'm.room.history_visibility', state_key: '', content: { history_visibility: 'shared' } },
      { type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } },
    ] });
    // Wait for the new room's encryption state before the first send.
    const deadline = Date.now() + 30_000;
    while (!client.getRoom(room.room_id)?.currentState.getStateEvents('m.room.encryption', '')) {
      if (Date.now() >= deadline) throw new Error('room_sync_timeout');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return room.room_id;
  },
  async crossSign() {
    const crypto = client.getCrypto()!;
    const status = await crypto.getCrossSigningStatus();
    if (!status.privateKeysInSecretStorage && !status.privateKeysCachedLocally.masterKey) {
      await crypto.bootstrapCrossSigning({ authUploadDeviceSigningKeys: async f => { await f(null); } });
    }
    await client.setDisplayName('Maya');
  },
  async send(roomId: string, body: string) { return (await client.sendTextMessage(roomId, body)).event_id; },
  async invite(roomId: string, userId: string) { await client.invite(roomId, userId); },
  async readBodies(roomId: string) {
    const messages: { sender: string | undefined; body: string }[] = [];
    for (const event of client.getRoom(roomId)?.getLiveTimeline().getEvents() ?? []) {
      try { await client.decryptEventIfNeeded(event); } catch { continue; }
      if (event.getType() === 'm.room.message' && !event.isDecryptionFailure() && typeof event.getContent().body === 'string') messages.push({ sender: event.getSender(), body: event.getContent().body });
    }
    return messages;
  },
  async close() { client?.stopClient(); },
};
declare global { interface Window { human: typeof human } }
window.human = human;
