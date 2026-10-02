import { readListeningMode } from '../mode';
import { readActivity } from '../activity';
import { readCursor, unreadCount } from '../inbox';
import { readJson, SESSION_ID_PATTERN, type SessionFiles } from '../state';
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
  let pending: { at: number } | undefined;
  const wakesAtCount = new Map<number, number>();
  let channelIdentity: string | undefined;
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
      const session = await readJson<{ roomId: string; userId: string }>(deps.files.session);
      const identity = JSON.stringify([session?.roomId, session?.userId]);
      if (identity !== channelIdentity) {
        channelIdentity = identity;
        wakesAtCount.clear();
        pending = undefined;
      }
      if (await readListeningMode(deps.files) === 'async') { pending = undefined; return; }
      const counts = await unreadCount(deps.files.dir);
      const cursor = await readCursor(deps.files);
      if (!counts.messages) { pending = undefined; return; }
      const activity = await readActivity(deps.files);
      if (pending && Date.parse(activity.updatedAt) > pending.at) pending = undefined;
      const at = now();
      if (pending && at - pending.at < (deps.retryAfterMs ?? 60_000)) return;
      if (stopped || activity.state !== 'idle') return;
      const wakes = wakesAtCount.get(cursor.deliveredCount) ?? 0;
      if (wakes >= 2) return;
      if (await readListeningMode(deps.files) === 'async' || stopped) { pending = undefined; return; }
      pending = { at };
      wakesAtCount.set(cursor.deliveredCount, wakes + 1);
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
