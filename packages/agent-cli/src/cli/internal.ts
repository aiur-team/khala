import type { Writable } from 'node:stream';
import {
  type InternalCommand, type InternalRuntime, isInternalChannelArgument,
} from '@khala/contracts/internal/command';
import { CliError } from './errors.js';
import type { InternalRuntimeLoader } from './types.js';

// `khala internal` grammar. Arguments are parsed and refused here, before the
// internal runtime (store, server, node:sqlite) is loaded at all:
//
//   khala internal
//   khala internal --resume <channel-id>
//   khala internal export <channel-id> --format markdown|jsonl --output <path> [--replace]
//   khala internal delete <channel-id> [--yes]

export const INTERNAL_RUNTIME_FILE = 'khala-internal.js';

export function parseInternalArguments(args: readonly string[]): InternalCommand {
  const invalid = () => new CliError('invalid_arguments');
  if (args.length === 0) return { kind: 'create' };
  const [first, channelId, ...rest] = args;
  if (!isInternalChannelArgument(channelId)) throw invalid();
  switch (first) {
    case '--resume':
      if (rest.length !== 0) throw invalid();
      return { kind: 'resume', channelId };
    case 'delete':
      if (rest.length === 0) return { kind: 'delete', channelId, confirmed: false };
      if (rest.length === 1 && rest[0] === '--yes') return { kind: 'delete', channelId, confirmed: true };
      throw invalid();
    case 'export': {
      let format: 'markdown' | 'jsonl' | null = null;
      let output: string | null = null;
      let replace = false;
      for (let index = 0; index < rest.length; index += 1) {
        const flag = rest[index];
        if (flag === '--replace' && !replace) { replace = true; continue; }
        const value = rest[index + 1];
        if (flag === '--format' && format === null && (value === 'markdown' || value === 'jsonl')) format = value;
        else if (flag === '--output' && output === null && typeof value === 'string' && value.length > 0
          && !value.startsWith('-') && !value.includes('\0')) output = value;
        else throw invalid();
        index += 1;
      }
      if (format === null || output === null) throw invalid();
      return { kind: 'export', channelId, format, output, replace };
    }
    default:
      throw invalid();
  }
}

/** Loads the separately bundled runtime that ships beside the CLI entry. */
export function bundledInternalRuntime(entryUrl: string): InternalRuntimeLoader {
  return async () => {
    const loaded: unknown = await import(new URL(`./${INTERNAL_RUNTIME_FILE}`, entryUrl).href);
    const runtime = loaded as Partial<InternalRuntime> | null;
    if (typeof runtime?.runInternalCommand !== 'function') throw new Error('internal runtime');
    return { runInternalCommand: runtime.runInternalCommand };
  };
}

function sink(stream: Writable) {
  return {
    write: (text: string) => new Promise<void>((resolve, reject) => stream.write(text, error => error ? reject(error) : resolve())),
  };
}

export async function runInternal(args: readonly string[], deps: Readonly<{
  internal?: InternalRuntimeLoader;
  stdout: Writable;
  stderr: Writable;
  signal?: AbortSignal;
  env?: Readonly<Record<string, string | undefined>>;
  cwd?: string;
}>): Promise<number> {
  const command = parseInternalArguments(args);
  if (!deps.internal) throw new CliError('internal_unavailable');
  let runtime: InternalRuntime;
  try {
    runtime = await deps.internal();
  } catch {
    throw new CliError('internal_unavailable');
  }
  return runtime.runInternalCommand(command, {
    stdout: sink(deps.stdout),
    stderr: sink(deps.stderr),
    signal: deps.signal ?? new AbortController().signal,
    env: deps.env ?? {},
    cwd: deps.cwd ?? '/',
  });
}
