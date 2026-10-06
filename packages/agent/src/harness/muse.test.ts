import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { harnessInfo } from '@khala/contracts/m1/harness';
import { muse } from './muse';
import { deliver } from '../../hooks/deliver';
import { deliverCore } from './deliver-core';
import { resolveSources, recordHookSession } from './session-sources';
import { openSessionDir, writeStatus } from '../state';

const fixtures = new URL('../../../../docs/build/multi-harness/spikes/muse-fixtures/hooks/', import.meta.url);
it('reuses the codec for all captured Muse hooks, with nested context and continuation protection', async () => {
  for (const name of ['SessionStart.1', 'UserPromptSubmit.1', 'PostToolUse.1', 'PostToolUse.2', 'PostToolUse.3', 'Stop.1', 'Stop.2']) {
    const text = await fs.readFile(new URL(`${name}.stdin.json`, fixtures), 'utf8');
    const input = JSON.parse(text);
    expect(muse.codec!.parse(text)).toMatchObject({ sessionId: input.session_id, continuation: input.stop_hook_active === true });
  }
  expect(JSON.parse(muse.codec!.render('tool', 'frame'))).toEqual({ hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: 'frame' } });
  expect(JSON.parse(muse.codec!.render('stop', 'frame'))).toEqual({ decision: 'block', reason: 'frame' });
  expect(harnessInfo('muse')).toMatchObject({ steer: true, sync: true, idleWake: 'default' });
  expect(muse.wakeLadder?.map(driver => driver.id)).toEqual(['monitor']);
});

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'khala-muse-adapter-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
it('prioritizes MUSE_SESSION_ID, then uses a hook mapping without requiring a hook environment variable', async () => {
  const env = { XDG_STATE_HOME: root };
  const readProcess = async (pid: number) => ({ pid, ppid: pid === 200 ? 100 : 0, command: pid === 100 ? 'muse' : 'node', startTime: 'start' });
  await recordHookSession('muse', 'hook-session', env, { pid: 200, readProcess });
  expect(await resolveSources(muse.sessionSources, undefined, { ...env, MUSE_SESSION_ID: 'mcp-session' }, { harness: 'muse', pid: 200, readProcess }))
    .toEqual({ sessionId: 'mcp-session', rejoinable: true });
  expect(await resolveSources(muse.sessionSources, undefined, env, { harness: 'muse', pid: 200, readProcess }))
    .toEqual({ sessionId: 'hook-session', rejoinable: true });
  expect(await resolveSources(muse.sessionSources, undefined, { ...env, MUSE_SESSION_ID: '../bad' }, { harness: 'muse', pid: 200, readProcess })).toBeNull();
});
it('reminds a joined session at startup without leaking channel content and stays silent after owner removal', async () => {
  const env = { XDG_STATE_HOME: root };
  const files = await openSessionDir('muse', 'session', env);
  await fs.writeFile(files.session, JSON.stringify({ roomId: '!room:test', userId: '@self:test' }));
  await fs.writeFile(files.inbox, '');
  await writeStatus(files, 'connected', undefined, undefined, 'CHANNELMARK');
  let output = '';
  const io = { env, stdout: { write: (text: string) => { output += text; } }, stderr: { write: () => {} }, now: () => new Date() };
  const stdin = JSON.stringify({ session_id: 'session', hook_event_name: 'SessionStart' });
  expect(await deliverCore(stdin, muse, io)).toBe(0);
  expect(output).toContain('wake_delay_ms: 0');
  expect(output).toContain('persistent: true');
  expect(output).toContain('show_lines: true');
  expect(output).toContain("watch --harness muse --session 'session'");
  expect(output).not.toContain('CHANNELMARK');
  await writeStatus(files, 'disconnected', 'removed');
  output = '';
  await deliverCore(stdin, muse, io);
  expect(output).toBe('');
});

it('delivers in custom roots with the captured scrubbed hook environment', async () => {
  const env = { XDG_STATE_HOME: root, XDG_DATA_HOME: path.join(root, 'native-data') };
  const files = await openSessionDir('muse', 'session', env);
  await fs.writeFile(files.inbox, '');
  await fs.writeFile(files.session, JSON.stringify({ roomId: '!joined:test', userId: '@self:test' }));
  await writeStatus(files, 'connected');
  let output = '', error = '';
  const io = { env: { HOME: path.join(root, 'home') }, now: () => new Date(),
    stdout: { write: (text: string) => { output += text; } }, stderr: { write: (text: string) => { error += text; } } };
  await deliver(JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'session' }),
    ['--harness', 'muse', '--state-home', root, '--data-home', env.XDG_DATA_HOME], io);
  expect(error).toBe('');
  expect(output).toContain('wake_delay_ms: 0');
  expect(io.env).toEqual({ HOME: path.join(root, 'home') });
});
