import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KhalaAgentClientOptions } from '../client-impl';
import { ensureStateDir, readJoinFile, writeJoinFile, sessionFiles, writeJsonAtomic, writeStateFile, stateRoot } from '../state';
import { createPlaceholderClient, runMcpCommand } from './main';
import { createRealClientFactory } from './wiring';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function environment() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'khala-wiring-'));
  directories.push(dir);
  return { XDG_STATE_HOME: dir, PATH: '' };
}

describe('real MCP client wiring', () => {
  it('wires one waker per session, delegates methods, and closes before stopping', async () => {
    const env = await environment();
    const order: string[] = [];
    const client = createPlaceholderClient();
    client.close = vi.fn(async () => { order.push('close'); });
    client.sendChannelEvent = vi.fn(async () => ({ eventId: '$event' }));
    const waker = { notify: vi.fn(), stop: vi.fn(async () => { order.push('stop'); }) };
    const createWaker = vi.fn(() => waker);
    let options: KhalaAgentClientOptions | undefined;
    const createClient = vi.fn((input: KhalaAgentClientOptions) => { options = input; return client; });
    const factory = createRealClientFactory(env, { createClient, createWaker });
    const wrapped = factory({ harness: 'codex', sessionId: 'thread-1' });
    expect(createWaker.mock.calls).toEqual([[{ files: sessionFiles('codex', 'thread-1', env), threadId: 'thread-1' }]]);
    options?.onInboxAppend?.({} as Parameters<NonNullable<KhalaAgentClientOptions['onInboxAppend']>>[0]);
    expect(waker.notify).toHaveBeenCalledOnce();
    expect(await wrapped.status()).toEqual({ state: 'idle', unread: 0, listeningMode: 'sync', idleWake: { driver: 'queue', state: 'unavailable', reason: 'Codex queue is missing.' } });
    const content = { v: 1, kind: 'test', summary: 'Test', body: 'Test' } as const;
    expect(await wrapped.sendChannelEvent(content)).toEqual({ eventId: '$event' });
    expect(client.sendChannelEvent).toHaveBeenCalledWith(content);
    await wrapped.close();
    expect(order).toEqual(['close', 'stop']);
  });

  it.each(['codex', 'claude'] as const)('preserves %s connection status when wake diagnostics are corrupt', async harness => {
    const env = await environment();
    const files = sessionFiles(harness, 'thread', env);
    await ensureStateDir(files.dir);
    await writeFile(path.join(files.dir, 'wake-journal.json'), 'not-json');
    const client = createRealClientFactory(env, {
      createClient: () => createPlaceholderClient(),
      createWaker: () => ({ notify() {}, async stop() {} }),
    })({ harness, sessionId: 'thread' });
    try {
      expect(await client.status()).toEqual({ state: 'idle', unread: 0, listeningMode: 'sync',
        idleWake: { driver: harness === 'codex' ? 'queue' : 'watcher', state: 'unavailable', reason: 'Wake status is unavailable.' } });
    } finally { await client.close(); }
  });

  it('wires the Claude watcher and terminal ladder to inbox notifications', async () => {
    const env = await environment();
    const waker = { notify: vi.fn(), stop: vi.fn(async () => {}) };
    const createWaker = vi.fn(() => waker);
    const createClient = vi.fn<(options: KhalaAgentClientOptions) => ReturnType<typeof createPlaceholderClient>>(() => createPlaceholderClient());
    const client = createRealClientFactory(env, { createClient, createWaker })({ harness: 'claude', sessionId: 'session-1' });
    expect(createClient.mock.calls[0]![0]).toMatchObject({ harness: 'claude', sessionId: 'session-1', env });
    createClient.mock.calls[0]![0].onInboxAppend?.({} as Parameters<NonNullable<KhalaAgentClientOptions['onInboxAppend']>>[0]);
    expect(waker.notify).toHaveBeenCalledOnce();
    expect(createWaker).toHaveBeenCalledOnce();
    await client.close();
  });

  it('clears stale joins once before delegation and preserves new join state', async () => {
    const env = await environment();
    const files = sessionFiles('claude', 'restart', env);
    await ensureStateDir(files.dir);
    await writeStateFile(files.dir, 'join.json', { expiresAt: '2000-01-01', link: 'old' });
    const client = createPlaceholderClient();
    client.join = vi.fn(async () => {
      await expect(readFile(files.join)).rejects.toMatchObject({ code: 'ENOENT' });
      await writeStateFile(files.dir, 'join.json', { link: 'new' });
      return { state: 'awaiting_confirmation' as const, confirmUrl: 'https://app/agent/confirm?joinId=new' };
    });
    const wrapped = createRealClientFactory(env, { createClient: () => client })({ harness: 'claude', sessionId: 'restart' });
    await wrapped.join('new', 'Agent');
    await wrapped.status();
    expect(JSON.parse(await readFile(files.join, 'utf8'))).toEqual({ link: 'new' });
    await wrapped.close();
  });

  it('stops the waker even if client cleanup rejects', async () => {
    const env = await environment();
    const client = createPlaceholderClient();
    client.close = vi.fn(async () => { throw new Error('close_failed'); });
    const waker = { notify: vi.fn(), stop: vi.fn(async () => {}) };
    const wrapped = createRealClientFactory(env, { createClient: () => client, createWaker: () => waker })({ harness: 'codex', sessionId: 'thread' });
    await expect(wrapped.close()).rejects.toThrow('close_failed');
    expect(waker.stop).toHaveBeenCalledOnce();
  });

  it('stops the waker before rejecting a hung client close', async () => {
    const env = await environment();
    const client = createPlaceholderClient();
    client.close = vi.fn(() => new Promise<void>(() => {}));
    const waker = { notify: vi.fn(), stop: vi.fn(async () => {}) };
    const wrapped = createRealClientFactory(env, { createClient: () => client, createWaker: () => waker })({ harness: 'codex', sessionId: 'hung' });
    await wrapped.status();
    vi.useFakeTimers();
    try {
      const closing = wrapped.close();
      const rejected = expect(closing).rejects.toThrow('cleanup_timeout');
      await vi.advanceTimersByTimeAsync(3999);
      expect(waker.stop).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
      expect(client.close).toHaveBeenCalledOnce();
      expect(waker.stop).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it('aborts an idle stdio command and closes each session once', async () => {
    const env = await environment();
    const input = new PassThrough();
    const signal = new AbortController();
    const client = createPlaceholderClient();
    client.close = vi.fn(async () => {});
    const waker = { notify: vi.fn(), stop: vi.fn(async () => {}) };
    const createClient = vi.fn(() => client);
    const createWaker = vi.fn(() => waker);
    let responses = 0;
    let receivedResponse: () => void = () => {};
    const received = new Promise<void>(resolve => { receivedResponse = resolve; });
    const output = new Writable({ write(_chunk, _encoding, done) {
      if (++responses === 2) receivedResponse();
      done();
    } });
    const running = runMcpCommand(['--harness', 'codex'], {
      input, output, env, signal: signal.signal, createClient: createRealClientFactory(env, { createClient, createWaker }),
    });
    const request = { jsonrpc: '2.0', method: 'tools/call', params: { name: 'khala_status', arguments: {}, _meta: { threadId: 'thread' } } };
    input.write(JSON.stringify({ ...request, id: 1 }) + '\n');
    input.write(JSON.stringify({ ...request, id: 2 }) + '\n');
    await received;
    signal.abort();
    expect(await running).toBe(0);
    expect(createClient).toHaveBeenCalledOnce();
    expect(createWaker).toHaveBeenCalledOnce();
    expect(client.close).toHaveBeenCalledOnce();
    expect(waker.stop).toHaveBeenCalledOnce();
    input.destroy();
    output.destroy();
  });
});


it('clears pending joins at startup and forwards all channel selectors', async () => {
  const env = await environment();
  const files = sessionFiles('claude', 'multi', env);
  await ensureStateDir(files.dir);
  const link = 'http://127.0.0.1:47830/join/link';
  await writeJoinFile(files, link, { link, joinId: 'old', pollSecret: 'old', confirmUrl: 'old', expiresAt: '2020-01-01' });
  const client = createPlaceholderClient();
  client.status = vi.fn(async () => ({ state: 'connected', unread: 0, listeningMode: 'sync' as const }));
  client.read = vi.fn(async () => ({ messages: [] }));
  client.send = vi.fn(async () => ({ eventId: '$send' }));
  client.sendChannelEvent = vi.fn(async () => ({ eventId: '$event' }));
  client.leave = vi.fn(async channel => ({ left: channel, channels: [] }));
  const wrapped = createRealClientFactory(env, { createClient: () => client })({ harness: 'claude', sessionId: 'multi' });
  await wrapped.status('A');
  expect(await readJoinFile(files, link)).toBeNull();
  await wrapped.read(10, '$before', '!A:local');
  await wrapped.send('hi', '#B');
  const event = { v: 1, kind: 'test', summary: 'test', body: 'test' } as const;
  await wrapped.sendChannelEvent(event, 'B');
  await wrapped.leave('A');
  expect(client.status).toHaveBeenCalledWith('A');
  expect(client.read).toHaveBeenCalledWith(10, '$before', '!A:local');
  expect(client.send).toHaveBeenCalledWith('hi', '#B');
  expect(client.sendChannelEvent).toHaveBeenCalledWith(event, 'B');
  expect(client.leave).toHaveBeenCalledWith('A');
  await wrapped.close();
});

it('reports the active Monitor marker only for a joined Claude session', async () => {
  const env = await environment();
  const client = createPlaceholderClient();
  client.status = async () => ({ state: 'connected', unread: 0, listeningMode: 'sync' });
  const wrapped = createRealClientFactory(env, { createClient: () => client })({ harness: 'claude', sessionId: 'monitor' });
  expect(await wrapped.status()).toMatchObject({ watcherArmed: false });
  const files = sessionFiles('claude', 'monitor', env);
  const nonce = '11111111-1111-1111-1111-111111111111';
  await writeJsonAtomic(path.join(files.dir, `monitor-${nonce}.json`), { pid: process.pid, nonce });
  await writeJsonAtomic(path.join(files.dir, 'monitor.json'), { pid: process.pid, nonce });
  expect(await wrapped.status()).toMatchObject({ watcherArmed: true });
  await writeJsonAtomic(path.join(files.dir, 'monitor.json'), { pid: -1, nonce: 'stale' });
  expect(await wrapped.status()).toMatchObject({ watcherArmed: false });
  await wrapped.close();
});


it.each(['codex', 'claude'] as const)('starts restoring %s before any tool call', async harness => {
  const env = await environment();
  const client = createPlaceholderClient();
  client.resume = vi.fn(async () => {});
  const waker = { notify: vi.fn(), stop: vi.fn(async () => {}) };
  const createWaker = vi.fn(() => waker);
  const wrapped = createRealClientFactory(env, { createClient: () => client, createWaker })({ harness, sessionId: 'startup' });
  await vi.waitFor(() => expect(client.resume).toHaveBeenCalledOnce());
  expect(createWaker).toHaveBeenCalledOnce();
  await wrapped.close();
});

it('shares status text with the CLI and attaches one auto-disable notice to a read', async () => {
  const { recordAttempt, settleAttempts, readWakeState } = await import('../wake/shared');
  const { wakeStatus, selectedWakeStatus } = await import('../wake/status');
  const env = await environment();
  const files = sessionFiles('codex', 'notice-session', env);
  const client = createPlaceholderClient();
  client.read = async () => ({ messages: [] });
  const wrapped = createRealClientFactory(env, { createClient: () => client, createWaker: () => ({ notify() {}, async stop() {} }) })({ harness: 'codex', sessionId: 'notice-session' });
  try {
    for (const [nonce, at] of [['12345678', 100], ['abcdef12', 200]] as const) {
      await recordAttempt(files.dir, { driver: 'queue', nonce, at, deadline: at + 10 });
      await settleAttempts(files.dir, { now: at + 10, activity: { state: 'idle', updatedAt: 0 } });
    }
    expect((await wrapped.status()).idleWake).toEqual(selectedWakeStatus(await wakeStatus('codex', { env, files, sessionId: 'notice-session' })));
    expect((await wrapped.read(30)).wakeNotice).toContain('khala wake on --driver queue');
    expect((await wrapped.read(30)).wakeNotice).toBeUndefined();
    expect((await readWakeState(files.dir)).queue?.noticeShown).toBe(true);
  } finally { await wrapped.close(); }
});

it('offers the installed private-prefix Qwen background command on Windows and respects hold', async () => {
  const env = { ...await environment(), QWEN_HOME: await mkdtemp(path.join(os.tmpdir(), 'qwen-wiring-')) };
  directories.push(env.QWEN_HOME);
  const command = '"C:\\private prefix\\node.exe" "C:\\private prefix\\cli.js" watch --harness qwen';
  await ensureStateDir(path.join(stateRoot(env), 'qwen'));
  await writeJsonAtomic(path.join(stateRoot(env), 'qwen', 'watch-command.json'), { command });
  const client = createPlaceholderClient();
  client.status = async () => ({ state: 'connected', unread: 0 });
  client.join = async () => ({ state: 'connected', channelName: 'test' });
  const wrapped = createRealClientFactory(env, { platform: 'win32', createClient: () => client })({ harness: 'qwen', sessionId: 'windows-session' });
  expect(await wrapped.status()).toMatchObject({ watcherArmed: false, watcherHint: expect.stringContaining('is_background') });
  expect((await wrapped.status()).watcherHint).toContain(JSON.stringify(command + ' --session windows-session'));
  expect(await wrapped.join('link', 'name')).toMatchObject({ watcherHint: expect.stringContaining('run_shell_command') });
  await writeJsonAtomic(path.join(env.QWEN_HOME, 'settings.json'), { agents: { crossSessionInbound: 'hold' } });
  expect((await wrapped.status()).watcherHint).toBeUndefined();
  await wrapped.close();
});
