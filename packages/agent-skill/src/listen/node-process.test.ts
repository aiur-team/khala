import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { nodeListenerProcess } from './node-process.js';

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
});
