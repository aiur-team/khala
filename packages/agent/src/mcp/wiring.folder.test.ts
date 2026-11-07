import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createKhalaAgentClient } from '../client-impl';
import { channelFiles, ensureStateDir, openSessionDir, readStatus, sessionFiles, writeJsonAtomic, writeStateFile } from '../state';
import type { ChannelSession } from '../transport';
import { readProcess } from '../harness/proc';
import { createRealClientFactory } from './wiring';
import { runMcpCommand } from './main';
import { resolveSession } from './session-id';

let root: string, folder: string, other: string;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'khala-folder-')));
  folder = path.join(root, 'project'); other = path.join(root, 'worktree');
  await fs.mkdir(folder); await fs.mkdir(other);
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

const envFor = (session: string, dir = folder) => ({ XDG_STATE_HOME: path.join(root, 'state'), CLAUDE_PROJECT_DIR: dir, PWD: dir, CLAUDE_CODE_SESSION_ID: session });
const roomId = '!folder:local';
const credentials = { transport: 'local' as const, homeserver: 'http://127.0.0.1:47830', userId: '@agent:local', accessToken: 'private', deviceId: 'device', roomId };
function fakeSession(): ChannelSession & { stop: ReturnType<typeof vi.fn> } {
  return {
    userId: credentials.userId, inviter: () => '@owner:local', displayName: () => 'Agent', roomName: () => 'Folder',
    onMessage: () => () => {}, onListeningModeCommand: () => () => {}, publishListeningMode: async () => {}, waitForInvite: async () => {}, join: async () => {},
    history: async () => ({ messages: [] }), send: async () => ({ eventId: '$send' }), sendChannelEvent: async () => ({ eventId: '$event' }), stop: vi.fn(async () => {}),
  };
}
const joinApi = () => ({
  requestJoin: vi.fn(async (input: { sessionId?: string }) => (void input, { origin: 'http://127.0.0.1:47830', joinId: 'join', pollSecret: 'poll', confirmUrl: 'http://127.0.0.1:47830/confirm', expiresAt: new Date(Date.now() + 600_000).toISOString(), autoConfirmed: true as const })),
  pollJoin: vi.fn(async () => credentials), reportReady: vi.fn(async () => {}),
});

it('a second Claude session in the same folder is the same agent and rejoins without an invite; another folder is not', async () => {
  const api = joinApi();
  const start = vi.fn(async () => fakeSession());
  const factory = (env: NodeJS.ProcessEnv) => createRealClientFactory(env,
    { createClient: options => createKhalaAgentClient({ ...options, env, joinApi: api, startSession: start }) });
  const first = envFor('session-a');
  const agentId = (await resolveSession('claude', undefined, first))!.sessionId;
  expect(agentId).toMatch(/^folder-/);
  const nested = channelFiles(sessionFiles('claude', agentId, first), roomId);
  const a = factory(first)({ harness: 'claude', sessionId: agentId });
  try { await expect(a.join('http://127.0.0.1:47830/join/abcdefgh', 'Claude')).resolves.toMatchObject({ state: 'connected' }); }
  finally { await a.close(); }
  expect(api.requestJoin.mock.calls[0]![0]).toMatchObject({ sessionId: agentId });

  // A new conversation (new session id, e.g. /clear or another account) in the same folder.
  const second = envFor('session-b');
  const input = new PassThrough(), output = new PassThrough();
  const running = runMcpCommand([], { env: second, input, output, createClient: factory(second) });
  try {
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(2), 5_000);
    await vi.waitFor(async () => expect(await readStatus(nested)).toMatchObject({ state: 'connected' }));
    expect(api.requestJoin).toHaveBeenCalledOnce(); // Nobody supplied a link or approved again.
  } finally { input.end(); await running; output.destroy(); }

  // A different folder (or worktree) is a different agent with no channels.
  const elsewhere = envFor('session-a', other);
  const otherId = (await resolveSession('claude', undefined, elsewhere))!.sessionId;
  expect(otherId).not.toBe(agentId);
  const c = factory(elsewhere)({ harness: 'claude', sessionId: otherId });
  try { expect((await c.status()).channels).toEqual([]); } finally { await c.close(); }
});

it('adopts the newest per-session state of a folder on first run and restores it under a new session', async () => {
  const env = envFor('new-session');
  const legacy = await openSessionDir('claude', 'old-session', env);
  const nested = channelFiles(legacy, roomId);
  const secret = 'S'.repeat(43);
  await ensureStateDir(nested.dir);
  await writeStateFile(legacy.dir, 'rejoin.json', { secret });
  await writeStateFile(nested.dir, 'channel.json', { roomId, channelName: 'Folder', joinedAt: new Date().toISOString() });
  await writeStateFile(nested.dir, 'resume.json', { link: 'http://127.0.0.1:47830/join/abcdefgh', label: 'Agent', roomId,
    workspace: folder, secretHash: createHash('sha256').update(secret).digest('hex'), localCredentials: credentials });
  const start = vi.fn(async () => fakeSession());
  const input = new PassThrough(), output = new PassThrough();
  const running = runMcpCommand([], { env, input, output, createClient: createRealClientFactory(env,
    { createClient: options => createKhalaAgentClient({ ...options, env, startSession: start }) }) });
  try {
    await vi.waitFor(async () => expect(await readStatus(nested)).toMatchObject({ state: 'connected' }));
    expect((await resolveSession('claude', undefined, env))!.sessionId).toBe('old-session');
  } finally { input.end(); await running; output.destroy(); }
});

it('stands down when a newer session in the folder claims the agent, and says it was superseded', async () => {
  const env = envFor('session-a');
  const api = joinApi();
  const session = fakeSession();
  const agentId = (await resolveSession('claude', undefined, env))!.sessionId;
  const files = sessionFiles('claude', agentId, env);
  const client = createRealClientFactory(env, { supersedePollMs: 20,
    createClient: options => createKhalaAgentClient({ ...options, env, joinApi: api, startSession: async () => session }) })({ harness: 'claude', sessionId: agentId });
  const newer = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  try {
    await expect(client.join('http://127.0.0.1:47830/join/abcdefgh', 'Claude')).resolves.toMatchObject({ state: 'connected' });
    let info = null;
    await vi.waitFor(async () => { info = await readProcess(newer.pid!); expect(info).not.toBeNull(); });
    await writeJsonAtomic(path.join(files.dir, 'owner.json'), { pid: newer.pid, startTime: info!.startTime });
    await vi.waitFor(() => expect(session.stop).toHaveBeenCalled());
    await expect(client.status()).rejects.toMatchObject({ code: 'not_connected', message: 'superseded' });
    await vi.waitFor(async () => expect(JSON.parse(await fs.readFile(path.join(files.dir, 'released.json'), 'utf8'))).toMatchObject({ pid: process.pid }));
  } finally { newer.kill(); await client.close(); }
});
