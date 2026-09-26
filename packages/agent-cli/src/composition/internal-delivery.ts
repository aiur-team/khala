import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { type GrantedDescriptor, isGrantedDescriptor } from '@khala/contracts/internal/descriptor';
import type { BatchInbox } from '../cli/inbox.js';
import type { InboxDelivery } from '../cli/types.js';
import { exactKeys, plainObject, validDigest, validEventRef, validIdentifier, validUtcTimestamp } from '../cli/validation.js';
import { type DescriptorRead, readInternalDescriptor } from './internal.js';

// Moves the local internal server's releases for one held binding generation into
// that generation's on-disk inbox, where `khala read`, `listen`, MCP and the hooks
// already look. The server's pull route is the only source: each page is fenced
// on the exact binding generation it names, every release is enqueued by its
// release ID, and the pull cursor is committed only after the whole page is
// durable. A crash between the two re-pulls the same page, and the inbox answers
// `duplicate` for every release it already holds.
//
// A release may hint the harness only when the server marks it `wake`: never in
// `async`, never while paused (the server then holds the page), and never after
// the binding stops being the live generation, which the server refuses outright.
// Nothing here writes a message body, capability, or cursor to any output.

export type HeldGeneration = Readonly<{ bindingId: string; generation: number }>;

export type PullOutcome =
  /** Every release available now is durable in the inbox. */
  | 'caught_up'
  /** The server holds this binding's releases (pause or unreadable mode). */
  | 'held'
  /** Another process is pulling for this binding generation right now. */
  | 'busy'
  /** The binding generation is no longer live, or the descriptor no longer names it. */
  | 'revoked'
  | 'unavailable';

export type InternalDeliveryOptions = Readonly<{
  descriptorPath: string;
  /** Private Khala state root; pull cursors live under `internal-delivery/`. */
  stateDirectory: string;
  fetch?: typeof globalThis.fetch;
  readDescriptor?: (file: string) => DescriptorRead;
  timeoutMs?: number;
  pageLimit?: number;
  /** Bounds one pull so a busy channel cannot starve the caller. */
  maxPages?: number;
  /** Test seam: runs after a page is durable in the inbox and before its cursor commits. */
  beforeCursorCommit?: () => Promise<void> | void;
}>;

export type InternalDelivery = Readonly<{
  /**
   * Pulls releases for exactly `held` into a freshly opened inbox. `openInbox` is
   * called under the pull lock, so its duplicate index includes every earlier pull.
   */
  pull(held: HeldGeneration, openInbox: () => Promise<BatchInbox>, signal?: AbortSignal): Promise<PullOutcome>;
}>;

const DELIVERY_DIRECTORY = 'internal-delivery';
const CURSOR_FILE = 'cursor.json';
const LOCK_FILE = 'pull.lock';
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_CURSOR_BYTES = 512;
const RELEASE_KEYS = ['releaseId', 'events', 'payloadDigest', 'payloadBase64', 'releasedAt', 'wake'];
const PAGE_KEYS = ['v', 'binding', 'releases', 'nextCursor', 'caughtUp', 'held'];

type Release = Readonly<{ delivery: InboxDelivery; wake: boolean }>;
type Page =
  | Readonly<{ kind: 'page'; releases: readonly Release[]; nextCursor: string | null; caughtUp: boolean }>
  | Readonly<{ kind: 'held' }>
  | Readonly<{ kind: 'revoked' }>
  | Readonly<{ kind: 'unavailable' }>;

export function createInternalDelivery(options: InternalDeliveryOptions): InternalDelivery {
  const fetcher = options.fetch ?? globalThis.fetch;
  const readDescriptor = options.readDescriptor ?? readInternalDescriptor;
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const pageLimit = options.pageLimit ?? 50;
  const maxPages = options.maxPages ?? 20;

  async function fetchPage(
    descriptor: GrantedDescriptor, held: HeldGeneration, cursor: string | null, signal: AbortSignal | undefined,
  ): Promise<Page> {
    const query = new URLSearchParams({ limit: String(pageLimit) });
    if (cursor !== null) query.set('cursor', cursor);
    const target = `/api/v1/channels/${encodeURIComponent(descriptor.channelId)}/releases?${query}`;
    const timeout = AbortSignal.timeout(timeoutMs);
    let status: number;
    let text: string;
    try {
      const response = await fetcher(new URL(target, descriptor.origin), {
        method: 'GET',
        // A redirect would carry the capability off the exact loopback origin.
        redirect: 'error',
        headers: { authorization: `Bearer ${descriptor.bindingCapability}` },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      status = response.status;
      text = await response.text();
    } catch {
      return { kind: 'unavailable' };
    }
    if (status === 401 || status === 403) return { kind: 'revoked' };
    if (status !== 200 || Buffer.byteLength(text) > MAX_RESPONSE_BYTES) return { kind: 'unavailable' };
    let body: unknown;
    try { body = JSON.parse(text); } catch { return { kind: 'unavailable' }; }
    return decodePage(body, held);
  }

  return {
    async pull(held, openInbox, signal) {
      const descriptor = currentGrant(readDescriptor, options.descriptorPath, held);
      if (descriptor === 'unavailable') return 'unavailable';
      if (descriptor === 'revoked') return 'revoked';
      let directory: string;
      try { directory = await deliveryDirectory(options.stateDirectory, descriptor.channelId, held); }
      catch { return 'unavailable'; }
      const lock = await acquirePullLock(path.join(directory, LOCK_FILE));
      if (lock === 'busy') return 'busy';
      if (lock === 'unavailable') return 'unavailable';
      try {
        const inbox = await openInbox();
        const cursorFile = path.join(directory, CURSOR_FILE);
        let cursor = await readCursor(cursorFile);
        if (cursor === 'unavailable') return 'unavailable';
        for (let pages = 0; pages < maxPages; pages += 1) {
          if (signal?.aborted) return 'unavailable';
          const page = await fetchPage(descriptor, held, cursor, signal);
          if (page.kind !== 'page') return page.kind;
          let wake = false;
          for (const release of page.releases) {
            // Keyed by release ID: an identical record already durable is `duplicate`.
            const appended = await inbox.enqueue(release.delivery);
            if (appended === 'appended' && release.wake) wake = true;
          }
          await options.beforeCursorCommit?.();
          if (page.nextCursor !== null && page.nextCursor !== cursor) {
            await writeCursor(cursorFile, directory, page.nextCursor);
            cursor = page.nextCursor;
          }
          // The hint names only the binding generation and a reason, never a release.
          if (wake) await inbox.notifyListener('released').catch(() => 'unavailable' as const);
          if (page.caughtUp) return 'caught_up';
        }
        return 'caught_up';
      } catch {
        return 'unavailable';
      } finally {
        await lock.release();
      }
    },
  };
}

/** The descriptor must still hold a grant for exactly `held`; the file is reread on every pull. */
function currentGrant(
  readDescriptor: (file: string) => DescriptorRead, file: string, held: HeldGeneration,
): GrantedDescriptor | 'revoked' | 'unavailable' {
  const read = readDescriptor(file);
  if (!read.ok) return 'unavailable';
  if (!isGrantedDescriptor(read.value) || read.value.bindingId !== held.bindingId) return 'revoked';
  return read.value;
}

function decodePage(body: unknown, held: HeldGeneration): Page {
  const invalid = { kind: 'unavailable' } as const;
  if (!plainObject(body) || !exactKeys(body, PAGE_KEYS) || body.v !== 1 || !plainObject(body.binding)) return invalid;
  // A page computed for any other binding generation is never enqueued here.
  if (body.binding.bindingId !== held.bindingId || body.binding.generation !== held.generation) return { kind: 'revoked' };
  if (body.held !== null) return body.held === 'paused' || body.held === 'mode_unavailable' ? { kind: 'held' } : invalid;
  if (typeof body.caughtUp !== 'boolean' || !Array.isArray(body.releases)
    || !(body.nextCursor === null || validCursor(body.nextCursor))) return invalid;
  const releases: Release[] = [];
  for (const value of body.releases) {
    const release = decodeRelease(value, held);
    if (release === null) return invalid;
    releases.push(release);
  }
  return { kind: 'page', releases, nextCursor: body.nextCursor, caughtUp: body.caughtUp };
}

function decodeRelease(value: unknown, held: HeldGeneration): Release | null {
  if (!plainObject(value) || !exactKeys(value, RELEASE_KEYS) || !validIdentifier(value.releaseId)
    || !Array.isArray(value.events) || value.events.length === 0 || !value.events.every(validEventRef)
    || !validDigest(value.payloadDigest) || typeof value.payloadBase64 !== 'string'
    || !validUtcTimestamp(value.releasedAt) || typeof value.wake !== 'boolean') return null;
  const payload = Buffer.from(value.payloadBase64, 'base64');
  if (payload.toString('base64') !== value.payloadBase64) return null;
  return {
    wake: value.wake,
    delivery: {
      v: 1,
      releaseId: value.releaseId,
      bindingId: held.bindingId as InboxDelivery['bindingId'],
      generation: held.generation,
      events: value.events,
      payloadDigest: value.payloadDigest,
      payload: new Uint8Array(payload),
      // The server's release time, so a re-pulled record is byte-identical.
      receivedAt: value.releasedAt,
    },
  };
}

function validCursor(value: unknown): value is string {
  return typeof value === 'string' && /^[\x21-\x7e]+$/.test(value) && value.length <= MAX_CURSOR_BYTES;
}

async function deliveryDirectory(stateDirectory: string, channelId: string, held: HeldGeneration): Promise<string> {
  if (!path.isAbsolute(stateDirectory)) throw new Error('state directory');
  const root = path.join(stateDirectory, DELIVERY_DIRECTORY);
  const directory = path.join(root, createHash('sha256')
    .update(JSON.stringify([channelId, held.bindingId, held.generation])).digest('base64url'));
  for (const each of [stateDirectory, root, directory]) {
    await fsp.mkdir(each, { recursive: true, mode: 0o700 });
    const stats = await fsp.lstat(each);
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (!stats.isDirectory() || (uid !== null && stats.uid !== uid)) throw new Error('state directory');
    if (each !== stateDirectory && (stats.mode & 0o077) !== 0) await fsp.chmod(each, 0o700);
  }
  return directory;
}

async function readCursor(file: string): Promise<string | null | 'unavailable'> {
  let text: string;
  try {
    text = await fsp.readFile(file, { encoding: 'utf8', flag: fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) });
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : 'unavailable';
  }
  try {
    const value: unknown = JSON.parse(text);
    if (plainObject(value) && exactKeys(value, ['v', 'cursor']) && value.v === 1 && validCursor(value.cursor)) return value.cursor;
  } catch { /* Corrupt state is unavailable, never a restart from the beginning. */ }
  return 'unavailable';
}

async function writeCursor(file: string, directory: string, cursor: string): Promise<void> {
  const temporary = path.join(directory, `.cursor-${randomUUID()}.tmp`);
  try {
    const handle = await fsp.open(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    try {
      await handle.writeFile(`${JSON.stringify({ v: 1, cursor })}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsp.rename(temporary, file);
    const parent = await fsp.open(directory, fs.constants.O_RDONLY);
    try { await parent.sync(); } finally { await parent.close(); }
  } finally {
    await fsp.unlink(temporary).catch(() => undefined);
  }
}

type PullLock = Readonly<{ release(): Promise<void> }>;

/**
 * One puller per binding generation across processes, so the inbox's duplicate
 * index is never stale when a release is appended. A lock left by a dead process
 * is moved aside under a unique name and removed only if it is still that one.
 */
async function acquirePullLock(file: string): Promise<PullLock | 'busy' | 'unavailable'> {
  const token = `${process.pid}:${randomUUID()}`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fsp.open(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY
        | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
      try { await handle.writeFile(token, 'utf8'); } finally { await handle.close(); }
      return {
        async release() {
          const current = await fsp.readFile(file, 'utf8').catch(() => null);
          if (current === token) await fsp.unlink(file).catch(() => undefined);
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return 'unavailable';
    }
    const holder = await fsp.readFile(file, 'utf8').catch(() => null);
    if (holder === null) continue;
    if (processIsLive(Number(holder.split(':')[0]))) return 'busy';
    const aside = `${file}.stale-${randomUUID()}`;
    try { await fsp.rename(file, aside); } catch { continue; }
    const moved = await fsp.readFile(aside, 'utf8').catch(() => null);
    if (moved !== holder) {
      // Another process replaced the stale lock first: put its lock back.
      await fsp.link(aside, file).catch(() => undefined);
      await fsp.unlink(aside).catch(() => undefined);
      return 'busy';
    }
    await fsp.unlink(aside).catch(() => undefined);
  }
  return 'busy';
}

function processIsLive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
