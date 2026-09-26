import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  INTERNAL_ACTIVE_DESCRIPTOR_FILE, type InternalDescriptor, encodeInternalDescriptor, isInternalCapability,
  isInternalIdentifier, isLoopbackOrigin,
} from '@khala/contracts/internal/descriptor';

// Owner-private runtime files. Every write goes to a synced 0600 sibling created
// with O_EXCL|O_NOFOLLOW, is renamed over the target, and the parent directory is
// synced, so a reader sees the old bytes or the new bytes and never a mixture.

export const LAUNCH_RECORD_FILE = 'launch.json';

/** Local human bootstrap record kept below the 0700 channel directory. */
export type LaunchRecord = Readonly<{
  v: 1;
  channelId: string;
  origin: string;
  bootstrapCredential: string;
  /** Epoch milliseconds after which the bootstrap credential is unusable. */
  expiresAt: number;
}>;

export class PrivateFileError extends Error {
  readonly code: 'unsafe_path' | 'io_failed';
  constructor(code: PrivateFileError['code']) {
    // Paths and contents stay out of the message.
    super(`private runtime file: ${code}`);
    this.name = 'PrivateFileError';
    this.code = code;
  }
}

/** Test-only interruption after the temporary is synced and before it is published. */
export type WriteFault = (stage: 'before_rename') => void;

function currentUid(): number | null {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

function lstatOrNull(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new PrivateFileError('io_failed');
  }
}

function owned(stats: fs.Stats): boolean {
  const uid = currentUid();
  return uid === null || stats.uid === uid;
}

function syncDirectory(directory: string): void {
  let descriptor: number;
  try {
    descriptor = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  } catch {
    throw new PrivateFileError('io_failed');
  }
  try { fs.fsyncSync(descriptor); } catch { throw new PrivateFileError('io_failed'); } finally { fs.closeSync(descriptor); }
}

/** Requires (creating when absent) a real 0700 directory owned by this user. */
export function ensurePrivateDirectory(directory: string): void {
  if (!path.isAbsolute(directory) || path.resolve(directory) !== directory) throw new PrivateFileError('unsafe_path');
  if (lstatOrNull(directory) === null) {
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new PrivateFileError('io_failed');
    }
  }
  const stats = lstatOrNull(directory);
  if (stats === null || stats.isSymbolicLink() || !stats.isDirectory() || !owned(stats) || (stats.mode & 0o777) !== 0o700) {
    throw new PrivateFileError('unsafe_path');
  }
}

function assertReplaceable(target: string): void {
  const stats = lstatOrNull(target);
  if (stats !== null && (!stats.isFile() || !owned(stats))) throw new PrivateFileError('unsafe_path');
}

/** Atomically replaces `<directory>/<name>` with `text` at mode 0600. */
export function writePrivateFile(directory: string, name: string, text: string, fault?: WriteFault): void {
  ensurePrivateDirectory(directory);
  const target = path.join(directory, name);
  assertReplaceable(target);
  const temporary = path.join(directory, `.${name}.${randomBytes(9).toString('base64url')}.tmp`);
  const flags = fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW;
  let descriptor: number;
  try {
    descriptor = fs.openSync(temporary, flags, 0o600);
  } catch {
    throw new PrivateFileError('io_failed');
  }
  let published = false;
  try {
    try {
      fs.fchmodSync(descriptor, 0o600);
      fs.writeFileSync(descriptor, text, 'utf8');
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fault?.('before_rename');
    fs.renameSync(temporary, target);
    published = true;
  } catch (error) {
    if (error instanceof PrivateFileError) throw error;
    throw new PrivateFileError('io_failed');
  } finally {
    if (!published) try { fs.unlinkSync(temporary); } catch {}
  }
  syncDirectory(directory);
}

/** Removes `<directory>/<name>` if present; a non-file entry is refused, never followed. */
export function removePrivateFile(directory: string, name: string): boolean {
  const target = path.join(directory, name);
  const stats = lstatOrNull(target);
  if (stats === null) return false;
  if (stats.isDirectory()) throw new PrivateFileError('unsafe_path');
  try {
    fs.unlinkSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw new PrivateFileError('io_failed');
  }
  syncDirectory(directory);
  return true;
}

export function activeDescriptorPath(root: string): string {
  return path.join(root, INTERNAL_ACTIVE_DESCRIPTOR_FILE);
}

/** Publishes the stable root runtime descriptor; invalid state is refused before any I/O. */
export function writeActiveDescriptor(root: string, descriptor: InternalDescriptor, fault?: WriteFault): void {
  writePrivateFile(root, INTERNAL_ACTIVE_DESCRIPTOR_FILE, encodeInternalDescriptor(descriptor), fault);
}

export function removeActiveDescriptor(root: string): boolean {
  return removePrivateFile(root, INTERNAL_ACTIVE_DESCRIPTOR_FILE);
}

export function encodeLaunchRecord(record: LaunchRecord): string {
  if (record.v !== 1 || !isInternalIdentifier(record.channelId) || !isLoopbackOrigin(record.origin)
    || !isInternalCapability(record.bootstrapCredential) || !Number.isSafeInteger(record.expiresAt) || record.expiresAt <= 0) {
    throw new TypeError('launch record: invalid');
  }
  return `${JSON.stringify({
    v: 1, channelId: record.channelId, origin: record.origin,
    bootstrapCredential: record.bootstrapCredential, expiresAt: record.expiresAt,
  })}\n`;
}

export function writeLaunchRecord(channelDirectory: string, record: LaunchRecord, fault?: WriteFault): void {
  writePrivateFile(channelDirectory, LAUNCH_RECORD_FILE, encodeLaunchRecord(record), fault);
}

export function removeLaunchRecord(channelDirectory: string): boolean {
  return removePrivateFile(channelDirectory, LAUNCH_RECORD_FILE);
}
