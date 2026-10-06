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
    createWaker: options => createCodexWaker({ ...options, port: { run: queue }, pollMs: 100_000 }),
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
