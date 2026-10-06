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
  private readonly saves = new Set<Promise<void>>();
  private shuttingDown = false;
  override wantsSave(): boolean { return !this.shuttingDown; }
  override save(force = false): Promise<void> {
    if (this.shuttingDown) return Promise.resolve();
    const saving = super.save(force);
    this.saves.add(saving);
    void saving.finally(() => this.saves.delete(saving)).catch(() => {});
    return saving;
  }
  override async destroy(): Promise<void> {
    this.shuttingDown = true;
    await Promise.allSettled(this.saves);
    await super.destroy();
  }
}
export class CryptoStoreCorruptError extends StateError {
  constructor() { super('storage_failed'); }
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
      || (value.joinedAt !== undefined && !Number.isFinite(value.joinedAt))) throw new CryptoStoreCorruptError();
    return value;
  } catch (error) {
    if (error instanceof StateError) throw error;
    if (error instanceof SyntaxError) throw new CryptoStoreCorruptError();
    throw new StateError('storage_failed');
  }
  finally { await handle.close(); }
}
type Identity = { homeserver: string; userId: string; deviceId: string; accessToken?: string; joinedAt?: number };
export type PersistentCryptoStore = {
  recovered?: boolean; prefix: string; sync: IndexedDBStore; restored: boolean; joinedAt?: number;
  rememberJoin(ts: number): Promise<void>;
  forgetIdentity(): Promise<void>; close(): Promise<void>; wipe(): Promise<void>;
};
async function unlink(file: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try { await fs.unlink(file); return; }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return;
      if (attempt >= 2 || !['EBUSY', 'EPERM', 'EACCES'].includes(code ?? '')) throw error;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
}
function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.deleteDatabase(name);
    const timer = setTimeout(() => reject(new Error('crypto_store_in_use')), 5000);
    request.onsuccess = () => { clearTimeout(timer); resolve(); };
    request.onerror = () => { clearTimeout(timer); reject(new StateError('storage_failed')); };
    // A blocked request remains queued and will complete once the closing
    // connection drains. Do not enqueue another deletion behind it.
    request.onblocked = () => {};
  });
}
async function deleteStores(prefix: string, dir: string): Promise<void> {
  for (const name of [prefix + '::matrix-sdk-crypto', 'matrix-js-sdk:' + prefix]) {
    let failure: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await deleteDatabase(name); failure = undefined; break; }
      catch (error) { if (error instanceof Error && error.message === 'crypto_store_in_use') throw error; failure = error; if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    if (failure) throw failure;
  }
  // An absent IndexedDB catalog entry does not imply the SQLite file is absent
  // (for example after a crash during deletion).
  await unlink(path.join(dir, 'crypto.sqlite'));
  await unlink(path.join(dir, 'sync.sqlite'));
}
export async function openCryptoStore(dir: string, root: string, creds: AgentCredentials): Promise<PersistentCryptoStore> {
  const prefix = await configure(dir, root);
  // A heartbeat lease is also valid after SIGKILL: a new process waits for the
  // stale lease rather than risking concurrent use of a Rust crypto store.
  const release = await lockfile.lock(dir, { realpath: false, lockfilePath: path.join(dir, 'crypto.lock'),
    stale: 10_000, update: 2000, retries: { retries: 12, minTimeout: 1000, maxTimeout: 1000 } });
  try {
    const identityFile = path.join(dir, 'crypto.json');
    for (const name of ['crypto.sqlite', 'sync.sqlite']) {
      const file = path.join(dir, name);
      try { await fs.lstat(file); privateFile(file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    let recovered = false;
    let previous: Identity | null;
    try { previous = await readIdentity(identityFile); }
    catch (error) {
      if (!(error instanceof CryptoStoreCorruptError)) throw error;
      await unlink(identityFile);
      await deleteStores(prefix, dir);
      previous = null;
      recovered = true;
    }
    const identity = { homeserver: creds.homeserver, userId: creds.userId, deviceId: creds.deviceId, accessToken: creds.accessToken };
    const restored = previous !== null && previous.homeserver === identity.homeserver
      && previous.userId === identity.userId && previous.deviceId === identity.deviceId;
    if (restored) {
      // Missing/truncated/non-SQLite data cannot safely be recreated under the
      // stored device identity: that device would then have different keys.
      let handle: fs.FileHandle;
      try { handle = await fs.open(path.join(dir, 'crypto.sqlite'), constants.O_RDONLY | constants.O_NOFOLLOW); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new CryptoStoreCorruptError();
        throw new StateError('unsafe_state_dir');
      }
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
          || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new StateError('unsafe_state_dir');
        const header = Buffer.alloc(16);
        await handle.read(header, 0, 16, 0);
        if (header.toString('ascii') !== 'SQLite format 3\0') throw new CryptoStoreCorruptError();
      } finally { await handle.close(); }
    }
    if (!restored) {
      await deleteStores(prefix, dir);
    }
    await writeJsonAtomic(identityFile, { ...identity, ...(restored && previous?.joinedAt !== undefined ? { joinedAt: previous?.joinedAt } : {}) });
    const sync = new DurableSyncStore({ indexedDB: globalThis.indexedDB, dbName: prefix });
    let closed: Promise<void> | undefined;
    return { prefix, sync, restored, ...(recovered ? { recovered } : {}), ...(restored && previous?.joinedAt !== undefined ? { joinedAt: previous?.joinedAt } : {}),
      async rememberJoin(this: PersistentCryptoStore, ts) { if (this.joinedAt === undefined) { await writeJsonAtomic(identityFile, { ...identity, joinedAt: ts }); this.joinedAt = ts; } },
      forgetIdentity() { return unlink(identityFile); },
      close() { return closed ??= sync.destroy().finally(release); },
      async wipe() {
        await unlink(identityFile);
        await sync.destroy();
        await deleteStores(prefix, dir);
      },
    };
  } catch (error) { await release(); throw error; }
}

/** Also used when control refuses an offline restore before a Matrix client opens. */
export async function wipeCryptoStore(dir: string, root: string): Promise<void> {
  try {
    const names = await fs.readdir(dir);
    if (!['crypto.json', 'crypto.sqlite', 'sync.sqlite'].some(name => names.includes(name))) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const prefix = await configure(dir, root);
  const release = await lockfile.lock(dir, { realpath: false, lockfilePath: path.join(dir, 'crypto.lock'),
    stale: 10_000, update: 2000, retries: { retries: 12, minTimeout: 1000, maxTimeout: 1000 } });
  try {
    await unlink(path.join(dir, 'crypto.json'));
    await deleteStores(prefix, dir);
  } finally { await release(); }
}

/** Check the old token before an automatic rejoin can mint a replacement. */
export async function validateCryptoToken(dir: string, fetcher: typeof fetch = fetch): Promise<'absent' | 'valid' | 'revoked' | 'unavailable' | 'corrupt'> {
  let identity: Identity | null;
  try { identity = await readIdentity(path.join(dir, 'crypto.json')); }
  catch (error) { if (error instanceof CryptoStoreCorruptError) return 'corrupt'; throw error; }
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
