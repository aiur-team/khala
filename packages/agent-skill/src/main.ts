#!/usr/bin/env node
import path from 'node:path';
import type { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { listenerBindingId } from './listen/binding-id.js';
import { nodeListenerProcess } from './listen/node-process.js';
import {
  ListenerBusyError,
  createListenerSupervisor,
  type ListenerProcessPort,
} from './listen/supervisor.js';

type FallbackError = 'invalid_arguments' | 'listener_busy' | 'listener_failed';

export type FallbackRuntime = Readonly<{
  stdout: Writable;
  stderr: Writable;
  signal: AbortSignal;
  process?: ListenerProcessPort;
}>;

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  runtime: FallbackRuntime = {
    stdout: process.stdout,
    stderr: process.stderr,
    signal: new AbortController().signal,
  },
): Promise<number> {
  const bindingId = explicitBinding(argv);
  if (bindingId === null) return fail(runtime.stderr, 'invalid_arguments');

  try {
    const supervisor = createListenerSupervisor({ process: runtime.process ?? nodeListenerProcess });
    const handle = supervisor.start({
      bindingId,
      stdout: runtime.stdout,
      stderr: runtime.stderr,
      signal: runtime.signal,
    });
    await handle.completion;
    return 0;
  } catch (error) {
    return fail(runtime.stderr, error instanceof ListenerBusyError ? 'listener_busy' : 'listener_failed');
  }
}

function explicitBinding(argv: readonly string[]): string | null {
  if (argv.length !== 3 || argv[0] !== 'listen' || argv[1] !== '--binding') return null;
  return listenerBindingId(argv[2]);
}

function fail(stderr: Writable, error: FallbackError): number {
  stderr.write(`${JSON.stringify({ ok: false, error })}\n`);
  return 2;
}

async function processMain(): Promise<number> {
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    return await main(process.argv.slice(2), {
      stdout: process.stdout,
      stderr: process.stderr,
      signal: abort.signal,
    });
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await processMain();
}
