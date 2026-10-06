import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { hookMapSource, processSource, recordHookSession, resolveSources } from './session-sources';
import type { ProcessInfo, ProcessReader } from './proc';
import { deliverCore } from './deliver-core';
import { claude } from './claude';
import * as registry from './index';
import { resolveSession } from '../mcp/session-id';
import { createPlaceholderClient, runMcpCommand, type ClientFactory } from '../mcp/main';
import { readJson, stateRoot, writeJsonAtomic, SESSION_ID_PATTERN } from '../state';

let root: string;
let env: NodeJS.ProcessEnv;
const now = () => new Date('2026-10-05T12:00:00Z');
const row = (pid: number, ppid: number, command: string): ProcessInfo => ({ pid, ppid, command, startTime: `start-${pid}` });
const tree = new Map([
  row(100, 0, 'harness'), row(200, 100, 'bash'), row(300, 200, 'hook'), row(400, 100, 'mcp'),
  row(450, 100, 'zsh'), row(500, 450, 'harness'), row(550, 500, 'sh'), row(560, 550, 'hook'), row(600, 500, 'mcp'),
].map(p => [p.pid, p]));
const readProcess: ProcessReader = async pid => tree.get(pid) ?? null;
const context = (pid = 400) => ({ harness: 'codex', pid, readProcess });
const resolve = (pid = 400) => resolveSources([hookMapSource], undefined, env, context(pid));
const record = (sessionId: string, pid = 300, at = now) => recordHookSession('codex', sessionId, env, { pid, readProcess, now: at, workspace: '/work' });
const file = () => path.join(stateRoot(env), 'codex', '.by-pid', '100.json');
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'khala-u4-')); env = { XDG_STATE_HOME: root }; });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

it('records the hook nearest non-shell ancestor and resolves the MCP sibling with private atomic state', async () => {
  await record('session');
  expect(await readJson(file())).toEqual({ sessionId: 'session', startTime: 'start-100', at: now().toISOString(), workspace: '/work' });
  expect(await resolve()).toEqual({ sessionId: 'session', rejoinable: true });
  expect(SESSION_ID_PATTERN.test('.by-pid')).toBe(false);
  if (process.platform !== 'win32') {
    expect((await fs.stat(file())).mode & 0o777).toBe(0o600);
    expect((await fs.stat(path.dirname(file()))).mode & 0o777).toBe(0o700);
  }
});
it('selects the nearer nested harness entry ahead of the outer one', async () => {
  await record('outer'); await record('inner', 560);
  expect(await resolve(600)).toEqual({ sessionId: 'inner', rejoinable: true });
  expect(await resolve()).toEqual({ sessionId: 'outer', rejoinable: true });
});
it('does not cache missing entries and does not create state on a miss', async () => {
  expect(await resolve()).toBeNull();
  await expect(fs.stat(path.dirname(file()))).rejects.toMatchObject({ code: 'ENOENT' });
  await record('arrived');
  expect(await resolve()).toEqual({ sessionId: 'arrived', rejoinable: true });
});
it('ignores pid reuse, malformed entries, and unsafe session ids without throwing', async () => {
  await record('old');
  for (const entry of [ { sessionId: 'old', startTime: 'wrong', at: now().toISOString() },
    { sessionId: '../unsafe', startTime: 'start-100', at: now().toISOString() },
    { sessionId: 'old', startTime: 'start-100', at: 'invalid' } ]) {
    await writeJsonAtomic(file(), entry); expect(await resolve()).toBeNull();
  }
  await fs.writeFile(file(), 'broken'); expect(await resolve()).toBeNull();
});
it('keeps the session with the latest at when one harness pid changes sessions', async () => {
  await record('first');
  await record('latest', 300, () => new Date('2026-10-05T13:00:00Z'));
  await record('late-old', 300);
  expect(await resolve()).toEqual({ sessionId: 'latest', rejoinable: true });
});
it('uses declared order and does not fall through from a present invalid id', async () => {
  const sources = [{ kind: 'meta' as const, resolve: () => '../bad', rejoinable: () => true }, processSource];
  expect(await resolveSources(sources, undefined, env, context())).toBeNull();
  await record('hook');
  expect(await resolveSources([hookMapSource, processSource], undefined, env, context())).toEqual({ sessionId: 'hook', rejoinable: true });
  expect(await resolveSources([processSource, hookMapSource], undefined, env, context())).toEqual({ sessionId: 'proc-100-start-100', rejoinable: false });
});
it('process identity is tied to the immediate parent and never rejoinable', async () => {
  expect(await resolveSources([processSource], undefined, env, context(600))).toEqual({ sessionId: 'proc-500-start-500', rejoinable: false });
  expect(await resolveSources([processSource], undefined, env, context(999))).toBeNull();
});
it('rejects a symlink mapping directory', async () => {
  if (process.platform === 'win32') return; // Native Windows requires symlink privileges.
  await record('session'); await fs.rm(path.dirname(file()), { recursive: true });
  await fs.symlink(root, path.dirname(file()));
  await expect(resolve()).rejects.toMatchObject({ code: 'unsafe_state_dir' });
});

it.each(['SessionStart', 'UserPromptSubmit'])('records %s before a session has joined', async hook_event_name => {
  const stdout = vi.fn(); const stderr = vi.fn();
  await deliverCore(JSON.stringify({ hook_event_name, session_id: 'first', cwd: '/work' }), { ...claude, id: 'codex', sessionSources: [hookMapSource] },
    { stdout: { write: stdout }, stderr: { write: stderr }, env, now, pid: 300, readProcess });
  expect(await resolve()).toEqual({ sessionId: 'first', rejoinable: true });
  expect(stdout).not.toHaveBeenCalled(); expect(stderr).not.toHaveBeenCalled();
});

it('retries per tool call after hook delivery and switches to the newer session through the real MCP server', async () => {
  // Only OS ancestry is simulated; codec, hook persistence, adapter resolution, tools and transport are real.
  const source = { ...hookMapSource, resolve: (meta: Readonly<Record<string, unknown>> | undefined, sourceEnv: NodeJS.ProcessEnv) =>
    hookMapSource.resolve(meta, sourceEnv, context()) };
  const adapter = { ...claude, id: 'codex', sessionSources: [source], restoreAtStartup: false };
  const original = registry.adapterFor;
  vi.spyOn(registry, 'adapterFor').mockImplementation(id => id === 'codex' ? adapter : original(id));
  const input = new PassThrough();
  let text = '';
  const output = new Writable({ write(chunk, _encoding, done) { text += chunk.toString(); done(); } });
  const createClient = vi.fn<ClientFactory>(createPlaceholderClient);
  const running = runMcpCommand(['--harness', 'codex'], { input, output, env, createClient });
  const call = (id: number) => input.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'khala_status', arguments: {} } }) + '\n');
  try {
    call(1); await vi.waitFor(() => expect(text.split('\n').filter(Boolean)).toHaveLength(1));
    const first = JSON.parse(text.trim());
    expect(first.result.structuredContent).toEqual({ error: 'session_unknown', hint: 'Send the agent one message first, then retry.' });
    expect(createClient).not.toHaveBeenCalled();
    const hookIO = { stdout: { write: vi.fn() }, stderr: { write: vi.fn() }, env, now, pid: 300, readProcess };
    await deliverCore('{"hook_event_name":"UserPromptSubmit","session_id":"joined"}', adapter, hookIO);
    call(2); await vi.waitFor(() => expect(createClient).toHaveBeenCalledExactlyOnceWith({ harness: 'codex', sessionId: 'joined', rejoinable: true }));
    await deliverCore('{"hook_event_name":"UserPromptSubmit","session_id":"second"}', adapter, hookIO);
    call(3); await vi.waitFor(() => expect(createClient).toHaveBeenCalledTimes(2));
    expect(createClient.mock.calls[1]![0]).toEqual({ harness: 'codex', sessionId: 'second', rejoinable: true });
    expect(await resolveSession('codex', undefined, env)).toEqual({ sessionId: 'second', rejoinable: true });
  } finally { input.end(); await running; output.destroy(); }
});
