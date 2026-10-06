import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { opencode } from './opencode';
import { deliverCore } from './deliver-core';
import { resolveSources } from './session-sources';
import { openSessionDir } from '../state';
import { appendEntries, readCursor } from '../inbox';
import { applyListeningMode } from '../mode';

let root: string;
const now = () => new Date('2026-10-05T12:00:00Z');
const readProcess = async (pid: number) => pid === 300 || pid === 400
  ? { pid, ppid: 100, command: 'node', startTime: String(pid) }
  : pid === 100 ? { pid, ppid: 0, command: 'opencode', startTime: '100' } : null;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'khala-opencode-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

it.each(['session-start', 'prompt'])('records the %s mapping and prefers stamped metadata', async event => {
  const env = { XDG_STATE_HOME: root };
  const io = { env, now, pid: 300, readProcess, stdout: { write() {} }, stderr: { write() {} } };
  await deliverCore(JSON.stringify({ session_id: 'ses_hook', event }), opencode, io);
  const context = { harness: 'opencode', pid: 400, readProcess };
  expect(await resolveSources(opencode.sessionSources, undefined, env, context)).toEqual({ sessionId: 'ses_hook', rejoinable: true });
  expect(await resolveSources(opencode.sessionSources, { khala_session: 'ses_stamp' }, env, context)).toEqual({ sessionId: 'ses_stamp', rejoinable: true });
  expect(await resolveSources(opencode.sessionSources, { khala_session: '../invalid' }, env, context)).toBeNull();
});
it.each(['sync', 'steer', 'async'] as const)('delivers frames across all OpenCode events in %s', async mode => {
  for (const event of ['session-start', 'prompt', 'post-tool', 'turn-end', 'idle']) {
    const env = { XDG_STATE_HOME: root };
    const files = await openSessionDir('opencode', `ses_${event}`, env);
    await applyListeningMode(files, mode, { changedBy: 'owner', eventId: '$mode' }, now);
    await appendEntries(files, [{ eventId: '$message', roomId: '!room', ts: now().toISOString(),
      sender: '@maya', senderLabel: 'Maya', senderKind: 'human', kind: 'message', body: 'hello OpenCode' }]);
    let stdout = '', stderr = '';
    await deliverCore(JSON.stringify({ session_id: `ses_${event}`, event }), opencode,
      { env, now, pid: 300, readProcess, stdout: { write: text => { stdout += text; } }, stderr: { write: text => { stderr += text; } } });
    const delivers = mode !== 'async' && event !== 'session-start' && (event !== 'post-tool' || mode === 'steer');
    expect(stdout.includes('<khala-channel-messages')).toBe(delivers);
    if (delivers && ['idle', 'turn-end'].includes(event)) expect(stdout).toMatch(/^Khala: channel messages are waiting\. Continue\. \(k-[a-f0-9]{8}\)\n/);
    expect((await readCursor(files)).deliveredCount).toBe(delivers ? 1 : 0);
    expect(stderr).toBe('');
  }
});
