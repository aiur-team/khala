import { execFile } from 'node:child_process';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { main } from './main.js';
import type { ListenerProcessInput, ListenerProcessPort } from './listen/supervisor.js';

const execFileAsync = promisify(execFile);

function capture() {
  const stream = new PassThrough();
  let output = '';
  stream.on('data', chunk => { output += String(chunk); });
  return { stream, output: () => output };
}

function untilAbort(input: ListenerProcessInput): ReturnType<ListenerProcessPort['run']> {
  return new Promise(resolve => {
    const stopped = () => resolve({ code: null, signal: 'SIGTERM', errorCode: null });
    if (input.signal.aborted) stopped();
    else input.signal.addEventListener('abort', stopped, { once: true });
  });
}

describe('khala-fallback executable', () => {
  it('accepts only an explicit listen binding and delegates to khala', async () => {
    const abort = new AbortController();
    const calls: ListenerProcessInput[] = [];
    const process: ListenerProcessPort = {
      run(input) {
        calls.push(input);
        abort.abort();
        return untilAbort(input);
      },
    };
    const stderr = capture();

    await expect(main(['listen', '--binding', 'binding-1'], {
      stdout: new PassThrough(), stderr: stderr.stream, signal: abort.signal, process,
    })).resolves.toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ command: 'khala', args: ['listen', '--binding', 'binding-1'] });
    expect(stderr.output()).toBe('');
  });

  it.each([
    [[]],
    [['listen']],
    [['listen', '--binding']],
    [['listen', 'binding-1']],
    [['send', '--binding', 'binding-1']],
    [['listen', '--binding', 'binding-1', 'extra']],
    [['listen', '--binding', '']],
    [['listen', '--binding', 'binding\n1']],
    [['listen', '--binding', 'a'.repeat(513)]],
    [['listen', '--binding', '\ud800']],
  ])('rejects unsupported arguments without spawning: %j', async argv => {
    let calls = 0;
    const stderr = capture();
    const code = await main(argv, {
      stdout: new PassThrough(),
      stderr: stderr.stream,
      signal: new AbortController().signal,
      process: { async run() { calls += 1; return { code: 0, signal: null, errorCode: null }; } },
    });

    expect(code).toBe(2);
    expect(calls).toBe(0);
    expect(stderr.output()).toBe('{"ok":false,"error":"invalid_arguments"}\n');
  });

  it('reports only stable listener-busy metadata', async () => {
    const stderr = capture();
    const code = await main(['listen', '--binding', 'binding-1'], {
      stdout: new PassThrough(),
      stderr: stderr.stream,
      signal: new AbortController().signal,
      process: { async run() { return { code: 2, signal: null, errorCode: 'listener_busy' }; } },
    });

    expect(code).toBe(2);
    expect(stderr.output()).toBe('{"ok":false,"error":"listener_busy"}\n');
  });

  it.each([
    ['not_connected', 'not_connected'],
    ['storage_failed', 'storage_failed'],
  ] as const)('preserves the structured %s terminal code', async (errorCode, expected) => {
    const stderr = capture();
    const code = await main(['listen', '--binding', 'binding-1'], {
      stdout: new PassThrough(),
      stderr: stderr.stream,
      signal: new AbortController().signal,
      process: { async run() { return { code: 2, signal: null, errorCode }; } },
    });

    expect(code).toBe(2);
    expect(stderr.output()).toBe(`${JSON.stringify({ ok: false, error: expected })}\n`);
  });

  it('reports a bounded spawn failure with its stable code', async () => {
    vi.useFakeTimers();
    const stderr = capture();
    try {
      const completion = main(['listen', '--binding', 'binding-1'], {
        stdout: new PassThrough(),
        stderr: stderr.stream,
        signal: new AbortController().signal,
        process: { async run() { throw new Error('private spawn detail'); } },
      });
      await vi.runAllTimersAsync();

      await expect(completion).resolves.toBe(2);
      expect(stderr.output()).toBe('{"ok":false,"error":"listener_spawn_failed"}\n');
      expect(stderr.output()).not.toContain('private spawn detail');
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs through a package-style symlink without requiring a prebuilt dist', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'khala-fallback-bin-'));
    const executable = path.join(directory, 'khala-fallback');
    const source = fileURLToPath(new URL('./bin.ts', import.meta.url));
    await symlink(source, executable);

    try {
      await expect(execFileAsync(process.execPath, ['--import', 'tsx', executable], {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
      })).rejects.toMatchObject({
        code: 2,
        stderr: '{"ok":false,"error":"invalid_arguments"}\n',
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
