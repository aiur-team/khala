import { SESSION_ID_PATTERN, type SessionFiles } from '../state';
import { codexIdleWakeArgv, type CodexIdleWakePort } from './idle-wake';
import { createCodexQueueProcessPort } from './idle-wake-process';
import { probeCodexQueue, type CodexQueueProbe } from './codex-probe';
import type { WakeDriver } from './driver';
import { createWakeLadder, type WakeLadder } from './ladder';

export type CodexWakerDeps = Readonly<{
  files: SessionFiles;
  threadId: string;
  port?: CodexIdleWakePort;
  probe?: (env: NodeJS.ProcessEnv) => Promise<CodexQueueProbe>;
  pollMs?: number;
  retryAfterMs?: number;
  now?: () => number;
  stderr?: (line: string) => void;
}>;
export type CodexWaker = WakeLadder;

// TODO(#1223): Prefer per-thread TUI attachment when Codex exposes it; loaded-thread
// state and daemon-wide connection counts cannot identify an attached TUI.
export function createCodexWakeDriver(deps: Pick<CodexWakerDeps, 'port' | 'probe' | 'stderr'> = {}): WakeDriver {
  return {
    id: 'queue', rung: 1, optIn: false, minIdleMs: 0, deadlineMs: 30_000,
    verification: 'nonce',
    available: async ctx => (await (deps.probe ?? probeCodexQueue)(ctx.env)).available,
    unavailableReason: async ctx => (await (deps.probe ?? probeCodexQueue)(ctx.env)).reason,
    async wake(ctx, line) {
      const probe = await (deps.probe ?? probeCodexQueue)(ctx.env);
      if (!probe.available || ctx.signal.aborted) return;
      const port = deps.port ?? createCodexQueueProcessPort({ command: probe.command!, env: ctx.env });
      const outcome = await port.run(codexIdleWakeArgv(ctx.sessionId, line), ctx.signal);
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
