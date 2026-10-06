import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Harness } from '@khala/contracts/m1/agent-join';
import { channelFiles, channelsDir, joinFilePath, readJoinFile, removeJoinFile, writeJoinFile, ensureStateDir, filesForDir, openSessionDir, readJoin, readJson, readStateFile, readStatus, removeSession, removeStateFile, resolveStateDir, saveJoin, saveSession, sessionFiles, StateError, stateRoot, writeJsonAtomic, writeStateFile, writeStatus, type SessionFiles } from './state';

let root: string;
let files: SessionFiles;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'khala-state-'));
  files = await openSessionDir('claude', 'session-1', { XDG_STATE_HOME: root });
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

it('resolves absolute XDG state paths and HOME fallbacks without I/O', () => {
  expect(sessionFiles('claude', 'session-1', { XDG_STATE_HOME: '/tmp/x' }).dir).toBe('/tmp/x/khala/claude/session-1');
  expect(sessionFiles('claude', 'session-1', { HOME: '/h' }).dir).toBe('/h/.local/state/khala/claude/session-1');
  expect(stateRoot({ XDG_STATE_HOME: 'relative', HOME: '/h' })).toBe('/h/.local/state/khala');
  expect(stateRoot({})).toBe(path.join(os.homedir(), '.local/state/khala'));
  expect(resolveStateDir('codex', 'session-1', { XDG_STATE_HOME: root })).toBe(sessionFiles('codex', 'session-1', { XDG_STATE_HOME: root }).dir);
  expect(filesForDir(files.dir)).toEqual(files);
});
it.each(['../x', '', 'a/b', '..', '.hidden', '-x', 'a'.repeat(129)])('rejects unsafe session id %s', id => {
  expect(() => sessionFiles('claude', id)).toThrowError(expect.objectContaining({ code: 'invalid_session_id' }));
});
it('accepts boundary session ids and rejects malformed harnesses', () => {
  expect(() => sessionFiles('codex', 'thr_1:a.b-c')).not.toThrow();
  expect(() => sessionFiles('claude', 'a'.repeat(128))).not.toThrow();
  expect(() => sessionFiles('Gemini' as Harness, 'id')).toThrowError(expect.objectContaining({ code: 'invalid_session_id' }));
  expect(() => sessionFiles('cursor', 'ws-0123')).not.toThrow();
});
it('creates private directories and reopens them', async () => {
  for (const dir of [path.join(root, 'khala'), path.dirname(files.dir), files.dir]) {
    expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
  }
  await ensureStateDir(files.dir);
});
it.each([0, 1, 2])('rejects unsafe existing directory at depth %s without chmod', async depth => {
  const dir = [path.join(root, 'khala'), path.dirname(files.dir), files.dir][depth]!;
  await fs.chmod(dir, 0o755);
  await expect(openSessionDir('claude', 'session-1', { XDG_STATE_HOME: root })).rejects.toMatchObject({ code: 'unsafe_state_dir' });
  expect((await fs.stat(dir)).mode & 0o777).toBe(0o755);
});
it.each([0, 1, 2])('rejects symlinks at depth %s before creating descendants', async depth => {
  const dir = [path.join(root, 'khala'), path.dirname(files.dir), files.dir][depth]!;
  const target = path.join(root, 'target');
  await fs.mkdir(target, { mode: 0o700 });
  await fs.rm(dir, { recursive: true });
  await fs.symlink(target, dir);
  await expect(openSessionDir('claude', 'session-1', { XDG_STATE_HOME: root })).rejects.toMatchObject({ code: 'unsafe_state_dir' });
  expect(await fs.readdir(target)).toEqual([]);
});
it('rejects non-directory state paths', async () => {
  await fs.rm(files.dir, { recursive: true });
  await fs.writeFile(files.dir, 'file');
  await expect(ensureStateDir(files.dir)).rejects.toMatchObject({ code: 'unsafe_state_dir' });
});
it('round trips join atomically with private files and no temporary leftovers', async () => {
  const join = { joinId: 'join', pollSecret: 'secret', confirmUrl: 'https://khala.test/agent/confirm', expiresAt: '2026-10-02T10:00:00Z', link: 'https://khala.test/join/link' };
  await saveJoin(files, join);
  expect(await readJoin(files)).toEqual(join);
  expect((await fs.stat(files.join)).mode & 0o777).toBe(0o600);
  await saveJoin(files, { ...join, joinId: 'replacement' });
  expect(await readJoin(files)).toEqual({ ...join, joinId: 'replacement' });
  expect(await fs.readdir(files.dir)).toEqual(['join.json']);
});
it('removes saved credentials idempotently', async () => {
  const credentials = { homeserver: 'https://khala.test', userId: '@agent:khala.test', accessToken: 'secret', deviceId: 'device', roomId: '!room:khala.test' };
  await saveSession(files, credentials);
  expect(await readJson(files.session)).toEqual(credentials);
  await removeSession(files);
  await removeSession(files);
  expect(await readJson(files.session)).toBeNull();
});
it('writes status with deterministic timestamps and optional channel name', async () => {
  const now = () => new Date('2026-10-02T10:00:00Z');
  const expected = { state: 'send_failed', detail: 'network', owner: { pid: process.pid, startTime: expect.any(String) }, updatedAt: '2026-10-02T10:00:00.000Z' };
  expect(await writeStatus(files, 'send_failed', 'network', now)).toEqual(expected);
  expect(await readStatus(files)).toEqual(expected);
  await writeStatus(files, 'send_failed', 'network', now, 'Release room');
  expect(await readStatus(files)).toEqual({ ...expected, channelName: 'Release room' });
  expect(await writeStatus(files, 'idle', '', now, '')).toEqual({ state: 'idle', updatedAt: expected.updatedAt });
});
it('returns null for absent and malformed JSON', async () => {
  expect(await readJoin(files)).toBeNull();
  await fs.writeFile(files.join, '{');
  expect(await readJson(files.join)).toBeNull();
});
it('cleans temporary files on serialization or rename failures', async () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  await expect(writeJsonAtomic(files.join, cycle)).rejects.toMatchObject({ code: 'storage_failed' });
  expect(await fs.readdir(files.dir)).toEqual([]);
  await fs.mkdir(files.join);
  await expect(writeJsonAtomic(files.join, {})).rejects.toMatchObject({ code: 'storage_failed' });
  expect(await fs.readdir(files.dir)).toEqual(['join.json']);
});
it('supports safe state-file aliases and rejects traversal or unsupported writes', async () => {
  const status = { state: 'idle' };
  await writeStateFile(files.dir, 'status.json', status);
  expect(await readStateFile(files.dir, 'status.json')).toEqual(status);
  await expect(writeStateFile(files.dir, 'evil.json' as 'status.json', status)).rejects.toMatchObject({ code: 'storage_failed' });
  for (const name of ['../status.json', '/status.json', 'status.json/child', 'other.jsonl']) {
    expect(() => readStateFile(files.dir, name)).toThrow(StateError);
    await expect(removeStateFile(files.dir, name)).rejects.toBeInstanceOf(StateError);
  }
  expect(() => readStateFile(files.dir, 'inbox.jsonl')).toThrow(StateError);
  await fs.writeFile(files.inbox, 'old messages');
  await writeStateFile(files.dir, 'cursor.json', { deliveredCount: 1 });
  await removeStateFile(files.dir, 'inbox.jsonl');
  await removeStateFile(files.dir, 'cursor.json');
  await expect(fs.stat(files.inbox)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readStateFile(files.dir, 'cursor.json')).toBeNull();
  await removeStateFile(files.dir, 'join.json');
});

it.each(['channel', 'channels', 'session', 'harness', 'root'])('checks all channel ancestors: %s', async level => {
  const nested = channelFiles(files, '!eco:test');
  await ensureStateDir(nested.dir);
  const dir = { channel: nested.dir, channels: channelsDir(files), session: files.dir, harness: path.dirname(files.dir), root: path.dirname(path.dirname(files.dir)) }[level]!;
  await fs.chmod(dir, 0o755);
  await expect(ensureStateDir(nested.dir)).rejects.toMatchObject({ code: 'unsafe_state_dir' });
});
it.each(['channel', 'channels', 'session'])('rejects open-harness symlink channel ancestor: %s', async level => {
  files = await openSessionDir('opencode', 'session-1', { XDG_STATE_HOME: root });
  const nested = channelFiles(files, '!eco:test');
  await ensureStateDir(nested.dir);
  const dir = { channel: nested.dir, channels: channelsDir(files), session: files.dir }[level]!;
  const target = path.join(root, 'target');
  await fs.mkdir(target, { mode: 0o700 });
  await fs.rm(dir, { recursive: true });
  await fs.symlink(target, dir);
  await expect(ensureStateDir(nested.dir)).rejects.toMatchObject({ code: 'unsafe_state_dir' });
  expect(await fs.readdir(target)).toEqual([]);
});
it('stores and removes independent per-link joins privately', async () => {
  const link = 'https://khala.test/join/one';
  const join = { joinId: 'join', pollSecret: 'secret', confirmUrl: 'https://khala.test/confirm', expiresAt: '2026-10-05T12:00:00Z', link };
  expect(await readJoinFile(files, link)).toBeNull();
  await writeJoinFile(files, link, join);
  await writeJoinFile(files, link + '/two', { ...join, joinId: 'other' });
  expect(await readJoinFile(files, link)).toEqual(join);
  const dir = path.join(files.dir, 'joins');
  expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
  for (const name of await fs.readdir(dir)) {
    expect(name).toMatch(/^[a-f0-9]{24}\.json$/);
    expect((await fs.stat(path.join(dir, name))).mode & 0o777).toBe(0o600);
  }
  await removeJoinFile(files, link);
  await removeJoinFile(files, link);
  expect(await readJoinFile(files, link)).toBeNull();
  expect((await readJoinFile(files, link + '/two'))?.joinId).toBe('other');
});
it.each(['../evil', 'abc', 'A'.repeat(24), 'a'.repeat(25), 'a'.repeat(24) + '.json'])('rejects unsafe join key %s', key => {
  expect(() => joinFilePath(files, key)).toThrowError(expect.objectContaining({ code: 'storage_failed' }));
});
it('allows channel metadata through state-file helpers', async () => {
  await writeStateFile(files.dir, 'channel.json', { roomId: '!eco:test' });
  expect(await readStateFile(files.dir, 'channel.json')).toEqual({ roomId: '!eco:test' });
  await removeStateFile(files.dir, 'channel.json');
  expect(await readStateFile(files.dir, 'channel.json')).toBeNull();
});

it.each(['opencode', 'cline'])('stores sessions and channels under the open harness %s', async harness => {
  const opened = await openSessionDir(harness, 'session-1', { XDG_STATE_HOME: root });
  expect(opened.dir).toBe(path.join(root, 'khala', harness, 'session-1'));
  const channel = channelFiles(opened, '!room:local');
  await ensureStateDir(channel.dir);
  expect((await fs.stat(channel.dir)).isDirectory()).toBe(true);
});
it.each(['Gemini', 'g', '../x', 'ab\n'])('rejects unsafe harness %s', harness => {
  expect(() => sessionFiles(harness, 'session-1')).toThrow(StateError);
});

it('rejects connected status from a dead writer, a reused PID, or a legacy snapshot', async () => {
  for (const owner of [undefined, { pid: 2147483647, startTime: 'dead' }, { pid: process.pid, startTime: 'wrong' }]) {
    await writeJsonAtomic(files.status, { state: 'connected', updatedAt: new Date().toISOString(), owner });
    expect(await readStatus(files)).toMatchObject({ state: 'disconnected', detail: 'process_exited' });
  }
});

it('reports aggregate and channel status disconnected after their writer is killed', async () => {
  const nested = channelFiles(files, '!room:local');
  const source = new URL('./state.ts', import.meta.url).href;
  const script = `import { ensureStateDir, filesForDir, writeStatus } from ${JSON.stringify(source)};
    for (const dir of ${JSON.stringify([files.dir, nested.dir])}) {
      await ensureStateDir(dir); await writeStatus(filesForDir(dir), 'connected');
    }
    process.send('ready'); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const exited = once(child, 'exit');
  try {
    await Promise.race([once(child, 'message'), exited.then(() => { throw new Error('writer exited before ready'); })]);
    for (const target of [files, nested]) {
      expect(await readStatus(target)).toMatchObject({ state: 'connected', owner: { pid: child.pid } });
    }
    child.kill('SIGKILL'); await exited;
    for (const target of [files, nested]) expect(await readStatus(target)).toMatchObject({ state: 'disconnected', detail: 'process_exited' });
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } }
});
