import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { deliver } from '../../hooks/deliver';
import { copilot } from './copilot';
import { recordHookSession, resolveSources } from './session-sources';
import { openSessionDir, channelFiles, writeStateFile, ensureStateDir } from '../state';
import { appendEntries, unread } from '../inbox';

it('resolves the native resume session without a hook map', async () => {
  expect(await resolveSources(copilot.sessionSources, undefined,
    { COPILOT_AGENT_SESSION_ID: 'f3a88658-5584-4042-a46d-c41fc4bff823' }, { harness: 'copilot' }))
    .toEqual({ sessionId: 'f3a88658-5584-4042-a46d-c41fc4bff823', rejoinable: true });
});

it('prefers the native session over the hook map and rejects invalid native IDs', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'khala-copilot-session-'));
  const env = { XDG_STATE_HOME: root };
  const readProcess = async (pid: number) => ({ pid, ppid: pid === 300 ? 100 : 0,
    command: pid === 100 ? 'copilot' : 'node', startTime: `start-${pid}` });
  const context = { harness: 'copilot', pid: 300, readProcess };
  try {
    await recordHookSession('copilot', 'hook-session', env, context);
    expect(await resolveSources(copilot.sessionSources, undefined, env, context))
      .toEqual({ sessionId: 'hook-session', rejoinable: true });
    expect(await resolveSources(copilot.sessionSources, undefined, { ...env, COPILOT_AGENT_SESSION_ID: 'native-session' }, context))
      .toEqual({ sessionId: 'native-session', rejoinable: true });
    for (const sessionId of ['', '../unsafe', 'session/other']) {
      expect(await resolveSources(copilot.sessionSources, undefined, { ...env, COPILOT_AGENT_SESSION_ID: sessionId }, context)).toBeNull();
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it('maps real event-less hook payloads to the MCP sibling and guards continuations', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'khala-copilot-hook-'));
  const env = { XDG_STATE_HOME: root };
  const readProcess = async (pid: number) => ({ pid, ppid: pid === 300 || pid === 400 ? 200 : pid === 200 ? 100 : 0,
    command: pid === 200 ? 'bash' : pid === 100 ? 'copilot' : 'node', startTime: `start-${pid}` });
  let stdout = '', stderr = '';
  const io = { env, pid: 300, readProcess, now: () => new Date('2026-10-05T12:00:00Z'),
    stdout: { write: (text: string) => { stdout += text; } }, stderr: { write: (text: string) => { stderr += text; } } };
  const run = async (event: string, extra = {}) => {
    stdout = ''; stderr = '';
    expect(await deliver(JSON.stringify({ sessionId: 'session', cwd: '/work', ...extra }), ['--harness', 'copilot', '--event', event], io)).toBe(0);
    expect(stderr).toBe('');
    return JSON.parse(stdout);
  };
  try {
    expect(await run('userPromptSubmitted')).toEqual({});
    expect(await resolveSources(copilot.sessionSources, undefined, env, { harness: 'copilot', pid: 400, readProcess }))
      .toEqual({ sessionId: 'session', rejoinable: true });
    const files = await openSessionDir('copilot', 'session', env);
    const channel = channelFiles(files, '!room:local');
    await ensureStateDir(channel.dir);
    await writeStateFile(channel.dir, 'channel.json', { roomId: '!room:local', channelName: 'Channel', joinedAt: '2026-10-05T12:00:00Z' });
    await writeStateFile(channel.dir, 'mode.json', { mode: 'sync' });
    await appendEntries(channel, [{ eventId: '$message', roomId: '!room:local', ts: '2026-10-05T12:00:00Z',
      sender: '@maya:local', senderLabel: 'Maya', senderKind: 'human', kind: 'message', body: 'hello' }]);
    expect(await run('agentStop', { stop_hook_active: true })).toEqual({});
    expect((await unread(channel)).entries).toHaveLength(1);
    expect(await run('agentStop')).toMatchObject({ decision: 'block', reason: expect.stringContaining('hello') });
    expect((await unread(channel)).entries).toHaveLength(0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
it('only matches the captured empty terminal prompt', () => {
  expect(copilot.emptyPrompt?.pattern.test('❯ ')).toBe(true);
  expect(copilot.emptyPrompt?.pattern.test('❯ draft')).toBe(false);
  expect(copilot.emptyPrompt?.cursorColumn).toBe(2);
  expect(copilot.wakeLadder?.map(driver => [driver.id, driver.rung, driver.optIn])).toEqual([['terminal', 4, true]]);
});
