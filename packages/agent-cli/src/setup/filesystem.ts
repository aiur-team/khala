// Root-confined, no-follow filesystem primitives for the setup executor. Every target
// must sit lexically inside a declared root, and no component below that root may be a
// symbolic link. Reads and writes open with O_NOFOLLOW, and every replacement rechecks
// the target's identity and hash immediately before the rename, so a swapped path or a
// concurrent edit is refused rather than overwritten.
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Sha256Digest } from './types.js';

const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

export type SetupFilesystemErrorCode =
  | 'unsafe_path' | 'not_regular_file' | 'precondition_failed' | 'postimage_mismatch' | 'storage_failed';

export class SetupFilesystemError extends Error {
  constructor(readonly code: SetupFilesystemErrorCode, readonly target: string) {
    super(`${code}: ${target}`);
    this.name = 'SetupFilesystemError';
  }
}

export function sha256(bytes: Uint8Array): Sha256Digest {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** A present file's identity. `null` stands for an absent file everywhere in the executor. */
export type FileObservation = Readonly<{
  hash: Sha256Digest; dev: number; ino: number; mode: number; uid: number; bytes: Uint8Array;
}>;

const errno = (error: unknown) => (error as NodeJS.ErrnoException | null)?.code;
const currentUid = () => (typeof process.getuid === 'function' ? process.getuid() : null);

export class ConfinedFilesystem {
  readonly #roots: readonly string[];

  constructor(roots: readonly string[]) {
    if (roots.length === 0 || roots.some(root => !path.isAbsolute(root))) throw new SetupFilesystemError('unsafe_path', String(roots));
    this.#roots = roots.map(root => path.resolve(root));
  }

  /** The declared root that lexically contains `target`, or a refusal. */
  rootOf(target: string): string {
    if (!path.isAbsolute(target) || path.resolve(target) !== target) throw new SetupFilesystemError('unsafe_path', target);
    const root = this.#roots
      .filter(candidate => target === candidate || target.startsWith(candidate + path.sep))
      .sort((a, b) => b.length - a.length)[0];
    if (root === undefined || root === target) throw new SetupFilesystemError('unsafe_path', target);
    return root;
  }

  /**
   * Refuses a target outside every root, or one with a symbolic link (or a non-directory
   * parent) anywhere below its root. Absent trailing components are allowed.
   */
  async assertSafe(target: string): Promise<void> {
    const root = this.rootOf(target);
    const parts = path.relative(root, target).split(path.sep);
    let current = root;
    for (const [index, part] of parts.entries()) {
      current = path.join(current, part);
      let stat: fs.Stats;
      try {
        stat = await fsp.lstat(current);
      } catch (error) {
        if (errno(error) === 'ENOENT') return;
        throw new SetupFilesystemError('storage_failed', target);
      }
      if (stat.isSymbolicLink()) throw new SetupFilesystemError('unsafe_path', target);
      const last = index === parts.length - 1;
      if (!last && !stat.isDirectory()) throw new SetupFilesystemError('unsafe_path', target);
    }
  }

  /** Reads a regular file without following links; `null` when absent. */
  async observe(target: string): Promise<FileObservation | null> {
    await this.assertSafe(target);
    let handle: fsp.FileHandle;
    try {
      // O_NONBLOCK keeps a FIFO planted at the target from hanging the open; it is refused below.
      handle = await fsp.open(target, fs.constants.O_RDONLY | NOFOLLOW | (fs.constants.O_NONBLOCK ?? 0));
    } catch (error) {
      if (errno(error) === 'ENOENT') return null;
      if (errno(error) === 'ELOOP') throw new SetupFilesystemError('unsafe_path', target);
      throw new SetupFilesystemError('storage_failed', target);
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new SetupFilesystemError('not_regular_file', target);
      const bytes = new Uint8Array(await handle.readFile());
      return { hash: sha256(bytes), dev: stat.dev, ino: stat.ino, mode: stat.mode & 0o7777, uid: stat.uid, bytes };
    } catch (error) {
      if (error instanceof SetupFilesystemError) throw error;
      throw new SetupFilesystemError('storage_failed', target);
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async hashOf(target: string): Promise<Sha256Digest | null> {
    return (await this.observe(target))?.hash ?? null;
  }

  /** Parent directories of `target` below its root that do not exist yet, outermost first. */
  async missingDirectories(target: string): Promise<string[]> {
    await this.assertSafe(target);
    const root = this.rootOf(target);
    const missing: string[] = [];
    for (let directory = path.dirname(target); directory !== root && directory.startsWith(root); directory = path.dirname(directory)) {
      try {
        await fsp.lstat(directory);
        break;
      } catch (error) {
        if (errno(error) !== 'ENOENT') throw new SetupFilesystemError('storage_failed', target);
        missing.unshift(directory);
      }
    }
    return missing;
  }

  /** Creates each listed directory (outermost first) owner-only; an existing entry is refused. */
  async createDirectories(directories: readonly string[]): Promise<void> {
    for (const directory of directories) {
      await this.assertSafe(directory);
      try {
        await fsp.mkdir(directory, { mode: 0o700 });
      } catch (error) {
        if (errno(error) === 'EEXIST') {
          const stat = await fsp.lstat(directory);
          if (stat.isDirectory() && !stat.isSymbolicLink()) continue;
          throw new SetupFilesystemError('unsafe_path', directory);
        }
        throw new SetupFilesystemError('storage_failed', directory);
      }
    }
  }

  /** Removes the listed directories innermost first, keeping any that are not empty. */
  async removeEmptyDirectories(directories: readonly string[]): Promise<void> {
    for (const directory of [...directories].sort((a, b) => b.length - a.length)) {
      await this.assertSafe(directory);
      try {
        await fsp.rmdir(directory);
      } catch (error) {
        if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(errno(error) ?? '')) throw new SetupFilesystemError('storage_failed', directory);
      }
    }
  }

  /** Throws unless the target is exactly `expected` (a hash, or `null` for absent). */
  async expect(target: string, expected: Sha256Digest | null): Promise<FileObservation | null> {
    const current = await this.observe(target);
    if ((current?.hash ?? null) !== expected) throw new SetupFilesystemError('precondition_failed', target);
    return current;
  }

  /**
   * Atomically moves the target from `expected` to `bytes` with `mode`. The temporary file
   * lives beside the target; an absent `expected` publishes with link(2), which refuses an
   * entry that appeared meanwhile, and a present one rechecks identity right before rename.
   */
  async replace(target: string, expected: Sha256Digest | null, bytes: Uint8Array, mode: number): Promise<void> {
    const before = await this.expect(target, expected);
    const parent = await directoryIdentity(path.dirname(target));
    const temporary = path.join(path.dirname(target), `.khala-${randomUUID()}.tmp`);
    let handle: fsp.FileHandle | null = null;
    try {
      handle = await fsp.open(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | NOFOLLOW, 0o600);
      await handle.writeFile(bytes);
      await handle.chmod(mode);
      await handle.sync();
      await handle.close();
      handle = null;
      // Re-verify the whole path right before publishing: a parent swapped for a link (or
      // another directory) since the preflight check must not receive the file.
      await this.assertSafe(target);
      const now = await directoryIdentity(path.dirname(target));
      if (now.dev !== parent.dev || now.ino !== parent.ino) throw new SetupFilesystemError('unsafe_path', target);
      if (before === null) {
        await fsp.link(temporary, target).catch(error => {
          throw new SetupFilesystemError(errno(error) === 'EEXIST' ? 'precondition_failed' : 'storage_failed', target);
        });
      } else {
        const now = await this.expect(target, expected);
        if (now === null || now.dev !== before.dev || now.ino !== before.ino) throw new SetupFilesystemError('precondition_failed', target);
        await fsp.rename(temporary, target);
      }
      await syncDirectory(path.dirname(target));
    } catch (error) {
      if (error instanceof SetupFilesystemError) throw error;
      throw new SetupFilesystemError('storage_failed', target);
    } finally {
      await handle?.close().catch(() => undefined);
      await fsp.unlink(temporary).catch(() => undefined);
    }
  }

  /** Deletes the target only while it still hashes to `expected`. */
  async remove(target: string, expected: Sha256Digest): Promise<void> {
    const before = await this.expect(target, expected);
    const now = await fsp.lstat(target).catch(() => null);
    if (before === null || now === null || now.isSymbolicLink() || now.dev !== before.dev || now.ino !== before.ino) {
      throw new SetupFilesystemError('precondition_failed', target);
    }
    try {
      await fsp.unlink(target);
      await syncDirectory(path.dirname(target));
    } catch {
      throw new SetupFilesystemError('storage_failed', target);
    }
  }

  /** Moves the target to exactly `bytes` (or absence) from whatever it holds now. Used for private state files. */
  async write(target: string, bytes: Uint8Array | null, mode = 0o600): Promise<void> {
    const current = await this.observe(target);
    if (bytes === null) {
      if (current !== null) await this.remove(target, current.hash);
      return;
    }
    await this.replace(target, current?.hash ?? null, bytes, mode);
  }

  /** Verifies a postimage: hash, regular file, exact mode, and (where supported) owner. */
  async verify(target: string, expected: Sha256Digest | null, mode: number | null): Promise<void> {
    const current = await this.observe(target).catch(() => null);
    if ((current?.hash ?? null) !== expected) throw new SetupFilesystemError('postimage_mismatch', target);
    if (current === null) return;
    const uid = currentUid();
    if ((mode !== null && current.mode !== mode) || (uid !== null && current.uid !== uid)) {
      throw new SetupFilesystemError('postimage_mismatch', target);
    }
  }

  /** Lists entry names in a directory below a root; `null` when absent. */
  async list(directory: string): Promise<string[] | null> {
    await this.assertSafe(directory);
    try {
      return (await fsp.readdir(directory)).sort();
    } catch (error) {
      if (errno(error) === 'ENOENT') return null;
      throw new SetupFilesystemError('storage_failed', directory);
    }
  }

  /** Recursively deletes a private directory below a root; links inside are removed, never followed. */
  async removeTree(directory: string): Promise<void> {
    await this.assertSafe(directory);
    await fsp.rm(directory, { recursive: true, force: true }).catch(() => {
      throw new SetupFilesystemError('storage_failed', directory);
    });
  }
}

async function directoryIdentity(directory: string): Promise<{ dev: number; ino: number }> {
  const stat = await fsp.lstat(directory).catch(() => null);
  if (stat === null || !stat.isDirectory()) throw new SetupFilesystemError('unsafe_path', directory);
  return { dev: stat.dev, ino: stat.ino };
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fsp.open(directory, fs.constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
