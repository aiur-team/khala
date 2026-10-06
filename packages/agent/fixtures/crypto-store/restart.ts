import path from 'node:path';
import { createClient } from 'matrix-js-sdk';
import { openCryptoStore, wipeCryptoStore, CryptoStoreCorruptError } from '../../src/matrix/crypto-store';
import { logger } from 'matrix-js-sdk/lib/logger';
logger.disableAll();
import { openSessionDir, channelFiles, ensureStateDir } from '../../src/state';
const root = process.argv[2]!;
const files = await openSessionDir('codex', 'crypto-restart', { XDG_STATE_HOME: root });
const channel = channelFiles(files, '!room:test');
await ensureStateDir(channel.dir);
const creds = { homeserver: 'https://matrix.test', userId: '@agent:test', deviceId: process.argv[3] ?? 'DEVICE', accessToken: 'private-token', roomId: '!room:test' };
let store;
let reset = false;
try { store = await openCryptoStore(channel.dir, path.join(root, 'khala'), creds); }
catch (error) {
  if (process.argv[5] !== 'recover' || !(error instanceof CryptoStoreCorruptError)) throw error;
  await wipeCryptoStore(channel.dir, path.join(root, 'khala'));
  creds.deviceId = 'RECOVERED';
  store = await openCryptoStore(channel.dir, path.join(root, 'khala'), creds);
  reset = true;
}
const client = createClient({ baseUrl: creds.homeserver, userId: creds.userId, deviceId: creds.deviceId, accessToken: creds.accessToken,
  store: store.sync, fetchFn: async () => Response.json({ errcode: 'M_NOT_FOUND' }, { status: 404 }),
  logger: { trace() {}, debug() {}, info() {}, log() {}, warn() {}, error() {}, getChild() { return this; } },
});
await store.sync.startup();
await client.initRustCrypto({ useIndexedDB: true, cryptoDatabasePrefix: store.prefix });
const keys = await client.getCrypto()!.getOwnDeviceKeys();
const savedToken = await store.sync.getSavedSyncToken() ?? null;
await store.sync.setSyncData({ next_batch: 'offline-position', rooms: { join: {} } });
await store.sync.save(true);
let saving: Promise<void> | undefined;
if (process.argv[4] === 'wipe-during-save') {
  const backend = Reflect.get(store.sync, 'backend') as { syncToDatabase(users: unknown): Promise<void> };
  const original = backend.syncToDatabase.bind(backend);
  backend.syncToDatabase = async users => { await new Promise(resolve => setTimeout(resolve, 100)); await original(users); };
  saving = store.sync.save(true);
}
const undecryptableEventIds = store.undecryptableEventIds ?? [];
if (process.argv[4] === 'retry-ids') {
  await store.rememberUndecryptable(Array.from({ length: 105 }, (_, i) => ({ id: `$missing-${i}`, firstSeen: Date.now() })));
  await store.rememberJoin(100);
}
client.stopClient();
if (process.argv[4] === 'wipe' || process.argv[4] === 'wipe-during-save') await store.wipe();
if (process.argv[4] === 'wipe-during-save') await store.wipe();
await saving;
await store.close();
process.stdout.write(JSON.stringify({ keys, savedToken, undecryptableEventIds, reset, restored: store.restored, dir: channel.dir }));
