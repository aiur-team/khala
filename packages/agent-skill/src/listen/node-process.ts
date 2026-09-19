import { spawn } from 'node:child_process';
import type { ListenerProcessError, ListenerProcessPort } from './supervisor.js';

const MAX_ERROR_BYTES = 1_024;

export const nodeListenerProcess: ListenerProcessPort = {
  run(input) {
    return new Promise((resolve, reject) => {
      if (input.signal.aborted) return resolve({ code: null, signal: 'SIGTERM', errorCode: null });
      const child = spawn(input.command, input.args, {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.pipe(input.stdout, { end: false });
      child.stderr.pipe(input.stderr, { end: false });
      let errorOutput = '';
      let errorBytes = 0;
      child.stderr.on('data', (chunk: Buffer) => {
        const remaining = MAX_ERROR_BYTES - errorBytes;
        if (remaining <= 0) return;
        const observed = chunk.subarray(0, remaining);
        errorOutput += observed.toString('utf8');
        errorBytes += observed.byteLength;
      });
      let settled = false;
      const finish = (work: () => void) => {
        if (settled) return;
        settled = true;
        input.signal.removeEventListener('abort', stop);
        work();
      };
      const stop = () => child.kill('SIGTERM');
      input.signal.addEventListener('abort', stop, { once: true });
      if (input.signal.aborted) stop();
      child.once('error', () => finish(() => reject(new Error('listener_spawn_failed'))));
      child.once('close', (code, signal) => finish(() => resolve({
        code,
        signal,
        errorCode: code === 0 ? null : recognizedError(errorOutput),
      })));
    });
  },
};

function recognizedError(output: string): ListenerProcessError | null {
  try {
    const value: unknown = JSON.parse(output.trim());
    return typeof value === 'object' && value !== null && 'error' in value
      && value.error === 'listener_busy' ? 'listener_busy' : null;
  } catch {
    return null;
  }
}
