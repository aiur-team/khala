import path from 'node:path';
import { readListeningMode } from '../mode';
import { readActivity } from '../activity';
import { listChannels } from '../channels';
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
  const wakesAtCount = new Map<string, number>();
  const identities = new Map<string, string>();
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
      const eligible = [];
      const currentIdentities = new Map<string, string>();
      for (const channel of channels) {
        const session = await readJson<{ roomId: string; userId: string }>(channel.files.session);
        const metadata = channel.legacy ? null : await readJson<{ joinedAt?: string }>(path.join(channel.files.dir, 'channel.json'));
        currentIdentities.set(channel.key, JSON.stringify([session?.roomId ?? channel.roomId, session?.userId, metadata?.joinedAt]));
        if (await readListeningMode(channel.files) === 'async') continue;
        eligible.push({ channel,
          counts: await unreadCount(channel.files.dir), cursor: await readCursor(channel.files) });
      }
      const keys = new Set(currentIdentities.keys());
      const changed = new Set<string>();
      for (const [key, identity] of currentIdentities) {
        if (identities.get(key) !== identity) changed.add(key);
      }
      for (const key of identities.keys()) if (!keys.has(key)) changed.add(key);
      // Preserve projections for unaffected channels when a membership/identity changes.
      // An empty rejoined A must not renew the budget earned by unread B.
      if (changed.size) {
        for (const [key, wakes] of [...wakesAtCount]) {
          const pairs = JSON.parse(key) as [string, number][];
          if (!pairs.some(([id]) => changed.has(id))) continue;
          wakesAtCount.delete(key);
          const remainingPairs = pairs.filter(([id]) => !changed.has(id));
          if (!remainingPairs.length) continue;
          const remaining = JSON.stringify(remainingPairs);
          wakesAtCount.set(remaining, Math.max(wakes, wakesAtCount.get(remaining) ?? 0));
        }
      }
      for (const key of changed) identities.delete(key);
      for (const [key, identity] of currentIdentities) identities.set(key, identity);
      const pairs = eligible.map(({ channel, cursor }) => [channel.key, cursor.deliveredCount] as [string, number])
        .sort(([a], [b]) => a.localeCompare(b));
      const budgetKey = JSON.stringify(pairs);
      if (changed.size) {
        const inheritedKey = JSON.stringify(pairs.filter(([key]) => !changed.has(key)));
        const newUnread = eligible.some(item => changed.has(item.channel.key) && item.counts.messages > 0);
        wakesAtCount.set(budgetKey, newUnread ? 0 : wakesAtCount.get(inheritedKey) ?? 0);
        if (newUnread || !eligible.some(item => !changed.has(item.channel.key) && item.counts.messages > 0)) pending = undefined;
      }
      if (!eligible.some(item => item.counts.messages > 0)) { pending = undefined; return; }
      const activity = await readActivity(deps.files);
      if (pending && Date.parse(activity.updatedAt) > pending.at) pending = undefined;
      const at = now();
      if (pending && at - pending.at < (deps.retryAfterMs ?? 60_000)) return;
      if (stopped || activity.state !== 'idle') return;
      const wakes = wakesAtCount.get(budgetKey) ?? 0;
      if (wakes >= 2) return;
      for (const { channel } of eligible) {
        if (await readListeningMode(channel.files) === 'async') { pending = undefined; return; }
      }
      if (stopped) return;
      pending = { at };
      wakesAtCount.set(budgetKey, wakes + 1);
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
