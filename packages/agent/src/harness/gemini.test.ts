import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { gemini } from './gemini';
import { deliverCore } from './deliver-core';
import { resolveSources } from './session-sources';
import { openSessionDir, writeStateFile, type SessionFiles } from '../state';
import { appendEntries, readCursor } from '../inbox';
import { readActivity } from '../activity';
import { isEmptyPrompt } from '../wake/terminal/prompt-guard';
import { readPane } from '../wake/terminal/capture';

let root: string, files: SessionFiles;
let env: NodeJS.ProcessEnv;
const now = () => new Date('2026-10-05T12:00:00Z');
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'khala-gemini-'));
  env = { XDG_STATE_HOME: root };
  files = await openSessionDir('gemini', 'session', env);
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
async function emit(id: string) {
  await appendEntries(files, [{ eventId: id, roomId: '!room', ts: now().toISOString(), sender: '@peer',
    senderLabel: 'Peer', senderKind: 'human', kind: 'message', body: id }]);
}
async function hook(event: string, extra = {}) {
  let stdout = '', stderr = '';
  const result = await deliverCore(JSON.stringify({ session_id: 'session', hook_event_name: event, ...extra }), gemini,
    { env, now, stdout: { write: text => { stdout += text; } }, stderr: { write: text => { stderr += text; } } });
  expect(result).toBe(0); expect(stderr).toBe('');
  expect(stdout.trim().split('\n')).toHaveLength(1);
  return JSON.parse(stdout);
}
it('denies each Sync batch once and allows repeats without trusting stop_hook_active', async () => {
  await writeStateFile(files.dir, 'mode.json', { mode: 'sync' });
  await emit('$first');
  expect(await hook('AfterTool')).toEqual({});
  const output = await hook('AfterAgent');
  expect(output.decision).toBe('deny'); expect(output.reason).toContain('$first');
  expect((await readCursor(files)).deliveredCount).toBe(1);
  expect(await hook('AfterAgent')).toEqual({ decision: 'allow' });
  await emit('$second');
  expect((await hook('AfterAgent', { stop_hook_active: true })).reason).toContain('$second');
  expect(await hook('AfterAgent', { stop_hook_active: true })).toEqual({ decision: 'allow' });
  expect((await readCursor(files)).deliveredCount).toBe(2);
  expect((await readActivity(files)).state).toBe('idle');
});
it('delivers Steer context through AfterTool, leaving prompt hooks for activity', async () => {
  await writeStateFile(files.dir, 'mode.json', { mode: 'steer' });
  await emit('$steer');
  expect(await hook('BeforeAgent', { prompt: 'hello' })).toEqual({});
  expect((await readActivity(files)).state).toBe('busy');
  expect((await readCursor(files)).deliveredCount).toBe(0);
  expect((await hook('AfterTool')).hookSpecificOutput.additionalContext).toContain('$steer');
  expect(await hook('AfterTool')).toEqual({});
});
it('keeps async backlog unread', async () => {
  await writeStateFile(files.dir, 'mode.json', { mode: 'async' });
  await emit('$async');
  for (const event of ['BeforeAgent', 'AfterTool', 'AfterAgent']) await hook(event);
  expect((await readCursor(files)).deliveredCount).toBe(0);
});
it('resolves the environment session and rejects invalid explicit identity', async () => {
  expect(await resolveSources(gemini.sessionSources, undefined, { ...env, GEMINI_SESSION_ID: 'session' }, { harness: 'gemini' }))
    .toEqual({ sessionId: 'session', rejoinable: true });
  expect(await resolveSources(gemini.sessionSources, undefined, { ...env, GEMINI_SESSION_ID: '../bad' }, { harness: 'gemini' })).toBeNull();
});
it('captures the terminal and hook-map at SessionStart', async () => {
  const processes = new Map([
    [300, { pid: 300, ppid: 200, command: 'node', startTime: 'child' }],
    [400, { pid: 400, ppid: 100, command: 'node', startTime: 'child' }],
    [200, { pid: 200, ppid: 100, command: 'sh', startTime: 'shell' }],
    [100, { pid: 100, ppid: 0, command: 'gemini', startTime: 'harness' }],
  ]);
  const readProcess = async (pid: number) => processes.get(pid) ?? null;
  await deliverCore('{"session_id":"session","hook_event_name":"SessionStart"}', gemini,
    { env: { ...env, TMUX: '/socket,1,0', TMUX_PANE: '%7' }, now, pid: 300, readProcess,
      stdout: { write: text => { expect(JSON.parse(text)).toEqual({}); } }, stderr: { write: () => { throw new Error('diagnostic'); } } });
  expect(await readPane(files)).toMatchObject({ paneId: '%7', agentPid: 100, agentStartTime: 'harness' });
  expect(await resolveSources(gemini.sessionSources, undefined, env, { harness: 'gemini', pid: 400, readProcess }))
    .toEqual({ sessionId: 'session', rejoinable: true });
});
it('matches U38 empty prompts and refuses a draft or moved cursor', async () => {
  for (const [name, empty] of [['empty', true], ['after-turn', true], ['space', false], ['draft', false]] as const) {
    const capture = await fs.readFile(new URL(`../../../../docs/build/multi-harness/spikes/terminal-hosts/gemini-${name}.cursorline`, import.meta.url), 'utf8');
    const [metadata, ...lines] = capture.trimEnd().split('\n');
    const column = Number(metadata!.match(/cursor_x=(\d+)/)![1]);
    expect(isEmptyPrompt(lines.join('\n'), column, gemini.emptyPrompt), name).toBe(empty);
  }
  expect(isEmptyPrompt(' > draft', 3, gemini.emptyPrompt)).toBe(false);
});
