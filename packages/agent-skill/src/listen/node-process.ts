import { spawn } from 'node:child_process';
import {
  LISTENER_PROCESS_ERRORS, type ListenerProcessError, type ListenerProcessPort,
} from './supervisor.js';

const MAX_ERROR_BYTES = 1_024;
const MAX_WARNING_LINE_BYTES = 512;
const DEFAULT_TERMINATION_GRACE_MS = 5_000;
const SQLITE_WARNING = /^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature and might change at any time\r?\n$/u;
const WARNING_HINT = /^\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\r?\n$/u;
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
        let errorTail = Buffer.alloc(0);
        const observeError = (chunk: Buffer) => {
          errorTail = Buffer.concat([errorTail, chunk]);
          if (errorTail.byteLength > MAX_ERROR_BYTES) errorTail = errorTail.subarray(-MAX_ERROR_BYTES);
        };
        const stderrFilter = createKnownSqliteWarningFilter(chunk => {
          input.stderr.write(chunk);
          observeError(chunk);
        });
        child.stderr.on('data', stderrFilter.write);
        let settled = false;
        let killTimer: NodeJS.Timeout | undefined;
        const finish = (work: () => void) => {
          if (settled) return;
          settled = true;
          if (killTimer !== undefined) clearTimeout(killTimer);
          input.signal.removeEventListener('abort', stop);
          process.removeListener('exit', stopForParentExit);
          child.stderr.removeListener('data', stderrFilter.write);
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
        child.once('close', (code, signal) => {
          stderrFilter.flush();
          finish(() => resolve({
            code,
            signal,
            errorCode: code === 0 ? null : recognizedError(errorTail),
          }));
        });
      });
    },
  };
}

// Node's node:sqlite warning is runtime noise, not listener stderr. Keep every
// other byte observable, including unknown warnings and malformed diagnostics.
export function createKnownSqliteWarningFilter(emit: (chunk: Buffer) => void): Readonly<{
  write: (chunk: Buffer) => void;
  flush: () => void;
}> {
  let pending = Buffer.alloc(0);
  let afterSqliteWarning = false;
  let passingLongLine = false;
  const forwardLine = (line: Buffer) => {
    const value = line.toString('utf8');
    if (SQLITE_WARNING.test(value)) {
      afterSqliteWarning = true;
    } else if (afterSqliteWarning && WARNING_HINT.test(value)) {
      afterSqliteWarning = false;
    } else {
      afterSqliteWarning = false;
      emit(line);
    }
  };
  return {
    write(chunk) {
      if (passingLongLine) {
        const newline = chunk.indexOf(0x0a);
        if (newline === -1) {
          emit(chunk);
          return;
        }
        emit(chunk.subarray(0, newline + 1));
        chunk = chunk.subarray(newline + 1);
        passingLongLine = false;
      }
      pending = Buffer.concat([pending, chunk]);
      let newline: number;
      while ((newline = pending.indexOf(0x0a)) !== -1) {
        forwardLine(pending.subarray(0, newline + 1));
        pending = pending.subarray(newline + 1);
      }
      if (pending.byteLength > MAX_WARNING_LINE_BYTES) {
        afterSqliteWarning = false;
        emit(pending);
        pending = Buffer.alloc(0);
        passingLongLine = true;
      }
    },
    flush() {
      if (pending.byteLength > 0) emit(pending);
      pending = Buffer.alloc(0);
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
