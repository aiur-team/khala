import type { Writable } from 'node:stream';
import { listenerBindingId } from './binding-id.js';

export const LISTENER_PROCESS_ERRORS = [
  'invalid_arguments', 'invalid_link', 'invalid_input', 'not_connected', 'binding_not_held',
  'listener_busy', 'storage_failed', 'transport_unavailable', 'outcome_unknown', 'internal_error',
] as const;
export type ListenerProcessError = (typeof LISTENER_PROCESS_ERRORS)[number];

export type ListenerExit = Readonly<{
  code: number | null;
  signal: string | null;
  errorCode: ListenerProcessError | null;
}>;

export type ListenerProcessInput = Readonly<{
  command: string;
  args: readonly string[];
  stdout: Writable;
  stderr: Writable;
  signal: AbortSignal;
}>;

export interface ListenerProcessPort {
  run(input: ListenerProcessInput): Promise<ListenerExit>;
}

export type ListenerRetry = Readonly<{
  attempt: number;
  delayMs: number;
  outcome: 'exit' | 'spawn_failed';
  code: number | null;
  signal: string | null;
}>;

export type ListenerHandle = Readonly<{
  completion: Promise<void>;
  stop(): void;
}>;

export type ListenerStart = Readonly<{
  bindingId?: string;
  stdout: Writable;
  stderr: Writable;
  signal?: AbortSignal;
}>;

export type ListenerBackoff = Readonly<{ initialMs: number; maximumMs: number; factor: number }>;

export type ListenerSupervisorOptions = Readonly<{
  process: ListenerProcessPort;
  command?: string;
  backoff?: ListenerBackoff;
  maxSpawnFailures?: number;
  sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  onRetry?: (retry: ListenerRetry) => void;
}>;

export class ListenerTerminalError extends Error {
  readonly code: ListenerProcessError;

  constructor(code: ListenerProcessError) {
    super(code);
    this.name = 'ListenerTerminalError';
    this.code = code;
  }
}

export class ListenerBusyError extends ListenerTerminalError {
  constructor() { super('listener_busy'); this.name = 'ListenerBusyError'; }
}

export class ListenerSpawnError extends Error {
  readonly code = 'listener_spawn_failed';

  constructor() { super('listener_spawn_failed'); this.name = 'ListenerSpawnError'; }
}

export function createListenerSupervisor(options: ListenerSupervisorOptions) {
  const backoff = validateBackoff(options.backoff ?? { initialMs: 250, maximumMs: 30_000, factor: 2 });
  const maxSpawnFailures = validPositiveInteger(options.maxSpawnFailures ?? 5, 'invalid max spawn failures');
  const active = new Set<string>();
  const sleep = options.sleep ?? abortableSleep;
  const command = options.command ?? 'khala';

  return {
    start(input: ListenerStart): ListenerHandle {
      const bindingId = input.bindingId === undefined ? null : validBindingId(input.bindingId);
      const key = bindingId ?? '<current-binding>';
      if (active.has(key) || (bindingId === null ? active.size > 0 : active.has('<current-binding>'))) {
        throw new ListenerBusyError();
      }
      active.add(key);

      const abort = new AbortController();
      const stop = () => abort.abort();
      input.signal?.addEventListener('abort', stop, { once: true });
      if (input.signal?.aborted) stop();

      const completion = run({
        process: options.process,
        command,
        args: bindingId === null ? ['listen'] : ['listen', '--binding', bindingId],
        stdout: input.stdout,
        stderr: input.stderr,
        signal: abort.signal,
        backoff,
        maxSpawnFailures,
        sleep,
        onRetry: options.onRetry,
      }).finally(() => {
        input.signal?.removeEventListener('abort', stop);
        active.delete(key);
      });
      return { completion, stop };
    },
  };
}

type RunOptions = Readonly<{
  process: ListenerProcessPort;
  command: string;
  args: readonly string[];
  stdout: Writable;
  stderr: Writable;
  signal: AbortSignal;
  backoff: ListenerBackoff;
  maxSpawnFailures: number;
  sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  onRetry: ((retry: ListenerRetry) => void) | undefined;
}>;

async function run(options: RunOptions): Promise<void> {
  let attempt = 0;
  let consecutiveSpawnFailures = 0;
  let delayMs = options.backoff.initialMs;
  while (!options.signal.aborted) {
    let exit: ListenerExit | null = null;
    try {
      exit = await options.process.run({
        command: options.command,
        args: options.args,
        stdout: options.stdout,
        stderr: options.stderr,
        signal: options.signal,
      });
    } catch { /* Process details are intentionally not retained. */ }
    if (options.signal.aborted) return;
    if (exit?.errorCode !== null && exit?.errorCode !== undefined) {
      if (exit.errorCode === 'listener_busy') throw new ListenerBusyError();
      throw new ListenerTerminalError(exit.errorCode);
    }
    if (exit === null) {
      consecutiveSpawnFailures += 1;
      if (consecutiveSpawnFailures >= options.maxSpawnFailures) throw new ListenerSpawnError();
    } else {
      consecutiveSpawnFailures = 0;
    }
    attempt += 1;
    const retry: ListenerRetry = exit === null
      ? { attempt, delayMs, outcome: 'spawn_failed', code: null, signal: null }
      : { attempt, delayMs, outcome: 'exit', code: exit.code, signal: exit.signal };
    notify(options.onRetry, retry);
    await options.sleep(delayMs, options.signal);
    delayMs = Math.min(Math.ceil(delayMs * options.backoff.factor), options.backoff.maximumMs);
  }
}

function validBindingId(value: string): string {
  const decoded = listenerBindingId(value);
  if (decoded === null) throw new TypeError('invalid binding id');
  return decoded;
}

function validateBackoff(value: ListenerBackoff): ListenerBackoff {
  if (!Number.isSafeInteger(value.initialMs) || value.initialMs < 1
    || !Number.isSafeInteger(value.maximumMs) || value.maximumMs < value.initialMs
    || !Number.isFinite(value.factor) || value.factor < 1) throw new TypeError('invalid listener backoff');
  return value;
}

function validPositiveInteger(value: number, message: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(message);
  return value;
}

function notify(observer: ((retry: ListenerRetry) => void) | undefined, retry: ListenerRetry): void {
  try { observer?.(retry); } catch { /* Observability must not stop delivery. */ }
}

function abortableSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const timer = setTimeout(done, milliseconds);
    const abort = () => done();
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      resolve();
    }
    signal.addEventListener('abort', abort, { once: true });
  });
}
