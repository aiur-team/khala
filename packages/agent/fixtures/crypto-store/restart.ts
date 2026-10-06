import path from 'node:path';
import { createClient } from 'matrix-js-sdk';
import { openCryptoStore } from '../../src/matrix/crypto-store';
import { logger } from 'matrix-js-sdk/lib/logger';
logger.disableAll();
import { openSessionDir, channelFiles, ensureStateDir } from '../../src/state';
const root = process.argv[2]!;
const files = await openSessionDir('codex', 'crypto-restart', { XDG_STATE_HOME: root });
const channel = channelFiles(files, '!room:test');
await ensureStateDir(channel.dir);
const creds = { homeserver: 'https://matrix.test', userId: '@agent:test', deviceId: process.argv[3] ?? 'DEVICE', accessToken: 'private-token', roomId: '!room:test' };
const store = await openCryptoStore(channel.dir, path.join(root, 'khala'), creds);
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
client.stopClient();
if (process.argv[4] === 'wipe') await store.wipe();
await store.close();
process.stdout.write(JSON.stringify({ keys, savedToken, restored: store.restored, dir: channel.dir }));
