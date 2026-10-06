import { constants, openSync, closeSync, fstatSync, lstatSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import lockfile from 'proper-lockfile';
import setGlobalVars from 'indexeddbshim/src/node.js';
import nodeWebSQL from 'indexeddbshim/src/nodeWebSQL.js';
import { IndexedDBStore } from 'matrix-js-sdk';
import type { AgentCredentials } from '@khala/contracts/m1/agent-join';
import { ensureStateDir, writeJsonAtomic, StateError } from '../state';

// IndexedDBShim has one configuration per process. Map opaque database names to
// validated channel directories, rather than changing its base path per client.
const databasePaths = new Map<string, string>();
let metadataPath: string | undefined;
function privateFile(file: string): void {
  try { if (lstatSync(file).isSymbolicLink()) throw new StateError('unsafe_state_dir'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const fd = openSync(file, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
      || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new StateError('unsafe_state_dir');
  } finally { closeSync(fd); }
}
async function configure(dir: string, root: string): Promise<string> {
  await ensureStateDir(dir);
  const prefix = 'khala-' + createHash('sha256').update(path.resolve(dir)).digest('hex');
  databasePaths.set(prefix + '::matrix-sdk-crypto', path.join(dir, 'crypto.sqlite'));
  databasePaths.set('matrix-js-sdk:' + prefix, path.join(dir, 'sync.sqlite'));
  if (!metadataPath) {
    // root is an ancestor already checked by ensureStateDir(dir).
    const stat = await fs.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
      || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new StateError('unsafe_state_dir');
    metadataPath = path.join(root, 'crypto-index.sqlite');
    setGlobalVars(globalThis, {
      checkOrigin: false, databaseBasePath: '', sysDatabaseBasePath: root,
      escapeDatabaseName: name => {
        const file = databasePaths.get(name);
        if (!file) throw new StateError('unsafe_state_dir');
        return file;
      },
      win: { openDatabase: (name, version, displayName, size) => {
        const file = displayName === 'System Database' ? metadataPath! : name;
        if (file !== metadataPath && ![...databasePaths.values()].includes(file)) throw new StateError('unsafe_state_dir');
        privateFile(file);
        return nodeWebSQL(file, version, displayName, size);
      } },
    });
  } else if (metadataPath !== path.join(root, 'crypto-index.sqlite')) throw new Error('crypto_store_root_changed');
  return prefix;
}

// Persist every completed sync rather than the SDK's five-minute default.
class DurableSyncStore extends IndexedDBStore {
  override wantsSave(): boolean { return true; }
}
async function readIdentity(file: string): Promise<Identity | null> {
  let handle: fs.FileHandle;
  try { handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new StateError('unsafe_state_dir'); }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
      || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new StateError('unsafe_state_dir');
    const value = JSON.parse(await handle.readFile('utf8')) as Identity;
    if (!value || typeof value.homeserver !== 'string' || typeof value.userId !== 'string' || typeof value.deviceId !== 'string'
      || (value.accessToken !== undefined && typeof value.accessToken !== 'string')
      || (value.joinedAt !== undefined && !Number.isFinite(value.joinedAt))) throw new StateError('storage_failed');
    return value;
  } catch (error) { if (error instanceof StateError) throw error; throw new StateError('storage_failed'); }
  finally { await handle.close(); }
}
type Identity = { homeserver: string; userId: string; deviceId: string; accessToken?: string; joinedAt?: number };
export type PersistentCryptoStore = {
  prefix: string; sync: IndexedDBStore; restored: boolean; joinedAt?: number;
  rememberJoin(ts: number): Promise<void>;
  close(): Promise<void>; wipe(): Promise<void>;
};
function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(new StateError('storage_failed'));
    request.onblocked = () => reject(new Error('crypto_store_in_use'));
  });
}
export async function openCryptoStore(dir: string, root: string, creds: AgentCredentials): Promise<PersistentCryptoStore> {
  const prefix = await configure(dir, root);
  // A heartbeat lease is also valid after SIGKILL: a new process waits for the
  // stale lease rather than risking concurrent use of a Rust crypto store.
  const release = await lockfile.lock(dir, { realpath: false, lockfilePath: path.join(dir, 'crypto.lock'),
    stale: 10_000, update: 2000, retries: { retries: 12, minTimeout: 1000, maxTimeout: 1000 } });
  try {
    const identityFile = path.join(dir, 'crypto.json');
    const previous = await readIdentity(identityFile);
    const identity = { homeserver: creds.homeserver, userId: creds.userId, deviceId: creds.deviceId, accessToken: creds.accessToken };
    const restored = previous !== null && previous.homeserver === identity.homeserver
      && previous.userId === identity.userId && previous.deviceId === identity.deviceId;
    if (!restored) {
      await deleteDatabase(prefix + '::matrix-sdk-crypto');
      await deleteDatabase('matrix-js-sdk:' + prefix);
    }
    await writeJsonAtomic(identityFile, { ...identity, ...(restored && previous.joinedAt !== undefined ? { joinedAt: previous.joinedAt } : {}) });
    const sync = new DurableSyncStore({ indexedDB: globalThis.indexedDB, dbName: prefix });
    let closed: Promise<void> | undefined;
    return { prefix, sync, restored, ...(restored && previous.joinedAt !== undefined ? { joinedAt: previous.joinedAt } : {}),
      async rememberJoin(this: PersistentCryptoStore, ts) { if (this.joinedAt === undefined) { await writeJsonAtomic(identityFile, { ...identity, joinedAt: ts }); this.joinedAt = ts; } },
      close() { return closed ??= sync.destroy().finally(release); },
      async wipe() {
        await sync.destroy();
        await deleteDatabase(prefix + '::matrix-sdk-crypto');
        await deleteDatabase('matrix-js-sdk:' + prefix);
        await fs.unlink(identityFile).catch(error => { if (error.code !== 'ENOENT') throw error; });
      },
    };
  } catch (error) { await release(); throw error; }
}

/** Also used when control refuses an offline restore before a Matrix client opens. */
export async function wipeCryptoStore(dir: string, root: string): Promise<void> {
  try { await fs.lstat(path.join(dir, 'crypto.json')); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const prefix = await configure(dir, root);
  const release = await lockfile.lock(dir, { realpath: false, lockfilePath: path.join(dir, 'crypto.lock'),
    stale: 10_000, update: 2000, retries: { retries: 12, minTimeout: 1000, maxTimeout: 1000 } });
  try {
    await deleteDatabase(prefix + '::matrix-sdk-crypto');
    await deleteDatabase('matrix-js-sdk:' + prefix);
    await fs.unlink(path.join(dir, 'crypto.json'));
  } finally { await release(); }
}

/** Check the old token before an automatic rejoin can mint a replacement. */
export async function validateCryptoToken(dir: string, fetcher: typeof fetch = fetch): Promise<'absent' | 'valid' | 'revoked' | 'unavailable'> {
  const identity = await readIdentity(path.join(dir, 'crypto.json'));
  if (!identity?.accessToken) return 'absent';
  try {
    const response = await fetcher(`${identity.homeserver}/_matrix/client/v3/account/whoami`, {
      headers: { authorization: `Bearer ${identity.accessToken}` }, signal: AbortSignal.timeout(5000),
    });
    if (response.status === 401) return 'revoked';
    if (!response.ok) return 'unavailable';
    const value = await response.json() as { user_id?: unknown; device_id?: unknown };
    return value.user_id === identity.userId && value.device_id === identity.deviceId ? 'valid' : 'unavailable';
  } catch { return 'unavailable'; }
}

/** Reuse credentials only after control reauthorizes the same account and room. */
export async function restoredCredentials(dir: string, issued: AgentCredentials): Promise<AgentCredentials> {
  const identity = await readIdentity(path.join(dir, 'crypto.json'));
  if (!identity?.accessToken) return issued;
  if (identity.homeserver !== issued.homeserver || identity.userId !== issued.userId) throw new StateError('storage_failed');
  return { ...issued, deviceId: identity.deviceId, accessToken: identity.accessToken };
}
