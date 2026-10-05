import { listChannels } from '../channels';
import { readListeningMode } from '../mode';
import { readActivity } from '../activity';
import { readCursor, unreadCount } from '../inbox';
import { readJson, readStatus, TERMINAL_SESSION_DETAILS, SESSION_ID_PATTERN, type SessionFiles } from '../state';
import { codexIdleWakeArgv, type CodexIdleWakePort } from './idle-wake';
import { createCodexQueueProcessPort } from './idle-wake-process';

export type CodexWakerDeps = Readonly<{
  files: SessionFiles;
  threadId: string;
  port?: CodexIdleWakePort;
  pollMs?: number;
  retryAfterMs?: number;
  now?: () => number;
  stderr?: (line: string) => void;
}>;
export type CodexWaker = Readonly<{ notify(): void; stop(): Promise<void> }>;

export function createCodexWaker(deps: CodexWakerDeps): CodexWaker {
  if (!SESSION_ID_PATTERN.test(deps.threadId)) throw new TypeError('invalid_thread_id');
  const port = deps.port ?? createCodexQueueProcessPort({ command: 'codex', env: process.env });
  const now = deps.now ?? Date.now;
  const stderr = deps.stderr ?? (line => { process.stderr.write(line); });
  const controller = new AbortController();
  let pending: { at: number; identities: string[] } | undefined;
  const wakesAtCount = new Map<string, Map<number, number>>();
  let stopped = false;
  let again = false;
  let inFlight: Promise<void> | undefined;
  // Diagnostics must not turn a timer callback into an unhandled rejection.
  const warn = (warning: string, status?: string) => {
    try { stderr(JSON.stringify({ ok: false, warning, ...(status ? { status } : {}) }) + '\n'); }
    catch { /* A closed diagnostic stream does not stop cleanup. */ }
  };
  const evaluate = async () => {
    try {
      const channels = await listChannels(deps.files);
      const targets = channels.length ? channels.map(channel => channel.files) : [deps.files];
      const snapshots = await Promise.all(targets.map(async files => {
        const session = await readJson<{ roomId: string; userId: string }>(files.session);
        const identity = JSON.stringify([files.dir, session?.roomId, session?.userId]);
        return { files, identity, cursor: await readCursor(files), mode: await readListeningMode(files),
          counts: await unreadCount(files.dir), status: await readStatus(files) };
      }));
      const present = new Set(snapshots.map(channel => channel.identity));
      for (const identity of wakesAtCount.keys()) if (!present.has(identity)) wakesAtCount.delete(identity);
      const eligible = snapshots.filter(channel => channel.mode !== 'async' && channel.counts.messages
        && !(channel.status?.state === 'disconnected' && TERMINAL_SESSION_DETAILS.some(detail => detail === channel.status?.detail)));
      if (!eligible.length) { pending = undefined; return; }
      if (pending && !eligible.some(channel => pending!.identities.includes(channel.identity))) pending = undefined;
      const activity = await readActivity(deps.files);
      if (pending && Date.parse(activity.updatedAt) > pending.at) pending = undefined;
      const at = now();
      if (pending && at - pending.at < (deps.retryAfterMs ?? 60_000)) return;
      if (stopped || activity.state !== 'idle') return;
      const candidates = eligible.filter(channel => (wakesAtCount.get(channel.identity)?.get(channel.cursor.deliveredCount) ?? 0) < 2);
      const ready = [];
      for (const channel of candidates) {
        if (await readListeningMode(channel.files) !== 'async') ready.push(channel);
      }
      if (!ready.length || stopped) { pending = undefined; return; }
      pending = { at, identities: ready.map(channel => channel.identity) };
      for (const channel of ready) {
        const counts = wakesAtCount.get(channel.identity) ?? new Map<number, number>();
        counts.set(channel.cursor.deliveredCount, (counts.get(channel.cursor.deliveredCount) ?? 0) + 1);
        wakesAtCount.set(channel.identity, counts);
      }
      const outcome = await port.run(codexIdleWakeArgv(deps.threadId), controller.signal);
      if (outcome.status !== 'queued') warn('codex_queue_failed', outcome.status);
    } catch { warn('codex_waker_error'); }
  };
  const notify = () => {
    if (stopped) return;
    if (inFlight) { again = true; return; }
    inFlight = (async () => {
      do {
        again = false;
        await evaluate();
      } while (again && !stopped);
    })().finally(() => {
      inFlight = undefined;
      if (again && !stopped) notify();
    });
  };
  const timer = setInterval(notify, deps.pollMs ?? 1000);
  timer.unref();
  return {
    notify,
    async stop() {
      stopped = true;
      again = false;
      clearInterval(timer);
      controller.abort();
      await inFlight;
    },
  };
}
