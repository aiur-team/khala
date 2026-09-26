// The `codex queue` runner for the idle wake. It spawns without a shell, gives the child only an
// allowlisted environment (nothing that could carry a message, token or peer name), discards the
// child's output, and stops that child when the wake aborts. It never signals the Codex TUI.

import { type SpawnOptions, spawn as nodeSpawn } from 'node:child_process';
import type { CodexIdleWakeOutcome, CodexIdleWakePort } from './idle-wake';

/** The only variables the queue child inherits: enough to find and run the Codex CLI. */
export const CODEX_QUEUE_ENV_ALLOWLIST: readonly string[] = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TMPDIR', 'CODEX_HOME', 'XDG_CONFIG_HOME',
  'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_RUNTIME_DIR',
];

export function scrubbedQueueEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of CODEX_QUEUE_ENV_ALLOWLIST) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

type Child = Readonly<{
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'error', listener: () => void): unknown;
  on(event: 'close', listener: (code: number | null) => void): unknown;
}>;

export type CodexQueueProcessDeps = Readonly<{
  /** The resolved `codex` executable. */
  command: string;
  env: NodeJS.ProcessEnv;
  /** Bounds one queue command; a child still running then is stopped and reported lost. */
  timeoutMs?: number;
  spawn?: (command: string, argv: readonly string[], options: SpawnOptions) => Child;
}>;

export function createCodexQueueProcessPort(deps: CodexQueueProcessDeps): CodexIdleWakePort {
  const spawn = deps.spawn ?? ((command, argv, options) => nodeSpawn(command, [...argv], options));
  const timeoutMs = deps.timeoutMs ?? 10_000;
  return {
    run(argv, signal) {
      return new Promise<CodexIdleWakeOutcome>(resolve => {
        if (signal.aborted) return resolve({ status: 'not_started' });
        let child: Child;
        try {
          child = spawn(deps.command, argv, { shell: false, stdio: 'ignore', env: scrubbedQueueEnv(deps.env) });
        } catch {
          return resolve({ status: 'not_started' });
        }
        let timedOut = false;
        const stop = () => { child.kill('SIGTERM'); };
        const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
        signal.addEventListener('abort', stop, { once: true });
        const settle = (outcome: CodexIdleWakeOutcome) => {
          clearTimeout(timer);
          signal.removeEventListener('abort', stop);
          resolve(outcome);
        };
        child.on('error', () => settle({ status: 'not_started' }));
        child.on('close', code => settle(timedOut
          ? { status: 'lost', cause: 'timeout' }
          : code === 0 ? { status: 'queued' } : { status: 'exited', code: code ?? -1 }));
      });
    },
  };
}
