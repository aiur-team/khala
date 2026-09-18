// Exclusive ownership of one connector's local state. The state directory and ledger
// files must be owner-only and never symlinks. The lock is SQLite's EXCLUSIVE locking
// mode, an OS advisory lock the kernel drops when the holding process dies, so a
// crashed owner never leaves a PID file that a later opener has to trust or guess
// about. An open epoch, bumped by every successful open, fences mutations made through
// a handle whose ownership has lapsed.
//
// File modes protect against other local users only. An unrestricted tool running as
// the same OS user can read this state; prefer a separate privilege boundary when the
// runtime provides one.

import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { StorageError, toStorageError } from './errors';

export const LEDGER_FILE = 'ledger.sqlite';
/** SQLite companion files that must obey the same rules as the ledger itself. */
const COMPANION_SUFFIXES = ['-wal', '-shm', '-journal'] as const;

export type OpenMode = 'create' | 'existing';

const uid = typeof process.getuid === 'function' ? process.getuid() : null;

function lstatOrNull(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new StorageError('io_failed');
  }
}

/** Owner-only where the platform reports POSIX ownership; otherwise best effort. */
function ownerOnly(stats: fs.Stats): boolean {
  if (uid === null) return true;
  return stats.uid === uid && (stats.mode & 0o077) === 0;
}

function checkFile(target: string): void {
  const stats = lstatOrNull(target);
  if (stats === null) return;
  // A hard link would let another path observe or replace the ledger's bytes.
  if (!stats.isFile() || stats.nlink !== 1 || !ownerOnly(stats)) throw new StorageError('unsafe_path');
}

/**
 * Validates (and in `create` mode, creates) the state directory and ledger file.
 * Returns the ledger path. Never follows a symlink at the directory or file level.
 */
export function prepareStatePath(directory: string, mode: OpenMode): string {
  // Only an absolute path with no `.`/`..` segments; a relative path would depend on cwd.
  const dir = path.resolve(directory);
  if (!path.isAbsolute(directory) || (dir !== directory && `${dir}${path.sep}` !== directory)) {
    throw new StorageError('unsafe_path');
  }

  let stats = lstatOrNull(dir);
  if (stats === null) {
    if (mode === 'existing') throw new StorageError('missing_state');
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
      // mkdir applies the umask; set the intended mode explicitly.
      fs.chmodSync(dir, 0o700);
    } catch {
      throw new StorageError('io_failed');
    }
    stats = lstatOrNull(dir);
  }
  if (stats === null || !stats.isDirectory() || !ownerOnly(stats)) throw new StorageError('unsafe_path');
  // No symlinked ancestor either: the state must live exactly where it was configured.
  let real: string;
  try {
    real = fs.realpathSync(dir);
  } catch {
    throw new StorageError('io_failed');
  }
  if (real !== dir) throw new StorageError('unsafe_path');

  const ledger = path.join(dir, LEDGER_FILE);
  checkFile(ledger);
  for (const suffix of COMPANION_SUFFIXES) checkFile(ledger + suffix);

  const existing = lstatOrNull(ledger);
  // A created ledger is never empty (switching to WAL writes the header), so an empty
  // one was truncated. Refuse it before SQLite writes into it, leaving it as found.
  if (existing !== null && existing.size === 0 && mode === 'existing') throw new StorageError('corrupt');
  if (existing === null) {
    if (mode === 'existing') throw new StorageError('missing_state');
    try {
      const flags = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0);
      fs.closeSync(fs.openSync(ledger, flags, 0o600));
      fs.chmodSync(ledger, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new StorageError('locked');
      throw new StorageError('io_failed');
    }
  }
  return ledger;
}

export type FileIdentity = Readonly<{ dev: number; ino: number }>;

export function fileIdentity(target: string): FileIdentity {
  const stats = lstatOrNull(target);
  if (stats === null || !stats.isFile()) throw new StorageError('unsafe_path');
  return { dev: stats.dev, ino: stats.ino };
}

/** After open: the file SQLite opened must still be the one that was validated. */
export function assertSameFile(target: string, expected: FileIdentity): void {
  checkFile(target);
  const now = fileIdentity(target);
  if (now.dev !== expected.dev || now.ino !== expected.ino) throw new StorageError('unsafe_path');
}

/**
 * Takes the OS-backed exclusive lock. SQLite keeps it until the connection closes or
 * the process exits; a concurrent opener, in this process or another, fails with
 * `locked` instead of waiting.
 */
export function acquireExclusiveLock(db: DatabaseSync): void {
  try {
    db.exec('PRAGMA busy_timeout = 0');
    db.exec('PRAGMA locking_mode = EXCLUSIVE');
    // In EXCLUSIVE mode WAL uses heap memory instead of a shared-memory file, and the
    // first access below acquires the file lock that the mode then never releases.
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = FULL');
    db.exec('BEGIN EXCLUSIVE');
    db.exec('COMMIT');
  } catch (error) {
    throw toStorageError(error);
  }
}

/** Reads the durable open epoch; mutations compare it with the epoch claimed at open. */
export function readEpoch(db: DatabaseSync): number {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'open_epoch'").get() as { value: string } | undefined;
  return row ? Number(row.value) : 0;
}

/** Bumps the epoch inside the caller's open transaction and returns the new value. */
export function claimEpoch(db: DatabaseSync): number {
  const next = readEpoch(db) + 1;
  db.prepare("INSERT INTO meta (key, value) VALUES ('open_epoch', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    .run(String(next));
  return next;
}

export function assertEpoch(db: DatabaseSync, epoch: number): void {
  if (readEpoch(db) !== epoch) throw new StorageError('fenced');
}
