import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  ListenerBusyError,
  ListenerSpawnError,
  ListenerTerminalError,
  createListenerSupervisor,
  type ListenerProcessInput,
  type ListenerProcessPort,
  type ListenerRetry,
} from './supervisor.js';

function blockedUntilAbort(input: ListenerProcessInput): ReturnType<ListenerProcessPort['run']> {
  return new Promise(resolve => {
    if (input.signal.aborted) return resolve({ code: null, signal: 'SIGTERM', errorCode: null });
    input.signal.addEventListener('abort', () => resolve({
      code: null, signal: 'SIGTERM', errorCode: null,
    }), { once: true });
  });
}

describe('listener supervisor', () => {
  it('starts khala listen for one binding without putting message bytes in argv or env', async () => {
    const calls: ListenerProcessInput[] = [];
    const process: ListenerProcessPort = { run(input) { calls.push(input); return blockedUntilAbort(input); } };
    const supervisor = createListenerSupervisor({ process });
    const output = new PassThrough();
    const handle = supervisor.start({ bindingId: 'binding-1', stdout: output, stderr: new PassThrough() });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ command: 'khala', args: ['listen', '--binding', 'binding-1'] });
    expect(Object.keys(calls[0]!)).not.toContain('env');
    expect(() => supervisor.start({ bindingId: 'binding-1', stdout: output, stderr: new PassThrough() }))
      .toThrow(ListenerBusyError);
    expect(() => supervisor.start({ stdout: output, stderr: new PassThrough() }))
      .toThrow(ListenerBusyError);

    handle.stop();
    await handle.completion;
    const replacement = supervisor.start({ bindingId: 'binding-1', stdout: output, stderr: new PassThrough() });
    replacement.stop();
    await replacement.completion;
  });

  it('reconnects with observable bounded exponential backoff', async () => {
    const delays: number[] = [];
    const retries: ListenerRetry[] = [];
    let calls = 0;
    const process: ListenerProcessPort = {
      run(input) {
        calls += 1;
        if (calls < 4) return Promise.resolve({ code: 4, signal: null, errorCode: null });
        return blockedUntilAbort(input);
      },
    };
    const supervisor = createListenerSupervisor({
      process,
      backoff: { initialMs: 10, maximumMs: 25, factor: 2 },
      sleep: async (milliseconds) => { delays.push(milliseconds); },
      onRetry: retry => { retries.push(retry); },
    });
    const handle = supervisor.start({ bindingId: 'binding-1', stdout: new PassThrough(), stderr: new PassThrough() });
    await vi.waitFor(() => expect(calls).toBe(4));

    expect(delays).toEqual([10, 20, 25]);
    expect(retries).toEqual([
      { attempt: 1, delayMs: 10, outcome: 'exit', code: 4, signal: null },
      { attempt: 2, delayMs: 20, outcome: 'exit', code: 4, signal: null },
      { attempt: 3, delayMs: 25, outcome: 'exit', code: 4, signal: null },
    ]);
    handle.stop();
    await handle.completion;
  });

  it('stops after the CLI reports that another listener owns the binding', async () => {
    const retries: ListenerRetry[] = [];
    let calls = 0;
    const process: ListenerProcessPort = {
      run() {
        calls += 1;
        return Promise.resolve({ code: 2, signal: null, errorCode: 'listener_busy' });
      },
    };
    const supervisor = createListenerSupervisor({
      process,
      sleep: async () => undefined,
      onRetry: retry => { retries.push(retry); },
    });
    const handle = supervisor.start({ bindingId: 'binding-1', stdout: new PassThrough(), stderr: new PassThrough() });

    await expect(handle.completion).rejects.toBeInstanceOf(ListenerBusyError);
    expect(calls).toBe(1);
    expect(retries).toEqual([]);
  });

  it('treats every other structured CLI error as terminal', async () => {
    const retries: ListenerRetry[] = [];
    let calls = 0;
    const supervisor = createListenerSupervisor({
      process: { run() { calls += 1; return Promise.resolve({
        code: 2, signal: null, errorCode: 'not_connected',
      }); } },
      onRetry: retry => { retries.push(retry); },
    });
    const handle = supervisor.start({ stdout: new PassThrough(), stderr: new PassThrough() });

    await expect(handle.completion).rejects.toMatchObject({
      name: 'ListenerTerminalError', code: 'not_connected',
    } satisfies Partial<ListenerTerminalError>);
    expect(calls).toBe(1);
    expect(retries).toEqual([]);
  });

  it('retries a spawn failure without exposing the thrown error', async () => {
    const retries: ListenerRetry[] = [];
    let calls = 0;
    const process: ListenerProcessPort = {
      run(input) {
        calls += 1;
        if (calls === 1) throw new Error('secret process detail');
        return blockedUntilAbort(input);
      },
    };
    const supervisor = createListenerSupervisor({
      process,
      sleep: async () => undefined,
      onRetry: retry => { retries.push(retry); },
    });
    const handle = supervisor.start({ stdout: new PassThrough(), stderr: new PassThrough() });
    await vi.waitFor(() => expect(calls).toBe(2));
    expect(retries).toEqual([{ attempt: 1, delayMs: 250, outcome: 'spawn_failed', code: null, signal: null }]);
    expect(JSON.stringify(retries)).not.toContain('secret process detail');
    handle.stop();
    await handle.completion;
  });

  it('bounds consecutive spawn failures without exposing process details', async () => {
    const retries: ListenerRetry[] = [];
    let calls = 0;
    const supervisor = createListenerSupervisor({
      process: { run() { calls += 1; throw new Error(`secret-${calls}`); } },
      maxSpawnFailures: 3,
      sleep: async () => undefined,
      onRetry: retry => { retries.push(retry); },
    });
    const handle = supervisor.start({ stdout: new PassThrough(), stderr: new PassThrough() });

    await expect(handle.completion).rejects.toBeInstanceOf(ListenerSpawnError);
    expect(calls).toBe(3);
    expect(retries).toHaveLength(2);
    expect(JSON.stringify(retries)).not.toContain('secret');
  });

  it('does not reconnect after cancellation', async () => {
    let calls = 0;
    const process: ListenerProcessPort = { run(input) { calls += 1; return blockedUntilAbort(input); } };
    const supervisor = createListenerSupervisor({ process, sleep: async () => undefined });
    const controller = new AbortController();
    const handle = supervisor.start({
      stdout: new PassThrough(), stderr: new PassThrough(), signal: controller.signal,
    });
    controller.abort();
    await handle.completion;
    expect(calls).toBe(1);
  });

  it('cancels a pending retry delay without another process run', async () => {
    const controller = new AbortController();
    let calls = 0;
    const process: ListenerProcessPort = {
      run() {
        calls += 1;
        return Promise.resolve({ code: 4, signal: null, errorCode: null });
      },
    };
    const supervisor = createListenerSupervisor({
      process,
      backoff: { initialMs: 10_000, maximumMs: 10_000, factor: 1 },
      onRetry: () => controller.abort(),
    });
    const handle = supervisor.start({
      stdout: new PassThrough(), stderr: new PassThrough(), signal: controller.signal,
    });

    await handle.completion;
    expect(calls).toBe(1);
  });
});
