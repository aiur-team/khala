import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createNodeListenerProcess, nodeListenerProcess } from './node-process.js';

function capture() {
  const stream = new PassThrough();
  let text = '';
  stream.on('data', chunk => { text += String(chunk); });
  return { stream, text: () => text };
}

describe('node listener process', () => {
  it('forwards child output and returns its exit without adding arguments', async () => {
    const stdout = capture();
    const stderr = capture();
    const controller = new AbortController();
    const result = await nodeListenerProcess.run({
      command: process.execPath,
      args: ['-e', "process.stdout.write('released\\n'); process.stderr.write('observable\\n')"],
      stdout: stdout.stream,
      stderr: stderr.stream,
      signal: controller.signal,
    });
    expect(result).toEqual({ code: 0, signal: null, errorCode: null });
    expect(stdout.text()).toBe('released\n');
    expect(stderr.text()).toBe('observable\n');
  });

  it('surfaces only the recognized listener-busy error metadata', async () => {
    const stderr = capture();
    const result = await nodeListenerProcess.run({
      command: process.execPath,
      args: ['-e', "process.stderr.write(JSON.stringify({ok:false,error:'listener_busy'})+'\\n'); process.exitCode=2"],
      stdout: new PassThrough(),
      stderr: stderr.stream,
      signal: new AbortController().signal,
    });

    expect(result).toEqual({ code: 2, signal: null, errorCode: 'listener_busy' });
    expect(stderr.text()).toBe('{"ok":false,"error":"listener_busy"}\n');
  });

  it('parses the last non-empty bounded stderr line', async () => {
    const result = await nodeListenerProcess.run({
      command: process.execPath,
      args: ['-e', [
        "process.stderr.write('w'.repeat(2048)+'\\n')",
        "process.stderr.write(JSON.stringify({ok:false,error:'storage_failed'})+'\\n\\n')",
        'process.exitCode=2',
      ].join(';')],
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      signal: new AbortController().signal,
    });

    expect(result).toEqual({ code: 2, signal: null, errorCode: 'storage_failed' });
  });

  it('passes only explicitly allowed environment variables to the child', async () => {
    const stdout = capture();
    const previous = process.env.KHALA_LISTENER_TEST_SECRET;
    process.env.KHALA_LISTENER_TEST_SECRET = 'must-not-leak';
    try {
      await nodeListenerProcess.run({
        command: process.execPath,
        args: ['-e', "process.stdout.write(JSON.stringify({path:process.env.PATH,secret:process.env.KHALA_LISTENER_TEST_SECRET}))"],
        stdout: stdout.stream,
        stderr: new PassThrough(),
        signal: new AbortController().signal,
      });
    } finally {
      if (previous === undefined) delete process.env.KHALA_LISTENER_TEST_SECRET;
      else process.env.KHALA_LISTENER_TEST_SECRET = previous;
    }

    expect(JSON.parse(stdout.text())).toEqual({ path: process.env.PATH });
  });

  it('terminates the child when the listener is stopped', async () => {
    const controller = new AbortController();
    const running = nodeListenerProcess.run({
      command: process.execPath,
      args: ['-e', 'setInterval(() => undefined, 1000)'],
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      signal: controller.signal,
    });
    controller.abort();
    await expect(running).resolves.toMatchObject({ code: null });
  });

  it('escalates to SIGKILL when a child ignores SIGTERM and cleans the parent listener', async () => {
    const baseline = process.listenerCount('exit');
    const controller = new AbortController();
    const stdout = new PassThrough();
    const ready = new Promise<void>(resolve => stdout.once('data', () => resolve()));
    const running = createNodeListenerProcess({ terminationGraceMs: 20 }).run({
      command: process.execPath,
      args: ['-e', "process.on('SIGTERM',()=>{}); process.stdout.write('ready\\n'); setInterval(()=>{},1000)"],
      stdout,
      stderr: new PassThrough(),
      signal: controller.signal,
    });
    await ready;
    controller.abort();

    await expect(running).resolves.toMatchObject({ code: null, signal: 'SIGKILL' });
    expect(process.listenerCount('exit')).toBe(baseline);
  });
});
