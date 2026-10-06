import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { registerAntigravityWake, createAntigravityWakeDriver, antigravityPromptText } from './antigravity';
import { runWake } from './cli';
import { openSessionDir, type SessionFiles } from '../state';
import { readActivity, writeActivity } from '../activity';
import { recordAttempt, readWakeState, settleAttempts } from './shared/nonce';
import { deliver } from '../../hooks/deliver';
import { wakeLine } from './shared/rules';
import type { WakeDriverContext } from './driver';
import { wakeStatus } from './status';
import { createKhalaTools } from '../mcp/tools';
import type { KhalaAgentClient } from '../client';

let root: string, files: SessionFiles, env: NodeJS.ProcessEnv;
const now = () => new Date('2026-10-05T12:00:00Z');
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'khala-agy-wake-'));
  env = { XDG_STATE_HOME: root, ANTIGRAVITY_CONVERSATION_ID: 'session', ANTIGRAVITY_LS_ADDRESS: 'localhost:1234',
    ANTIGRAVITY_CSRF_TOKEN: 'private-token-never-display', ANTIGRAVITY_AGENTAPI_EXE: '/absolute/agy' };
  files = await openSessionDir('antigravity', 'session', env);
  await writeActivity(files, 'idle', now);
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
const ctx = (): WakeDriverContext => ({ files, harness: 'antigravity', sessionId: 'session', env: { XDG_STATE_HOME: root }, now: now().getTime(), signal: new AbortController().signal });
it('registers privately, sends only the fixed wake line with child-only credentials and suppresses busy wakes', async () => {
  const stdout = vi.fn(), stderr = vi.fn();
  expect(await runWake(['register', '--harness', 'antigravity'], { env, stdout, stderr })).toBe(0);
  const stat = await fs.stat(path.join(files.dir, 'antigravity-wake.json'));
  if (process.platform !== 'win32') expect(stat.mode & 0o777).toBe(0o600);
  const execute = vi.fn(async () => true);
  const driver = createAntigravityWakeDriver(execute);
  expect(await driver.available(ctx())).toBe(true);
  const line = wakeLine('1234abcd');
  await driver.wake(ctx(), line);
  expect(execute).toHaveBeenCalledWith('/absolute/agy', ['agentapi', 'send-message', 'session', line],
    expect.objectContaining({ ANTIGRAVITY_CSRF_TOKEN: env.ANTIGRAVITY_CSRF_TOKEN, ANTIGRAVITY_LS_ADDRESS: env.ANTIGRAVITY_LS_ADDRESS }), expect.any(AbortSignal));
  expect(JSON.stringify([stdout.mock.calls, stderr.mock.calls])).not.toContain(env.ANTIGRAVITY_CSRF_TOKEN);
  expect(JSON.stringify([stdout.mock.calls, stderr.mock.calls])).not.toContain(env.ANTIGRAVITY_LS_ADDRESS);
  expect(ctx().env.ANTIGRAVITY_CSRF_TOKEN).toBeUndefined();
  await writeActivity(files, 'busy', now);
  expect(await driver.wake(ctx(), line)).toBe('skipped');
  expect(execute).toHaveBeenCalledTimes(1);
  await expect(driver.wake(ctx(), 'Channel secret')).rejects.toThrow('invalid_wake_line');
});
it('marks missing/rejected credentials unavailable and registration repairs the driver', async () => {
  const driver = createAntigravityWakeDriver(async () => { throw new Error('private-token-never-display'); });
  expect(await driver.available(ctx())).toBe(false);
  expect(await driver.unavailableReason!(ctx())).toBe('antigravity_credentials_missing');
  await registerAntigravityWake(env);
  expect(await driver.wake(ctx(), wakeLine('1234abcd'))).toBe('skipped');
  expect(await driver.available(ctx())).toBe(false);
  expect(await driver.unavailableReason!(ctx())).toBe('antigravity_credentials_rejected');
  await registerAntigravityWake(env);
  expect(await driver.available(ctx())).toBe(true);
  await fs.chmod(path.join(files.dir, 'antigravity-wake.json'), 0o644);
  if (process.platform !== 'win32') expect(await driver.available(ctx())).toBe(false);
});
it('fails registration without shell variables or for an off-machine address without exposing values', async () => {
  const stdout = vi.fn(), stderr = vi.fn();
  for (const input of [{}, { ...env, ANTIGRAVITY_LS_ADDRESS: 'example.com:1234' }])
    expect(await runWake(['register', '--harness', 'antigravity'], { env: input, stdout, stderr })).toBe(1);
  expect(stdout).not.toHaveBeenCalled();
  expect(JSON.stringify(stderr.mock.calls)).not.toContain('example.com');
});
it('verifies native wake via the captured SYSTEM_MESSAGE shape before marking activity busy', async () => {
  const line = wakeLine('1234abcd');
  const transcriptPath = path.join(root, 'transcript.jsonl');
  await recordAttempt(files.dir, { nonce: '1234abcd', driver: 'antigravity-native', at: now().getTime() - 1, deadline: now().getTime() + 30_000, activityUpdatedAt: now().toISOString() });
  await fs.writeFile(transcriptPath, JSON.stringify({ step_index: 2, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', content: `[Message] sender=system priority=MESSAGE_PRIORITY_HIGH content=${line}` }) + '\n');
  let stdout = '', stderr = '';
  await deliver(JSON.stringify({ conversationId: 'session', invocationNum: 0, transcriptPath }),
    ['--harness', 'antigravity', '--event', 'PreInvocation'], { env, now, stdout: { write: text => { stdout += text; } }, stderr: { write: text => { stderr += text; } } });
  expect(JSON.parse(stdout)).toEqual({}); expect(stderr).toBe('');
  expect((await readWakeState(files.dir))['antigravity-native']).toEqual({ failures: 0 });
  expect((await readActivity(files)).state).toBe('busy');
  await fs.writeFile(transcriptPath, JSON.stringify({ source: 'MODEL', type: 'PLANNER_RESPONSE', content: line }) + '\n');
  expect(await antigravityPromptText({ event: 'prompt', continuation: false, transcriptPath })).toBeUndefined();
});
it('never sends credential values to the channel or MCP status/join output', async () => {
  await registerAntigravityWake(env);
  const send = vi.fn(async () => ({ eventId: '$sent' }));
  const client = { join: async () => ({ state: 'connected', channelName: 'Channel' }),
    status: async () => ({ state: 'connected', unread: 0, idleWake: (await wakeStatus('antigravity', { env, files, sessionId: 'session' }))[0] }),
    send, sendChannelEvent: vi.fn() } as unknown as KhalaAgentClient;
  const tools = createKhalaTools({ harness: 'antigravity', clientFor: async () => client });
  for (const [name, args] of [['khala_join', { link: 'https://example.com' }], ['khala_status', {}]] as const) {
    const result = await tools.find(tool => tool.name === name)!.call(args, { id: 1, notification: false, meta: undefined });
    const text = JSON.stringify(result);
    if (name === 'khala_join') expect(text).toContain('wake register --harness antigravity');
    else expect(text).not.toContain('wake register --harness antigravity');
    expect(text).not.toContain(env.ANTIGRAVITY_CSRF_TOKEN); expect(text).not.toContain(env.ANTIGRAVITY_LS_ADDRESS);
  }
  expect(send).not.toHaveBeenCalled(); expect(client.sendChannelEvent).not.toHaveBeenCalled();
});
it('verifies typed terminal wakes from documented USER_EXPLICIT/USER_INPUT steps, rejecting model/tool echoes', async () => {
  const line = wakeLine('1234abcd');
  const transcriptPath = path.join(root, 'typed.jsonl');
  for (const [source, type, content, expected] of [
    ['USER_EXPLICIT', 'USER_INPUT', line, line],
    ['USER_EXPLICIT', 'USER_INPUT', 'a draft ' + line, ''],
    ['MODEL', 'PLANNER_RESPONSE', line, ''],
    ['SYSTEM_SDK', 'EPHEMERAL_MESSAGE', line, ''],
  ]) {
    await fs.writeFile(transcriptPath, JSON.stringify({ source, type, content }) + '\n');
    expect(await antigravityPromptText({ event: 'prompt', continuation: false, transcriptPath })).toBe(expected || undefined);
  }
});
it('does not overwrite a new registration when an older credential is rejected in flight', async () => {
  await registerAntigravityWake(env);
  let finish!: (accepted: boolean) => void;
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const driver = createAntigravityWakeDriver(async () => { started(); return new Promise<boolean>(resolve => { finish = resolve; }); });
  const attempt = driver.wake(ctx(), wakeLine('1234abcd'));
  await entered;
  await registerAntigravityWake({ ...env, ANTIGRAVITY_CSRF_TOKEN: 'new-token' });
  finish(false); expect(await attempt).toBe('skipped');
  expect(await driver.available(ctx())).toBe(true);
});
it('bounds transcript reads, ignores malformed steps and does not block on non-files', async () => {
  const transcriptPath = path.join(root, 'tail.jsonl');
  const line = wakeLine('1234abcd');
  const step = JSON.stringify({ source: 'SYSTEM', type: 'SYSTEM_MESSAGE', content: line });
  await fs.writeFile(transcriptPath, 'x'.repeat(70 * 1024) + '\nnull\nnot-json\n' + step + '\n');
  expect(await antigravityPromptText({ event: 'prompt', continuation: false, transcriptPath })).toBe(line);
  expect(await antigravityPromptText({ event: 'prompt', continuation: false, transcriptPath: root })).toBeUndefined();
  expect(await antigravityPromptText({ event: 'prompt', continuation: false, transcriptPath: path.join(root, 'missing') })).toBeUndefined();
});

it.each(['tool', 'stop'] as const)('keeps a wake pending across the early prompt and busy polls, then verifies at %s', async next => {
  const transcriptPath = path.join(root, 'delayed.jsonl');
  const line = wakeLine('1234abcd');
  // An older wake in the transcript cannot acknowledge this attempt.
  await fs.writeFile(transcriptPath, JSON.stringify({ source: 'SYSTEM', type: 'SYSTEM_MESSAGE', content: wakeLine('deadbeef') }) + '\n');
  await recordAttempt(files.dir, { nonce: '1234abcd', driver: 'antigravity-native', at: now().getTime() - 1,
    deadline: now().getTime() + 30_000, activityUpdatedAt: now().toISOString() });
  const call = async (event: string, invocationNum: number) => deliver(JSON.stringify({ conversationId: 'session', invocationNum, transcriptPath }),
    ['--harness', 'antigravity', '--event', event], { env, now, stdout: { write: () => {} }, stderr: { write: () => {} } });
  await call('PreInvocation', 0);
  expect((await readActivity(files)).state).toBe('busy');
  expect(await settleAttempts(files.dir, { now: now().getTime() + 1, activity: await readActivity(files) })).toEqual([]);
  expect(JSON.parse(await fs.readFile(path.join(files.dir, 'wake-journal.json'), 'utf8')).attempts).toHaveLength(1);
  expect((await readWakeState(files.dir))['antigravity-native']).toBeUndefined();
  // The real CLI writes this only after the first hook returns.
  await fs.appendFile(transcriptPath, JSON.stringify({ source: 'SYSTEM', type: 'SYSTEM_MESSAGE', content: line }) + '\n');
  await call(next === 'tool' ? 'PreInvocation' : 'Stop', 1);
  expect((await readWakeState(files.dir))['antigravity-native']).toEqual({ failures: 0 });
  expect(JSON.parse(await fs.readFile(path.join(files.dir, 'wake-journal.json'), 'utf8')).attempts).toEqual([]);
});

it('registers stable agy from PATH instead of the running rotated binary', async () => {
  const binDir = path.join(root, 'bin');
  await fs.mkdir(binDir);
  const stable = path.join(binDir, process.platform === 'win32' ? 'agy.exe' : 'agy');
  await fs.writeFile(stable, 'stable', { mode: 0o700 });
  await registerAntigravityWake({ ...env, PATH: binDir, ANTIGRAVITY_AGENTAPI_EXE: '/rotated/agy.1.old' });
  const stored = JSON.parse(await fs.readFile(path.join(files.dir, 'antigravity-wake.json'), 'utf8'));
  expect(stored.command).toBe(stable);
  await registerAntigravityWake({ ...env, PATH: path.join(root, 'missing-bin'), ANTIGRAVITY_AGENTAPI_EXE: '/fallback/agy.1.old' });
  expect(JSON.parse(await fs.readFile(path.join(files.dir, 'antigravity-wake.json'), 'utf8')).command).toBe('/fallback/agy.1.old');
});
