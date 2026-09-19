import { spawn } from 'node:child_process';
import {
  LISTENER_PROCESS_ERRORS, type ListenerProcessError, type ListenerProcessPort,
} from './supervisor.js';

const MAX_ERROR_BYTES = 1_024;
const DEFAULT_TERMINATION_GRACE_MS = 5_000;
const ENVIRONMENT_ALLOWLIST = [
  'PATH', 'HOME', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME',
  'XDG_STATE_HOME', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_DIRS', 'XDG_DATA_DIRS',
] as const;

export function createNodeListenerProcess(
  options: Readonly<{ terminationGraceMs?: number }> = {},
): ListenerProcessPort {
  const terminationGraceMs = options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
  if (!Number.isSafeInteger(terminationGraceMs) || terminationGraceMs < 1) {
    throw new TypeError('invalid termination grace period');
  }
  return {
    run(input) {
      return new Promise((resolve, reject) => {
        if (input.signal.aborted) return resolve({ code: null, signal: 'SIGTERM', errorCode: null });
        const child = spawn(input.command, input.args, {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: allowedEnvironment(),
        });
        child.stdout.pipe(input.stdout, { end: false });
        child.stderr.pipe(input.stderr, { end: false });
        let errorTail = Buffer.alloc(0);
        const observeError = (chunk: Buffer) => {
          errorTail = Buffer.concat([errorTail, chunk]);
          if (errorTail.byteLength > MAX_ERROR_BYTES) errorTail = errorTail.subarray(-MAX_ERROR_BYTES);
        };
        child.stderr.on('data', observeError);
        let settled = false;
        let killTimer: NodeJS.Timeout | undefined;
        const finish = (work: () => void) => {
          if (settled) return;
          settled = true;
          if (killTimer !== undefined) clearTimeout(killTimer);
          input.signal.removeEventListener('abort', stop);
          process.removeListener('exit', stopForParentExit);
          child.stderr.removeListener('data', observeError);
          work();
        };
        const stop = () => {
          if (settled) return;
          child.kill('SIGTERM');
          killTimer ??= setTimeout(() => {
            if (!settled) child.kill('SIGKILL');
          }, terminationGraceMs);
          killTimer.unref();
        };
        const stopForParentExit = () => { if (!settled) child.kill('SIGKILL'); };
        input.signal.addEventListener('abort', stop, { once: true });
        process.once('exit', stopForParentExit);
        if (input.signal.aborted) stop();
        child.once('error', () => finish(() => reject(new Error('listener_spawn_failed'))));
        child.once('close', (code, signal) => finish(() => resolve({
          code,
          signal,
          errorCode: code === 0 ? null : recognizedError(errorTail),
        })));
      });
    },
  };
}

export const nodeListenerProcess = createNodeListenerProcess();

function recognizedError(output: Buffer): ListenerProcessError | null {
  try {
    const line = output.toString('utf8').split(/\r?\n/u).filter(value => value.trim() !== '').at(-1);
    if (line === undefined) return null;
    const value: unknown = JSON.parse(line);
    return typeof value === 'object' && value !== null && 'error' in value
      && typeof value.error === 'string'
      && (LISTENER_PROCESS_ERRORS as readonly string[]).includes(value.error)
      ? value.error as ListenerProcessError : null;
  } catch {
    return null;
  }
}

function allowedEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ENVIRONMENT_ALLOWLIST) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}
