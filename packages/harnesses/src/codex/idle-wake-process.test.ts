import { EventEmitter } from 'node:events';
import type { SpawnOptions } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { codexIdleWakeArgv } from './idle-wake';
import { createCodexQueueProcessPort, scrubbedQueueEnv } from './idle-wake-process';

const HOST_ENV = {
  PATH: '/usr/bin', HOME: '/home/u', CODEX_HOME: '/home/u/.codex',
  KHALA_MESSAGE: 'marker-body', KHALA_TOKEN: 'secret', KHALA_PEER: 'peer-name', MESSAGE: 'marker-body',
};

function fakeSpawn() {
  const calls: { command: string; argv: readonly string[]; options: SpawnOptions }[] = [];
  const kills: string[] = [];
  let child = new EventEmitter();
  const spawn = (command: string, argv: readonly string[], options: SpawnOptions) => {
    calls.push({ command, argv, options });
    child = new EventEmitter();
    return Object.assign(child, { kill: (signal?: string) => { kills.push(signal ?? ''); return true; } });
  };
  return { spawn, calls, kills, close: (code: number | null) => child.emit('close', code) };
}

describe('codex queue process port', () => {
  it('spawns without a shell and with no message-bearing environment variable', async () => {
    const f = fakeSpawn();
    const port = createCodexQueueProcessPort({ command: '/bin/codex', env: HOST_ENV, spawn: f.spawn });
    const argv = codexIdleWakeArgv('thread-1');
    const pending = port.run(argv, new AbortController().signal);
    f.close(0);
    expect(await pending).toEqual({ status: 'queued' });
    const { options, argv: spawned } = f.calls[0]!;
    expect(spawned).toEqual(argv);
    expect(options.shell).toBe(false);
    expect(options.stdio).toBe('ignore');
    expect(options.env).toEqual({ PATH: '/usr/bin', HOME: '/home/u', CODEX_HOME: '/home/u/.codex' });
    for (const name of ['KHALA_MESSAGE', 'KHALA_TOKEN', 'KHALA_PEER', 'MESSAGE']) expect(options.env).not.toHaveProperty(name);
  });

  it('keeps any variable outside the allowlist out of the child', () => {
    expect(Object.keys(scrubbedQueueEnv({ ...HOST_ENV, EXTRA: 'x' })).sort()).toEqual(['CODEX_HOME', 'HOME', 'PATH']);
  });

  it('reports a non-zero exit, a spawn failure and an already-aborted wake', async () => {
    const f = fakeSpawn();
    const port = createCodexQueueProcessPort({ command: '/bin/codex', env: HOST_ENV, spawn: f.spawn });
    const exited = port.run(['queue'], new AbortController().signal);
    f.close(2);
    expect(await exited).toEqual({ status: 'exited', code: 2 });
    const throwing = createCodexQueueProcessPort({
      command: 'x', env: {}, spawn: () => { throw new Error('ENOENT'); },
    });
    expect(await throwing.run(['queue'], new AbortController().signal)).toEqual({ status: 'not_started' });
    const aborted = new AbortController();
    aborted.abort();
    expect(await port.run(['queue'], aborted.signal)).toEqual({ status: 'not_started' });
  });

  it('stops only the queue child on abort and on timeout', async () => {
    const f = fakeSpawn();
    const abort = new AbortController();
    const port = createCodexQueueProcessPort({ command: '/bin/codex', env: {}, timeoutMs: 5, spawn: f.spawn });
    const timed = port.run(['queue'], abort.signal);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(f.kills).toEqual(['SIGTERM']);
    f.close(null);
    expect(await timed).toEqual({ status: 'lost', cause: 'timeout' });
    const slow = createCodexQueueProcessPort({ command: '/bin/codex', env: {}, spawn: f.spawn });
    const stopped = slow.run(['queue'], abort.signal);
    abort.abort();
    expect(f.kills).toHaveLength(2);
    f.close(null);
    await stopped;
  });
});
