import * as fs from 'node:fs/promises';
import { watch as watchDirectory, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { InboxEntry } from '@khala/contracts/m1/inbox';
import { readCursor, readEntries, type Cursor } from './inbox';
import { readListeningMode } from './mode';
import { listChannels } from './channels';
import { readJson, readWatcherStatus, sessionFiles, stateRoot, writeJsonAtomic, SESSION_ID_PATTERN, type SessionFiles } from './state';
import { readActivity, writeActivity } from './activity';
import { driverAllowed, readWakeState, wakeLine } from './wake/shared';
import { MUSE_WAKE_REQUEST, type MuseWakeRequest } from './wake/muse-monitor';

const MARKER = 'monitor.json';
const OBSERVATION = 'monitor-cursor.json';
const NONCE_PATTERN = /^[a-f0-9-]{36}$/;
const leaseFile = (files: SessionFiles, nonce: string) => path.join(files.dir, `monitor-${nonce}.json`);
type Observation = { userId: string; roomId: string; count: number; lastEventId: string | null };
type Owner = { nonce: string; pid: number; heartbeatAt?: string };
export async function monitorArmed(files: SessionFiles): Promise<boolean> {
  const owner = await readJson<Owner>(path.join(files.dir, MARKER));
  if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.nonce !== 'string' || !NONCE_PATTERN.test(owner.nonce)) return false;
  const lease = await readJson<Owner>(leaseFile(files, owner.nonce));
  if (lease?.nonce !== owner.nonce) return false;
  if (lease.heartbeatAt !== undefined) {
    const age = Date.now() - Date.parse(lease.heartbeatAt);
    return Number.isFinite(age) && age >= 0 && age < 60_000;
  }
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
  harness?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  stderr?: (line: string) => void;
}): Promise<number> {
  const nonce = randomUUID();
  let watcher: FSWatcher | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | undefined;
  let dirty = false;
  let done = false;
  let emittedRequest: string | undefined;
  let code = 0;
  let finish!: () => void;
  const finished = new Promise<void>(resolve => { finish = resolve; });
  const stop = (exit = 0, reason = 'stopped') => {
    if (done) return;
    done = true; code = exit; watcher?.close(); clearInterval(timer);
    io.stderr?.(`khala watch: ${reason}`); finish();
  };
  let lastHeartbeat = 0;
  let exitReason = 'disconnected';
  const abort = () => stop();
  try {
    const status = await readWatcherStatus(files);
    const initialSession = await readJson<{ userId: string; roomId: string }>(files.session);
    if (!['connected', 'send_failed'].includes(status?.state ?? '')
      || (!initialSession && !(await listChannels(files)).length)) {
      stop(0, status?.detail ?? status?.state ?? 'session_missing'); return 0;
    }
    const initialDelivered = new Map<string, { identity: string; cursor: Cursor }>();
    const seedBaseline = async (target: SessionFiles, session: { userId: string; roomId: string }) => {
      initialDelivered.set(target.dir, {
        identity: JSON.stringify([session.roomId, session.userId]), cursor: await readCursor(target),
      });
    };
    // Seed before publishing ownership, even when the legacy inbox does not exist yet.
    if (initialSession) await seedBaseline(files, initialSession);
    for (const channel of await listChannels(files)) {
      const session = await readJson<{ userId: string; roomId: string }>(channel.files.session);
      if (session) await seedBaseline(channel.files, session);
    }
    const evaluate = async () => {
      const ownsSession = async () => {
        const owner = await readJson<Owner>(path.join(files.dir, MARKER));
        const status = await readWatcherStatus(files);
        exitReason = owner?.nonce !== nonce ? 'superseded' : status?.detail ?? status?.state ?? 'status_missing';
        return owner?.nonce === nonce && ['connected', 'send_failed'].includes(status?.state ?? '');
      };
      if (!await ownsSession()) { stop(0, exitReason); return; }
      if (Date.now() - lastHeartbeat >= 15_000) {
        lastHeartbeat = Date.now();
        await writeJsonAtomic(leaseFile(files, nonce), { nonce, pid: process.pid, heartbeatAt: new Date(lastHeartbeat).toISOString() });
      }
      for (const channel of await listChannels(files)) {
        const target = channel.files;
        const session = await readJson<{ userId: string; roomId: string }>(target.session);
        const status = await readWatcherStatus(target);
        if (!session || session.roomId !== channel.roomId || typeof session.userId !== 'string'
          || !['connected', 'send_failed'].includes(status?.state ?? '')) continue;
        const identity = JSON.stringify([session.roomId, session.userId]);
        if (initialDelivered.get(target.dir)?.identity !== identity) {
          await seedBaseline(target, session);
        }
        const mode = await readListeningMode(target);
        const entries = await readEntries(target);
        const observed = await readJson<Observation>(path.join(target.dir, OBSERVATION));
        const position = observed?.userId === session.userId && observed?.roomId === session.roomId
          && Number.isSafeInteger(observed.count) && observed.count >= 0 && observed.count <= entries.length
          && (observed.count === 0 || entries[observed.count - 1]?.eventId === observed.lastEventId) ? observed.count : 0;
        const baseline = initialDelivered.get(target.dir)!.cursor;
        // A same-identity rejoin can reset its inbox; an old numeric offset alone
        // must never hide the first messages in the new inbox generation.
        const initialCount = baseline.deliveredCount === 0
          || entries[baseline.deliveredCount - 1]?.eventId === baseline.lastDeliveredEventId ? baseline.deliveredCount : 0;
        const fresh = entries.slice(Math.max(initialCount, position));
        const latestMode = await readListeningMode(target);
        const latestSession = await readJson<{ userId: string; roomId: string }>(target.session);
        const latestStatus = await readWatcherStatus(target);
        if (!await ownsSession()) { stop(0, exitReason); return; }
        if (latestSession?.userId !== session.userId || latestSession?.roomId !== session.roomId
          || !['connected', 'send_failed'].includes(latestStatus?.state ?? '')) continue;
        const messages = fresh.filter(entry => entry.kind === 'message' && entry.sender !== session.userId
          && entry.roomId === session.roomId);
        if (io.harness !== 'muse' && !done && mode !== 'async' && latestMode !== 'async' && messages.length) {
          const count = messages.filter(entry => mentions(entry, latestStatus?.displayName)).length;
          io.write(`khala: ${messages.length} new message${messages.length === 1 ? '' : 's'} in #${channelLabel(latestStatus?.channelName ?? channel.channelName ?? 'channel')} (${count} mentions you)\n`);
        }
        // Observation is independent of delivery, and lives beside this channel's inbox.
        // Recheck identity before persisting so leaving A never writes into another join.
        if (position !== entries.length && !done && await ownsSession()
          && JSON.stringify(await readJson(target.session)) === JSON.stringify(latestSession)) {
          try {
            await writeJsonAtomic(path.join(target.dir, OBSERVATION), {
              userId: session.userId, roomId: session.roomId, count: entries.length, lastEventId: entries.at(-1)?.eventId ?? null,
            });
          } catch (error) {
            if (await readJson(target.session)) throw error;
          }
        }
      }
      if (io.harness === 'muse' && !done && await ownsSession()) {
        const request = await readJson<MuseWakeRequest>(path.join(files.dir, MUSE_WAKE_REQUEST));
        const now = (io.now ?? Date.now)();
        const wakeNonce = typeof request?.line === 'string' ? /\(k-([a-f0-9]{8})\)$/.exec(request.line)?.[1] : undefined;
        if (request?.owner === nonce && wakeNonce && wakeLine(wakeNonce) === request.line
          && request.line !== emittedRequest && now >= request.at && now < request.deadline
          && await driverAllowed(stateRoot(io.env ?? process.env), 'muse', 'monitor', false)
          && !(await readWakeState(files.dir)).monitor?.disabled
          && (await readActivity(files)).state === 'idle') {
          const channels = await listChannels(files);
          let eligible = false;
          for (const channel of channels) {
            if (await readListeningMode(channel.files) === 'async') continue;
            const session = await readJson<{ userId: string }>(channel.files.session);
            const status = await readWatcherStatus(channel.files);
            if (!['connected', 'send_failed'].includes(status?.state ?? '')) continue;
            const cursor = await readCursor(channel.files);
            eligible ||= (await readEntries(channel.files)).slice(cursor.deliveredCount)
              .some(entry => entry.kind === 'message' && entry.sender !== session?.userId);
          }
          if (eligible && await ownsSession() && (await readActivity(files)).state === 'idle') {
            await writeActivity(files, 'busy', () => new Date(now));
            io.write(request.line + '\n');
            emittedRequest = request.line;
          }
        }
      }
    };
    const notify = () => {
      if (done) return;
      dirty = true;
      if (running) return;
      running = (async () => {
        do { dirty = false; await evaluate(); } while (dirty && !done);
      })().catch(() => stop(1, 'watch_error')).finally(() => { running = undefined; if (dirty && !done) notify(); });
    };
    let published = false;
    // Watch the directory rather than an inode: status/mode/session use atomic rename.
    watcher = watchDirectory(files.dir, (_event, filename) => {
      if (published && (filename === null || [MARKER, MUSE_WAKE_REQUEST, 'inbox.jsonl', 'cursor.json', 'mode.json', 'session.json', 'status.json'].includes(String(filename)))) notify();
    });
    watcher.on('error', () => stop(1, 'watch_error'));
    lastHeartbeat = Date.now();
    await writeJsonAtomic(leaseFile(files, nonce), { nonce, pid: process.pid, heartbeatAt: new Date(lastHeartbeat).toISOString() });
    await writeJsonAtomic(path.join(files.dir, MARKER), { nonce, pid: process.pid });
    published = true;
    // Re-list on every tick: subdirectory writes and channels joined after startup
    // need observation even on platforms without recursive fs.watch.
    timer = setInterval(notify, 100);
    io.signal.addEventListener('abort', abort, { once: true });
    if (io.signal.aborted) stop(); else notify();
    await finished;
    await running;
    return code;
  } catch {
    stop(1, 'watch_error');
    return 1;
  } finally {
    clearInterval(timer);
    watcher?.close();
    io.signal.removeEventListener('abort', abort);
    // Remove only this generation's lease; comparing then unlinking the shared marker
    // could erase a replacement that races cleanup. The marker alone is not liveness.
    await fs.unlink(leaseFile(files, nonce)).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    });
  }
}

export const WATCH_USAGE = 'usage: khala watch [--harness <id>] [--session <id>]';

export default async function run(argv: readonly string[]): Promise<number> {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0]!)) { console.log(WATCH_USAGE); return 0; }
  const invalid = (reason: string) => { console.error(`khala: ${reason}\n${WATCH_USAGE}`); return 1; };
  // Explicit session id also works when Claude does not export its id to Monitor.
  if (argv.length !== 0 && !(argv.length === 2 && ['--session', '--harness'].includes(argv[0]!))
    && !(argv.length === 4 && argv[0] === '--harness' && argv[2] === '--session')) return invalid('invalid_arguments');
  const { resolveHarness, resolveSessionId } = await import('./mcp/session-id');
  const { adapterFor } = await import('./harness');
  const harness = resolveHarness(argv, process.env);
  if (harness === 'invalid' || !adapterFor(harness)?.codec) return invalid('invalid_harness');
  const index = argv.indexOf('--session');
  const id = index === -1 ? await resolveSessionId(harness, undefined, process.env) : argv[index + 1];
  if (!id) return invalid('session_unknown');
  if (!SESSION_ID_PATTERN.test(id)) return invalid('invalid_session_id');
  const files = sessionFiles(harness, id, process.env);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  try { return await watchSession(files, { write: line => { process.stdout.write(line); }, signal: controller.signal, harness, stderr: line => { process.stderr.write(line + '\n'); } }); }
  finally { process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); }
}
