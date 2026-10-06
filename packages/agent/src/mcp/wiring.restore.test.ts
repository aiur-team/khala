import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createKhalaAgentClient } from '../client-impl';
import { writeActivity } from '../activity';
import { channelFiles, ensureStateDir, openSessionDir, readStatus, writeStateFile } from '../state';
import type { ChannelSession, SessionMessage } from '../transport';
import { createCodexWaker } from '../wake/codex';
import { createRealClientFactory } from './wiring';

it('restores a Codex channel and queues an owner message without any tool call', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'khala-startup-wake-'));
  const env = { XDG_STATE_HOME: root };
  const files = await openSessionDir('codex', 'thread', env);
  const roomId = '!channel:local';
  const nested = channelFiles(files, roomId);
  const secret = 'S'.repeat(43);
  const credentials = { transport: 'local' as const, homeserver: 'http://127.0.0.1:47830', userId: '@agent:local', accessToken: 'private', deviceId: 'device', roomId };
  await ensureStateDir(nested.dir);
  await writeStateFile(files.dir, 'rejoin.json', { secret });
  await writeStateFile(nested.dir, 'channel.json', { roomId, channelName: 'Release', joinedAt: new Date().toISOString() });
  await writeStateFile(nested.dir, 'resume.json', { link: 'http://127.0.0.1:47830/join/abcdefgh', label: 'Agent', roomId,
    workspace: process.cwd(), secretHash: createHash('sha256').update(secret).digest('hex'), localCredentials: credentials });
  await writeActivity(files, 'idle');
  let intake: ((message: SessionMessage) => void) | undefined;
  const session: ChannelSession = {
    userId: credentials.userId, inviter: () => '@owner:local', displayName: () => 'Agent', roomName: () => 'Release',
    onMessage(handler) { intake = handler; return () => { intake = undefined; }; },
    onListeningModeCommand: () => () => {}, publishListeningMode: async () => {}, waitForInvite: async () => {}, join: async () => {},
    history: async () => ({ messages: [] }), send: async () => ({ eventId: '$send' }), sendChannelEvent: async () => ({ eventId: '$event' }), stop: async () => {},
  };
  const queue = vi.fn(async () => ({ status: 'queued' as const }));
  const factory = createRealClientFactory(env, {
    createClient: options => createKhalaAgentClient({ ...options, startSession: async () => session }),
    createWaker: options => createCodexWaker({ ...options, port: { run: queue }, probe: async () => ({ available: true }), pollMs: 100_000 }),
  });
  const client = factory({ harness: 'codex', sessionId: 'thread' });
  try {
    await vi.waitFor(async () => expect(await readStatus(nested)).toMatchObject({ state: 'connected' }));
    intake!({ eventId: '$owner', roomId, sender: '@owner:local', ts: Date.now(), type: 'm.room.message', body: '@Agent hello', content: {} });
    await vi.waitFor(() => expect(queue).toHaveBeenCalledOnce());
    expect(queue.mock.calls[0]).toEqual([['queue', '--thread', 'thread', '--message', expect.any(String)], expect.any(AbortSignal)]);
  } finally { await client.close(); await fs.rm(root, { recursive: true, force: true }); }
});

it('keeps the Claude SessionStart reminder after old control returns an unconfirmed restore', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'khala-old-control-'));
  const env = { XDG_STATE_HOME: root };
  const files = await openSessionDir('claude', 'thread', env);
  const roomId = '!channel:hosted';
  const nested = channelFiles(files, roomId);
  const secret = 'S'.repeat(43);
  await ensureStateDir(nested.dir);
  await writeStateFile(files.dir, 'rejoin.json', { secret });
  await writeStateFile(nested.dir, 'channel.json', { roomId, channelName: 'Release', joinedAt: new Date().toISOString() });
  await writeStateFile(nested.dir, 'resume.json', { link: 'https://khala.example/join/abcdefgh', label: 'Agent', roomId,
    workspace: process.cwd(), secretHash: createHash('sha256').update(secret).digest('hex') });
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ joinId: 'pending', pollSecret: 'private',
    confirmUrl: 'https://khala.example/agent/confirm?joinId=pending', expiresAt: new Date(Date.now() + 600_000).toISOString() }), { status: 201 }));
  const start = vi.fn();
  const factory = createRealClientFactory(env, {
    createClient: options => createKhalaAgentClient({ ...options, fetch: fetcher, startSession: start }),
  });
  const client = factory({ harness: 'claude', sessionId: 'thread' });
  try {
    await vi.waitFor(async () => expect(await readStatus(nested)).toMatchObject({ state: 'disconnected', detail: 'rejoin_needed' }));
    expect(fetcher).toHaveBeenCalledOnce(); // No polling of the abandoned server request.
    expect(start).not.toHaveBeenCalled();
    vi.stubEnv('XDG_STATE_HOME', root);
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const { default: sessionStart } = await import('../../hooks/session-start');
      await sessionStart(JSON.stringify({ session_id: 'thread', hook_event_name: 'SessionStart' }), []);
      expect(String(stdout.mock.calls[0]?.[0])).toContain('previously authorized');
    } finally { stdout.mockRestore(); vi.unstubAllEnvs(); }
  } finally { await client.close(); await fs.rm(root, { recursive: true, force: true }); }
});

it('arms Claude before clean-exit restoration and wakes before its first Stop', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'khala-claude-resume-wake-'));
  const env = { XDG_STATE_HOME: root, PWD: process.cwd(), CLAUDE_CODE_ENTRYPOINT: 'cli' };
  const files = await openSessionDir('claude', 'thread', env);
  const roomId = '!resume:local';
  const nested = channelFiles(files, roomId);
  const secret = 'S'.repeat(43);
  const credentials = { transport: 'local' as const, homeserver: 'http://127.0.0.1:47830', userId: '@agent:local', accessToken: 'private', deviceId: 'device', roomId };
  await ensureStateDir(nested.dir);
  await writeStateFile(files.dir, 'rejoin.json', { secret });
  await writeStateFile(nested.dir, 'channel.json', { roomId, channelName: 'Resume', joinedAt: new Date().toISOString() });
  await writeStateFile(nested.dir, 'resume.json', { link: 'http://127.0.0.1:47830/join/abcdefgh', label: 'Agent', roomId,
    workspace: process.cwd(), secretHash: createHash('sha256').update(secret).digest('hex'), localCredentials: credentials });
  let intake: ((message: SessionMessage) => void) | undefined;
  const session: ChannelSession = {
    userId: credentials.userId, inviter: () => '@owner:local', displayName: () => 'Agent', roomName: () => 'Resume',
    onMessage(handler) { intake = handler; return () => { intake = undefined; }; },
    onListeningModeCommand: () => () => {}, publishListeningMode: async () => {}, waitForInvite: async () => {}, join: async () => {},
    history: async () => ({ messages: [] }), send: async () => ({ eventId: '$send' }), sendChannelEvent: async () => ({ eventId: '$event' }), stop: async () => {},
  };
  const firstFactory = createRealClientFactory(env, { createClient: options => createKhalaAgentClient({ ...options, startSession: async () => session }) });
  const first = firstFactory({ harness: 'claude', sessionId: 'thread' });
  let resumed: ReturnType<typeof firstFactory> | undefined;
  let wake: Promise<number> | undefined;
  let releaseRestore: (() => void) | undefined;
  try {
    await vi.waitFor(async () => expect(await readStatus(nested)).toMatchObject({ state: 'connected' }));
    await first.close();
    expect(await readStatus(nested)).toMatchObject({ state: 'disconnected', detail: 'closed' });
    vi.stubEnv('XDG_STATE_HOME', root);
    vi.stubEnv('CLAUDE_CODE_ENTRYPOINT', 'cli');
    vi.stubEnv('PWD', process.cwd());
    const input = JSON.stringify({ session_id: 'thread', hook_event_name: 'SessionStart', source: 'resume' });
    const { default: startHook } = await import('../../hooks/session-start');
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    await writeActivity(files, 'busy');
    await startHook(input, []);
    stdout.mockRestore();
    expect(JSON.parse(await fs.readFile(path.join(files.dir, 'activity.json'), 'utf8'))).toMatchObject({ state: 'idle' });
    const { watch } = await import('../../hooks/claude-wake');
    const stderr = { write: vi.fn() };
    wake = watch(input, [], { env: { ...env, KHALA_WAKE_TEST_POLL_MS: '10', KHALA_WAKE_TEST_DEADLINE_MS: '3000' }, now: () => new Date(), stderr });
    const owner = path.join(files.dir, 'watcher.json');
    await vi.waitFor(async () => expect(JSON.parse(await fs.readFile(owner, 'utf8'))).toMatchObject({ state: 'armed' }));
    const nonce = JSON.parse(await fs.readFile(owner, 'utf8')).nonce;
    const restoring = new Promise<void>(resolve => { releaseRestore = resolve; });
    const secondFactory = createRealClientFactory(env, { createClient: options => createKhalaAgentClient({ ...options, startSession: async () => { await restoring; return session; } }) });
    resumed = secondFactory({ harness: 'claude', sessionId: 'thread' });
    await vi.waitFor(async () => expect(await readStatus(nested)).toMatchObject({ state: 'joining' }));
    expect(JSON.parse(await fs.readFile(owner, 'utf8'))).toMatchObject({ nonce, state: 'armed' });
    releaseRestore!();
    await vi.waitFor(async () => expect(await readStatus(nested)).toMatchObject({ state: 'connected' }));
    intake!({ eventId: '$before-stop', roomId, sender: '@owner:local', ts: Date.now(), type: 'm.room.message', body: '@Agent hello', content: {} });
    expect(await wake).toBe(2);
    expect(stderr.write).toHaveBeenCalledExactlyOnceWith('Khala: new channel messages. They arrive in the next hook context.\n');
    expect(JSON.parse(await fs.readFile(owner, 'utf8'))).toMatchObject({ nonce, state: 'woke' });
  } finally {
    releaseRestore?.();
    await first.close();
    await resumed?.close();
    await wake;
    vi.restoreAllMocks(); vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true });
  }
});
