// Opening, ownership and schema checks against a real on-disk ledger.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DeviceId } from '@khala/contracts/delivery/index';
import type { StorageErrorCode } from './errors';
import { type Child, spawnChild } from './fixtures/child';
import { binding, limits, pendingInput, scratchDirectory } from './fixtures/fakes';
import { LEDGER_FILE, assertOpenedFile, pinLedgerFile } from './leases';
import { type ConnectorStorage, openConnectorStorage, storageInternals } from './open';
import { recoverConnectorStorage } from './recovery';
import { APPLICATION_ID, SCHEMA_VERSION } from './schema';

const opened: ConnectorStorage[] = [];
const scratch: string[] = [];

const children: Child[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const child of children.splice(0)) {
    child.process.kill('SIGKILL');
    await child.exited;
  }
  await Promise.all(opened.splice(0).map(storage => storage.close()));
  for (const dir of scratch.splice(0)) {
    fs.chmodSync(dir, 0o700);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function dirs() {
  const d = scratchDirectory();
  scratch.push(d.parent);
  return d;
}

async function open(directory: string, mode: 'create' | 'existing' = 'create', maxBytes?: number) {
  const storage = await openConnectorStorage({ directory, mode, limits, ...(maxBytes === undefined ? {} : { maxBytes }) });
  opened.push(storage);
  return storage;
}

async function openError(directory: string, mode: 'create' | 'existing' = 'create', maxBytes?: number): Promise<StorageErrorCode> {
  try {
    await open(directory, mode, maxBytes);
  } catch (error) {
    return (error as { code: StorageErrorCode }).code;
  }
  throw new Error('open unexpectedly succeeded');
}

const modeOf = (target: string) => fs.statSync(target).mode & 0o777;

function rawDb(storage: ConnectorStorage) {
  const internals = storageInternals.get(storage);
  if (!internals) throw new Error('no internals');
  return internals.ctx.db;
}

/** A closed, valid ledger whose header fields a test can then rewrite. */
async function closedLedger() {
  const { state } = dirs();
  await (await open(state)).close();
  return { state, file: path.join(state, LEDGER_FILE) };
}

function rewrite(file: string, sql: string) {
  const db = new DatabaseSync(file);
  db.exec(sql);
  db.close();
}

describe('openConnectorStorage', () => {
  it('creates an owner-only state directory and ledger', async () => {
    const { state } = dirs();
    await open(state);
    expect(modeOf(state)).toBe(0o700);
    expect(modeOf(path.join(state, LEDGER_FILE))).toBe(0o600);
    for (const name of fs.readdirSync(state)) expect(modeOf(path.join(state, name)) & 0o077).toBe(0);
  });

  it('refuses to invent state in existing mode', async () => {
    const { state } = dirs();
    expect(await openError(state, 'existing')).toBe('missing_state');
    fs.mkdirSync(state, { mode: 0o700 });
    expect(await openError(state, 'existing')).toBe('missing_state');
    expect(fs.readdirSync(state)).toEqual([]);
  });

  it('reopens existing state and bumps the open epoch each time', async () => {
    const { state } = dirs();
    const first = await open(state);
    expect(first.epoch).toBe(1);
    await first.close();
    const second = await open(state, 'existing');
    expect(second.epoch).toBe(2);
  });

  it('rejects relative, dot-segment and symlinked state paths', async () => {
    const { parent, state } = dirs();
    expect(await openError('relative/state')).toBe('unsafe_path');
    expect(await openError(`${parent}/x/../state`)).toBe('unsafe_path');

    fs.mkdirSync(path.join(parent, 'real'), { mode: 0o700 });
    fs.symlinkSync(path.join(parent, 'real'), state);
    expect(await openError(state)).toBe('unsafe_path');
  });

  it('rejects a symlinked or hard-linked ledger file', async () => {
    const { parent, state } = dirs();
    fs.mkdirSync(state, { mode: 0o700 });
    const elsewhere = path.join(parent, 'elsewhere.sqlite');
    fs.writeFileSync(elsewhere, '', { mode: 0o600 });
    fs.symlinkSync(elsewhere, path.join(state, LEDGER_FILE));
    expect(await openError(state)).toBe('unsafe_path');

    fs.unlinkSync(path.join(state, LEDGER_FILE));
    fs.linkSync(elsewhere, path.join(state, LEDGER_FILE));
    expect(await openError(state)).toBe('unsafe_path');
  });

  it('rejects state readable by other users', async () => {
    const { state } = dirs();
    await (await open(state)).close();
    fs.chmodSync(state, 0o750);
    expect(await openError(state, 'existing')).toBe('unsafe_path');
    fs.chmodSync(state, 0o700);
    fs.chmodSync(path.join(state, LEDGER_FILE), 0o644);
    expect(await openError(state, 'existing')).toBe('unsafe_path');
  });

  it('fails visibly when the state directory cannot be created', async () => {
    const { parent, state } = dirs();
    fs.chmodSync(parent, 0o500);
    expect(await openError(state)).toBe('io_failed');
  });

  it('refuses a corrupt ledger, a foreign SQLite file and a newer schema', async () => {
    const { state } = dirs();
    fs.mkdirSync(state, { mode: 0o700 });
    const file = path.join(state, LEDGER_FILE);
    fs.writeFileSync(file, 'not a sqlite database, just some bytes on disk'.repeat(4), { mode: 0o600 });
    expect(await openError(state, 'existing')).toBe('corrupt');

    fs.rmSync(file);
    const foreign = new DatabaseSync(file);
    foreign.exec('CREATE TABLE something_else (x)');
    foreign.close();
    fs.chmodSync(file, 0o600);
    expect(await openError(state, 'existing')).toBe('corrupt');

    fs.rmSync(file);
    await (await open(state)).close();
    const newer = new DatabaseSync(file);
    newer.exec('PRAGMA user_version = 99');
    newer.close();
    expect(await openError(state, 'existing')).toBe('schema_unsupported');
  });

  it('treats an empty ledger in existing mode as lost state, not a new one', async () => {
    const { state } = dirs();
    fs.mkdirSync(state, { mode: 0o700 });
    fs.writeFileSync(path.join(state, LEDGER_FILE), '', { mode: 0o600 });
    expect(await openError(state, 'existing')).toBe('corrupt');
    expect(fs.statSync(path.join(state, LEDGER_FILE)).size).toBe(0);
  });

  it('treats a ledger with a SQLite header but no schema in existing mode as lost state', async () => {
    const { state } = dirs();
    fs.mkdirSync(state, { mode: 0o700 });
    const file = path.join(state, LEDGER_FILE);
    rewrite(file, 'PRAGMA journal_mode = WAL');
    fs.chmodSync(file, 0o600);
    expect(fs.statSync(file).size).toBeGreaterThan(0);
    expect(await openError(state, 'existing')).toBe('corrupt');
  });

  it('allows one owner at a time and releases ownership on close', async () => {
    const { state } = dirs();
    const first = await open(state);
    expect(await openError(state, 'existing')).toBe('locked');
    await first.close();
    await expect(first.readCursor('stream')).rejects.toMatchObject({ code: 'closed' });
    const second = await open(state, 'existing');
    expect(second.epoch).toBe(2);
  });

  it('binds the SDK device identity once and refuses a substitute', async () => {
    const { state } = dirs();
    const storage = await open(state);
    const identity = { deviceId: 'device_connector_b' as DeviceId, fingerprint: 'fp_1' };
    expect(await storage.bindDeviceIdentity(identity)).toEqual({ kind: 'bound' });
    await storage.close();

    for (const substitute of [{ ...identity, fingerprint: 'fp_fresh' }, { ...identity, deviceId: 'device_new' as DeviceId }]) {
      const reopened = await open(state, 'existing');
      expect(await reopened.bindDeviceIdentity(identity)).toEqual({ kind: 'matched' });
      expect(await reopened.bindDeviceIdentity(substitute)).toEqual({ kind: 'conflict', code: 'identity_mismatch' });
      await reopened.close();
    }
  });

  it('rejects a symlinked ancestor directory', async () => {
    const { parent } = dirs();
    fs.mkdirSync(path.join(parent, 'real'), { mode: 0o700 });
    fs.symlinkSync(path.join(parent, 'real'), path.join(parent, 'link'));
    expect(await openError(path.join(parent, 'link', 'state'))).toBe('unsafe_path');
    expect(fs.readdirSync(path.join(parent, 'real'))).toEqual([]);
  });

  it('rejects an ancestor other users can write to, unless it is sticky', async () => {
    const { parent, state } = dirs();
    fs.chmodSync(parent, 0o777);
    expect(await openError(state)).toBe('unsafe_path');
    expect(fs.existsSync(state)).toBe(false);
    fs.chmodSync(parent, 0o1777);
    await open(state);
  });

  it('sets owner-only modes explicitly under a umask that would strip them', async () => {
    const { state } = dirs();
    const child = spawnChild(state, `
      process.umask(0o277);
      const s = await open({ directory: dir, mode: 'create', limits });
      await s.close();
      const mode = target => fs.statSync(target).mode & 0o777;
      return [mode(dir), mode(dir + '/ledger.sqlite')];
    `);
    children.push(child);
    expect(await child.line).toEqual({ ok: true, result: [0o700, 0o600] });
  }, 30_000);

  it('rejects unsafe SQLite companion files', async () => {
    for (const suffix of ['-wal', '-journal', '-shm']) {
      const { state, file } = await closedLedger();
      fs.writeFileSync(file + suffix, '', { mode: 0o644 });
      fs.chmodSync(file + suffix, 0o644);
      expect(await openError(state, 'existing')).toBe('unsafe_path');
      fs.rmSync(file + suffix);
      fs.symlinkSync(path.join(state, '..', 'elsewhere'), file + suffix);
      expect(await openError(state, 'existing')).toBe('unsafe_path');
    }
  });

  it('pins the ledger without following a symlink', () => {
    const { parent } = dirs();
    const target = path.join(parent, 'target.sqlite');
    fs.writeFileSync(target, 'x', { mode: 0o600 });
    fs.symlinkSync(target, path.join(parent, 'link.sqlite'));
    expect(() => pinLedgerFile(path.join(parent, 'link.sqlite'))).toThrow(expect.objectContaining({ code: 'unsafe_path' }));
    expect(pinLedgerFile(target)).toMatchObject({ ino: fs.statSync(target).ino });
  });

  it('refuses a ledger owned by another user', async () => {
    const { parent } = dirs();
    const target = path.join(parent, 'ledger.sqlite');
    fs.writeFileSync(target, 'x', { mode: 0o600 });
    const uid = process.getuid!();
    vi.spyOn(process, 'getuid').mockReturnValue(uid + 1);
    expect(() => pinLedgerFile(target)).toThrow(expect.objectContaining({ code: 'unsafe_path' }));
  });

  it('checks the file SQLite actually opened, not what the path names afterwards', async () => {
    const { parent } = dirs();
    const target = path.join(parent, 'ledger.sqlite');
    rewrite(target, 'CREATE TABLE t (x)');
    fs.chmodSync(target, 0o600);
    const pinned = pinLedgerFile(target);

    // Swap the path between validation and open.
    fs.renameSync(target, path.join(parent, 'original.sqlite'));
    rewrite(target, 'CREATE TABLE u (x)');
    fs.chmodSync(target, 0o600);
    const db = new DatabaseSync(target);
    try {
      db.exec('SELECT * FROM u');
      expect(() => assertOpenedFile(target, pinned)).toThrow(expect.objectContaining({ code: 'unsafe_path' }));
      expect(() => assertOpenedFile(target, pinLedgerFile(target))).not.toThrow();
    } finally {
      db.close();
    }
  });

  it('refuses to open when the ledger is swapped between pinning and open', async () => {
    const { state, file } = await closedLedger();
    const decoy = path.join(state, 'decoy.sqlite');
    fs.copyFileSync(file, decoy);
    fs.chmodSync(decoy, 0o600);
    // Swap in a valid copy (a different inode) right after the pin closes its descriptor.
    const closeSync = fs.closeSync.bind(fs);
    let swapped = false;
    vi.spyOn(fs, 'closeSync').mockImplementation(fd => {
      closeSync(fd);
      if (!swapped) {
        swapped = true;
        fs.renameSync(decoy, file);
      }
    });
    expect(await openError(state, 'existing')).toBe('unsafe_path');
    expect(swapped).toBe(true);
  });

  it('fences mutations once the open epoch has moved on', async () => {
    const { state } = dirs();
    const storage = await open(state);
    await storage.ledger.transaction(tx => tx.putBinding(binding(0)));
    // Another owner claimed the ledger (the epoch is only bumped by a successful open).
    rawDb(storage).exec("UPDATE meta SET value = '9' WHERE key = 'open_epoch'");
    await expect(storage.persistPending(pendingInput('event_7', 'hi'))).rejects.toMatchObject({ code: 'fenced' });
    await expect(storage.commitCursor({ streamId: 's', expectedRevision: 0, opaqueCursor: 'c' })).rejects.toMatchObject({ code: 'fenced' });
    await expect(storage.ledger.transaction(tx => tx.ledgerRevision())).rejects.toMatchObject({ code: 'fenced' });
    expect((await recoverConnectorStorage(storage)).pending).toBe(0);
  });

  it('never waits on a lock and writes with full durability', async () => {
    const { state } = dirs();
    const db = rawDb(await open(state));
    expect(db.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 0 });
    expect(db.prepare('PRAGMA synchronous').get()).toEqual({ synchronous: 2 });
    expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
    expect(db.prepare('PRAGMA locking_mode').get()).toEqual({ locking_mode: 'exclusive' });
  });

  it('refuses a ledger with a foreign application ID even at a known version', async () => {
    const { state, file } = await closedLedger();
    rewrite(file, 'PRAGMA application_id = 7');
    expect(await openError(state, 'existing')).toBe('corrupt');
  });

  it('refuses a ledger with our application ID but no schema version', async () => {
    const { state, file } = await closedLedger();
    rewrite(file, 'PRAGMA user_version = 0');
    expect(await openError(state, 'existing')).toBe('corrupt');
    rewrite(file, `PRAGMA user_version = ${SCHEMA_VERSION}; PRAGMA application_id = ${APPLICATION_ID}`);
    await open(state, 'existing');
  });

  it('refuses an empty ledger in create mode instead of reinitialising it', async () => {
    const { state } = dirs();
    fs.mkdirSync(state, { mode: 0o700 });
    fs.writeFileSync(path.join(state, LEDGER_FILE), '', { mode: 0o600 });
    expect(await openError(state, 'create')).toBe('corrupt');
    expect(fs.statSync(path.join(state, LEDGER_FILE)).size).toBe(0);
  });

  it('refuses a size cap that is not a usable byte count', async () => {
    const { state } = dirs();
    for (const maxBytes of [0, 1024, 1.5 * 1024 * 1024 + 0.5, Number.NaN]) {
      expect(await openError(state, 'create', maxBytes)).toBe('invalid_input');
    }
    expect(fs.existsSync(state)).toBe(false);
  });

  it('blocks the handle after an identity conflict', async () => {
    const { state } = dirs();
    const storage = await open(state);
    const identity = { deviceId: 'device_connector_b' as DeviceId, fingerprint: 'fp_1' };
    await storage.bindDeviceIdentity(identity);
    expect(await storage.bindDeviceIdentity({ ...identity, fingerprint: 'fp_2' })).toEqual({ kind: 'conflict', code: 'identity_mismatch' });
    await expect(storage.readCursor('s')).rejects.toMatchObject({ code: 'identity_mismatch' });
    await expect(storage.bindDeviceIdentity(identity)).rejects.toMatchObject({ code: 'identity_mismatch' });
    await expect(recoverConnectorStorage(storage)).rejects.toMatchObject({ code: 'identity_mismatch' });
    await storage.close();
    const reopened = await open(state, 'existing');
    expect(await reopened.bindDeviceIdentity(identity)).toEqual({ kind: 'matched' });
  });

  it('refuses a first identity bind on existing state it cannot vouch for', async () => {
    const { state } = dirs();
    const first = await open(state);
    await first.commitCursor({ streamId: 's', expectedRevision: 0, opaqueCursor: 'c' });
    await first.close();
    const identity = { deviceId: 'device_connector_b' as DeviceId, fingerprint: 'fp_1' };
    const reopened = await open(state, 'existing');
    expect(await reopened.bindDeviceIdentity(identity)).toEqual({ kind: 'conflict', code: 'identity_unbound' });
    await expect(reopened.readCursor('s')).rejects.toMatchObject({ code: 'identity_mismatch' });
    await reopened.close();

    // An existing ledger with no state yet (bootstrap interrupted before any write) may still bind.
    const { state: empty } = dirs();
    await (await open(empty)).close();
    expect(await (await open(empty, 'existing')).bindDeviceIdentity(identity)).toEqual({ kind: 'bound' });
  });

  it('reports a structurally damaged ledger as an integrity failure', async () => {
    const { state, file } = await closedLedger();
    const db = new DatabaseSync(file);
    // `commands` is a table recovery never reads, so only quick_check can notice.
    const { rootpage } = db.prepare("SELECT rootpage FROM sqlite_schema WHERE name = 'commands'").get() as { rootpage: number };
    const { page_size: pageSize } = db.prepare('PRAGMA page_size').get() as { page_size: number };
    db.close();
    // Claim far more cells than the empty leaf page can hold.
    const fd = fs.openSync(file, 'r+');
    fs.writeSync(fd, Buffer.from([0xff, 0xff]), 0, 2, (rootpage - 1) * pageSize + 3);
    fs.closeSync(fd);

    const reopened = await open(state, 'existing');
    expect((await recoverConnectorStorage(reopened)).blocked).toContain('integrity_failed');
  });
});
