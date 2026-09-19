import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { main } from './main.js';
import type { ListenerProcessInput, ListenerProcessPort } from './listen/supervisor.js';

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
});
