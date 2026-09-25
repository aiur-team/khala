import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PrivateFileError, ensurePrivateDirectory } from '../descriptor/write';

// One active internal launcher per OS user. The lease is an exclusive SQLite
// lock on a fixed 0600 file below the private root: the operating system drops
// it when the owning process exits for any reason, so a crash never leaves a
// stale lease behind and no PID is ever trusted or signalled.

export const ROOT_LEASE_FILE = 'runtime.lock';

export type RootLease = Readonly<{
  /** Idempotent; releases the lock by closing the only connection. */
  release(): void;
}>;

export type RootLeaseResult =
  | Readonly<{ kind: 'acquired'; lease: RootLease }>
  | Readonly<{ kind: 'held' }>
  | Readonly<{ kind: 'failed'; code: 'unsafe_path' | 'io_failed' }>;

function currentUid(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

/** Creates the lease file if absent and checks it is a private regular file. */
function prepareLeaseFile(file: string): void {
  const flags = fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW;
  let descriptor: number;
  try {
    descriptor = fs.openSync(file, flags, 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new PrivateFileError(code === 'ELOOP' ? 'unsafe_path' : 'io_failed');
  }
  try {
    const stats = fs.fstatSync(descriptor);
    const uid = currentUid();
    if (!stats.isFile() || stats.nlink !== 1 || (uid !== null && stats.uid !== uid) || (stats.mode & 0o077) !== 0) {
      throw new PrivateFileError('unsafe_path');
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function isBusy(error: unknown): boolean {
  const message = error instanceof Error ? error.message : '';
  return /database is locked|SQLITE_BUSY/i.test(message) || (error as { errcode?: number }).errcode === 5;
}

/** Tries once, without waiting, to take the per-user root lease. */
export function acquireRootLease(root: string): RootLeaseResult {
  const file = path.join(root, ROOT_LEASE_FILE);
  try {
    ensurePrivateDirectory(root);
    prepareLeaseFile(file);
  } catch (error) {
    return { kind: 'failed', code: error instanceof PrivateFileError ? error.code : 'io_failed' };
  }
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(file, { allowExtension: false });
  } catch {
    return { kind: 'failed', code: 'io_failed' };
  }
  try {
    db.exec('PRAGMA busy_timeout = 0');
    db.exec('PRAGMA locking_mode = EXCLUSIVE');
    // A write under EXCLUSIVE locking mode keeps the lock until the connection closes.
    db.exec('BEGIN EXCLUSIVE');
    db.exec('CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY CHECK (id = 1))');
    db.exec('COMMIT');
  } catch (error) {
    try { db.close(); } catch {}
    return isBusy(error) ? { kind: 'held' } : { kind: 'failed', code: 'io_failed' };
  }
  let held = true;
  return {
    kind: 'acquired',
    lease: {
      release() {
        if (!held) return;
        held = false;
        try { db.close(); } catch {}
      },
    },
  };
}
