import * as fs from 'node:fs/promises';
import { watch as watchDirectory, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { InboxEntry } from '@khala/contracts/m1/inbox';
import { readCursor, readEntries } from './inbox';
import { readListeningMode } from './mode';
import { readJson, readStatus, sessionFiles, writeJsonAtomic, SESSION_ID_PATTERN, type SessionFiles } from './state';
import { resolveHarness, resolveSessionId } from './mcp/session-id';

const MARKER = 'monitor.json';
const OBSERVATION = 'monitor-cursor.json';
const NONCE_PATTERN = /^[a-f0-9-]{36}$/;
const leaseFile = (files: SessionFiles, nonce: string) => path.join(files.dir, `monitor-${nonce}.json`);
type Observation = { userId: string; roomId: string; count: number; lastEventId: string | null };
type Owner = { nonce: string; pid: number };
export async function monitorArmed(files: SessionFiles): Promise<boolean> {
  const owner = await readJson<Owner>(path.join(files.dir, MARKER));
  if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.nonce !== 'string' || !NONCE_PATTERN.test(owner.nonce)) return false;
  if ((await readJson<Owner>(leaseFile(files, owner.nonce)))?.nonce !== owner.nonce) return false;
  try { process.kill(owner.pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

export function mentions(entry: InboxEntry, name: string | undefined): boolean {
  if (!name) return false;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\p{L}\\p{N}_])@?${escaped}(?![\\p{L}\\p{N}_])`, 'iu').test(entry.body);
}
function channelLabel(name: string): string {
  return Array.from(name.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').trim()).slice(0, 80).join('');
}

/** Observe, never acknowledge: the delivery hook owns the shared inbox cursor. */
export async function watchSession(files: SessionFiles, io: {
  write: (line: string) => void;
  signal: AbortSignal;
}): Promise<number> {
  const nonce = randomUUID();
  let watcher: FSWatcher | undefined;
  let running: Promise<void> | undefined;
  let dirty = false;
  let done = false;
  let code = 0;
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  const stop = (exit = 0) => { done = true; code = exit; watcher?.close(); finish(); };
  const abort = () => stop();
  try {
    const session = await readJson<{ userId: string; roomId: string }>(files.session);
    const status = await readStatus(files);
    if (!session || typeof session.userId !== 'string' || typeof session.roomId !== 'string'
      || !['connected', 'send_failed'].includes(status?.state ?? '')) return 0;
    const initialDelivered = (await readCursor(files)).deliveredCount;
    const evaluate = async () => {
      const owner = await readJson<Owner>(path.join(files.dir, MARKER));
      const current = await readJson<{ userId: string; roomId: string }>(files.session);
      const status = await readStatus(files);
      if (owner?.nonce !== nonce || current?.userId !== session.userId || current?.roomId !== session.roomId
        || !['connected', 'send_failed'].includes(status?.state ?? '')) { stop(); return; }
      const mode = await readListeningMode(files);
      const entries = await readEntries(files);
      const observed = await readJson<Observation>(path.join(files.dir, OBSERVATION));
      const position = observed?.userId === session.userId && observed?.roomId === session.roomId
        && Number.isSafeInteger(observed.count) && observed.count >= 0 && observed.count <= entries.length
        && (observed.count === 0 || entries[observed.count - 1]?.eventId === observed.lastEventId) ? observed.count : 0;
      const fresh = entries.slice(Math.max(initialDelivered, position));
      // Recheck after disk reads: mode changes, leave and replacement may race intake.
      const latestMode = await readListeningMode(files);
      const latestSession = await readJson<{ userId: string; roomId: string }>(files.session);
      const latestStatus = await readStatus(files);
      const latestOwner = await readJson<Owner>(path.join(files.dir, MARKER));
      if (latestOwner?.nonce !== nonce || latestSession?.userId !== session.userId
        || latestSession?.roomId !== session.roomId || !['connected', 'send_failed'].includes(latestStatus?.state ?? '')) { stop(); return; }
      for (const entry of fresh) {
        if (done || mode === 'async' || latestMode === 'async' || entry.kind !== 'message' || entry.sender === session.userId
          || entry.roomId !== session.roomId) continue;
        const mention = mentions(entry, latestStatus?.displayName);
        // Sync and Steer wake for every peer message; mention metadata is content-free.
        io.write(`khala: 1 new message in #${channelLabel(latestStatus?.channelName ?? 'channel')} (${mention ? 1 : 0} mentions you)\n`);
      }
      // Persist only after emitting. A crash may repeat a notice, never consume one
      // without a notification. The delivery cursor is untouched.
      if (position !== entries.length && !done
        && (await readJson<Owner>(path.join(files.dir, MARKER)))?.nonce === nonce) await writeJsonAtomic(path.join(files.dir, OBSERVATION), {
        userId: session.userId, roomId: session.roomId, count: entries.length, lastEventId: entries.at(-1)?.eventId ?? null,
      });
    };
    const notify = () => {
      if (done) return;
      dirty = true;
      if (running) return;
      running = (async () => {
        do { dirty = false; await evaluate(); } while (dirty && !done);
      })().catch(() => stop(1)).finally(() => { running = undefined; if (dirty && !done) notify(); });
    };
    await writeJsonAtomic(leaseFile(files, nonce), { nonce, pid: process.pid });
    await writeJsonAtomic(path.join(files.dir, MARKER), { nonce, pid: process.pid });
    // Watch the directory rather than an inode: status/mode/session use atomic rename.
    watcher = watchDirectory(files.dir, (_event, filename) => {
      if (filename === null || [MARKER, 'inbox.jsonl', 'cursor.json', 'mode.json', 'session.json', 'status.json'].includes(String(filename))) notify();
    });
    watcher.on('error', () => stop(1));
    io.signal.addEventListener('abort', abort, { once: true });
    if (io.signal.aborted) stop(); else notify();
    await finished;
    await running;
    return code;
  } finally {
    watcher?.close();
    io.signal.removeEventListener('abort', abort);
    // Remove only this generation's lease; comparing then unlinking the shared marker
    // could erase a replacement that races cleanup. The marker alone is not liveness.
    await fs.unlink(leaseFile(files, nonce)).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }
}

export const WATCH_USAGE = 'usage: khala watch [--harness claude|codex|cursor --session <id>]';

export default async function run(argv: readonly string[]): Promise<number> {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0]!)) { console.log(WATCH_USAGE); return 0; }
  const invalid = (reason: string) => { console.error(`khala: ${reason}\n${WATCH_USAGE}`); return 1; };
  // Explicit session id also works when Claude does not export its id to Monitor.
  if (argv.length !== 0 && !(argv.length === 2 && argv[0] === '--session')
    && !(argv.length === 4 && argv[0] === '--harness' && argv[2] === '--session')) return invalid('invalid_arguments');
  const harness = resolveHarness(argv, process.env);
  if (harness === 'invalid') return invalid('invalid_harness');
  const index = argv.indexOf('--session');
  const id = index === -1 ? resolveSessionId(harness, undefined, process.env) : argv[index + 1];
  if (!id) return invalid('session_unknown');
  if (!SESSION_ID_PATTERN.test(id)) return invalid('invalid_session_id');
  const files = sessionFiles(harness, id, process.env);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try { return await watchSession(files, { write: line => { process.stdout.write(line); }, signal: controller.signal }); }
  finally { process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); }
}
