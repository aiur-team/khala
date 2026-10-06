import { SESSION_ID_PATTERN, type SessionFiles } from '../state';
import { codexIdleWakeArgv, type CodexIdleWakePort } from './idle-wake';
import { createCodexQueueProcessPort } from './idle-wake-process';
import type { WakeDriver } from './driver';
import { createWakeLadder, type WakeLadder } from './ladder';

export type CodexWakerDeps = Readonly<{
  files: SessionFiles;
  threadId: string;
  port?: CodexIdleWakePort;
  pollMs?: number;
  retryAfterMs?: number;
  now?: () => number;
  stderr?: (line: string) => void;
}>;
export type CodexWaker = WakeLadder;

export function createCodexWakeDriver(deps: Pick<CodexWakerDeps, 'port' | 'stderr'> = {}): WakeDriver {
  return {
    id: 'queue', rung: 1, optIn: false, minIdleMs: 0, deadlineMs: 30_000,
    // U13 introduces the nonce-bearing argv. Preserve U2 queue goldens until then.
    verification: 'none',
    available: () => true,
    async wake(ctx) {
      const port = deps.port ?? createCodexQueueProcessPort({ command: 'codex', env: ctx.env });
      const outcome = await port.run(codexIdleWakeArgv(ctx.sessionId), ctx.signal);
      if (outcome.status !== 'queued') {
        const line = JSON.stringify({ ok: false, warning: 'codex_queue_failed', status: outcome.status }) + '\n';
        try { (deps.stderr ?? (value => { process.stderr.write(value); }))(line); } catch { /* Closed diagnostics do not prevent cleanup. */ }
      }
    },
  };
}
export const codexWakeDriver = createCodexWakeDriver();

export function createCodexWaker(deps: CodexWakerDeps): CodexWaker {
  if (!SESSION_ID_PATTERN.test(deps.threadId)) throw new TypeError('invalid_thread_id');
  return createWakeLadder({ ...deps, harness: 'codex', sessionId: deps.threadId,
    drivers: [createCodexWakeDriver(deps)], warningPrefix: 'codex' });
}
