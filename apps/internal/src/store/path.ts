import fs from 'node:fs';
import path from 'node:path';
import { StoreError } from './errors';

export const ROOM_DATABASE_FILE = 'room.sqlite';
export const SQLITE_COMPANION_SUFFIXES = ['-wal', '-shm', '-journal'] as const;

export type OpenMode = 'create' | 'existing';
export type FileIdentity = Readonly<{ dev: number; ino: number }>;

export type PreparedStorePath = Readonly<{
  file: string;
  identity: FileIdentity;
  created: boolean;
  header: Buffer | null;
}>;

function currentUid(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

function lstatOrNull(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new StoreError('io_failed');
  }
}

function isOwnedByCurrentUser(stats: fs.Stats): boolean {
  const uid = currentUid();
  return uid === null || stats.uid === uid;
}

function assertOwnerFile(target: string): void {
  const stats = lstatOrNull(target);
  if (stats === null) return;
  if (!stats.isFile() || stats.nlink !== 1 || !isOwnedByCurrentUser(stats) || (stats.mode & 0o777) !== 0o600) {
    throw new StoreError('unsafe_path');
  }
}

const STICKY = 0o1000;

function assertSafeAncestors(directory: string, mode: OpenMode): void {
  const uid = currentUid();
  for (let current = path.dirname(directory); ; current = path.dirname(current)) {
    const stats = lstatOrNull(current);
    if (stats === null) throw new StoreError(mode === 'existing' ? 'missing_state' : 'io_failed');
    if (!stats.isDirectory()) throw new StoreError('unsafe_path');
    if (uid !== null) {
      const sticky = (stats.mode & STICKY) !== 0;
      // Every non-sticky ancestor must prevent other users from renaming its
      // entries, including users that share this process's primary group.
      if (!sticky && (stats.mode & 0o022) !== 0) throw new StoreError('unsafe_path');
    }
    if (current === path.dirname(current)) return;
  }
}

function pinFile(target: string): Readonly<{ identity: FileIdentity; size: number; header: Buffer }> {
  let descriptor: number;
  try {
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new StoreError(code === 'ELOOP' || code === 'EMLINK' ? 'unsafe_path' : 'io_failed');
  }
  try {
    const stats = fs.fstatSync(descriptor);
    if (!stats.isFile() || stats.nlink !== 1 || !isOwnedByCurrentUser(stats) || (stats.mode & 0o777) !== 0o600) {
      throw new StoreError('unsafe_path');
    }
    const header = Buffer.alloc(Math.min(stats.size, 100));
    if (header.length > 0) fs.readSync(descriptor, header, 0, header.length, 0);
    return { identity: { dev: stats.dev, ino: stats.ino }, size: stats.size, header };
  } catch (error) {
    if (error instanceof StoreError) throw error;
    throw new StoreError('io_failed');
  } finally {
    fs.closeSync(descriptor);
  }
}

/** Creates at most one absent inode and pins all existing bytes without SQLite. */
export function prepareStorePath(directory: string, mode: OpenMode): PreparedStorePath {
  const resolved = path.resolve(directory);
  if (!path.isAbsolute(directory) || (resolved !== directory && `${resolved}${path.sep}` !== directory)) {
    throw new StoreError('unsafe_path');
  }
  assertSafeAncestors(resolved, mode);

  let directoryStats = lstatOrNull(resolved);
  if (directoryStats === null) {
    if (mode === 'existing') throw new StoreError('missing_state');
    try {
      fs.mkdirSync(resolved, { mode: 0o700 });
      fs.chmodSync(resolved, 0o700);
    } catch {
      throw new StoreError('io_failed');
    }
    directoryStats = lstatOrNull(resolved);
  }
  if (directoryStats === null || !directoryStats.isDirectory() || !isOwnedByCurrentUser(directoryStats)
    || (directoryStats.mode & 0o777) !== 0o700) throw new StoreError('unsafe_path');

  const database = path.join(resolved, ROOM_DATABASE_FILE);
  assertOwnerFile(database);
  for (const suffix of SQLITE_COMPANION_SUFFIXES) assertOwnerFile(database + suffix);

  let created = false;
  if (lstatOrNull(database) === null) {
    if (mode === 'existing') throw new StoreError('missing_state');
    try {
      const flags = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY
        | (fs.constants.O_NOFOLLOW ?? 0);
      const descriptor = fs.openSync(database, flags, 0o600);
      fs.closeSync(descriptor);
      fs.chmodSync(database, 0o600);
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new StoreError('locked');
      throw new StoreError('io_failed');
    }
  }

  const pinned = pinFile(database);
  if (!created && pinned.size === 0) throw new StoreError('corrupt');
  return { file: database, identity: pinned.identity, created, header: created ? null : pinned.header };
}

const FD_DIRECTORY = '/proc/self/fd';

/** Confirms SQLite opened the inode whose header was inspected. */
export function assertOpenedFile(target: string, expected: FileIdentity): void {
  assertOwnerFile(target);
  let descriptors: readonly string[] | null;
  try {
    descriptors = fs.readdirSync(FD_DIRECTORY);
  } catch {
    descriptors = null;
  }
  if (descriptors === null) {
    const stats = lstatOrNull(target);
    if (stats === null || stats.dev !== expected.dev || stats.ino !== expected.ino) throw new StoreError('unsafe_path');
    return;
  }
  let matched = false;
  for (const descriptor of descriptors) {
    const link = path.join(FD_DIRECTORY, descriptor);
    try {
      if (fs.readlinkSync(link) !== target) continue;
      const stats = fs.statSync(link);
      if (stats.dev !== expected.dev || stats.ino !== expected.ino) throw new StoreError('unsafe_path');
      matched = true;
    } catch (error) {
      if (error instanceof StoreError) throw error;
    }
  }
  if (!matched) throw new StoreError('unsafe_path');
}

/** Rechecks companions after WAL selection and fixes freshly-created modes explicitly. */
export function secureStoreFiles(database: string): void {
  for (const target of [database, ...SQLITE_COMPANION_SUFFIXES.map(suffix => database + suffix)]) {
    const stats = lstatOrNull(target);
    if (stats === null) continue;
    if (!stats.isFile() || stats.nlink !== 1 || !isOwnedByCurrentUser(stats)) throw new StoreError('unsafe_path');
    try {
      fs.chmodSync(target, 0o600);
    } catch {
      throw new StoreError('io_failed');
    }
  }
}
