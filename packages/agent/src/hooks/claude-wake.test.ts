import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { InboxEntry } from '@khala/contracts/m1/inbox';
import { filesForDir, openSessionDir, writeJsonAtomic, type SessionFiles } from '../state';
import { appendEntries, unreadCount } from '../inbox';
import { writeActivity } from '../activity';
import { DEADLINE_MS, unreadMessages, watch } from '../../hooks/claude-wake';

const bin = fileURLToPath(new URL('../../bin/khala.mjs', import.meta.url));
const input = JSON.stringify({ session_id: 'session', hook_event_name: 'Stop', stop_hook_active: false });
const notice = 'Khala: new channel messages. They arrive in the next hook context.\n';
let root: string;
let files: SessionFiles;
let children: ChildProcess[];
const entry = (id = 1, kind: InboxEntry['kind'] = 'message'): InboxEntry => ({ eventId: `$e${id}`, roomId: '!r:local', ts: '2026-10-01T12:00:00Z', sender: '@s:local', senderLabel: 'Sender', senderKind: 'human', kind, body: 'private body' });
function observe(child: ChildProcess) {
  children.push(child);
  let stdout = '', stderr = '';
  child.stdout!.on('data', chunk => { stdout += chunk; });
  child.stderr!.on('data', chunk => { stderr += chunk; });
  const result = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
  return { child, result };
}
function start(stdin = input, deadline = 3000) {
  const process = observe(spawn(globalThis.process.execPath, [bin, 'hook', 'claude-wake'], {
    env: { ...globalThis.process.env, XDG_STATE_HOME: root, KHALA_WAKE_TEST_POLL_MS: '50', KHALA_WAKE_TEST_DEADLINE_MS: String(deadline) },
  }));
  process.child.stdin!.end(stdin);
  return process;
}
async function watcher() {
  return JSON.parse(await fs.readFile(path.join(files.dir, 'watcher.json'), 'utf8'));
}
async function owner() {
  try { return JSON.parse(await fs.readFile(path.join(files.dir, 'watcher.json'), 'utf8')).nonce as string; }
  catch { return undefined; }
}
async function armed(previous?: string) {
  await vi.waitFor(async () => { const nonce = await owner(); expect(nonce).toBeTruthy(); expect(nonce).not.toBe(previous); }, { timeout: 1500, interval: 10 });
}
async function seed(state: 'idle' | 'busy' = 'idle', entries: InboxEntry[] = []) {
  files = await openSessionDir('claude', 'session', { XDG_STATE_HOME: root });
  await appendEntries(files, entries);
  await writeActivity(files, state);
}
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'khala-wake-')); children = []; });
afterEach(async () => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
  await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise(resolve => child.once('close', resolve))));
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});
it('ignores missing sessions without creating files or entering the timed watcher', async () => {
  const now = vi.fn(() => new Date());
  const stderr = { write: vi.fn() };
  expect(await watch(input, [], { env: { XDG_STATE_HOME: root }, now, stderr })).toBe(0);
  expect(now).not.toHaveBeenCalled();
  expect(stderr.write).not.toHaveBeenCalled();
  expect(await start().result).toEqual({ code: 0, stdout: '', stderr: '' });
  expect(await fs.readdir(root)).toEqual([]);
});
it.each(['garbage', 'null', '{}', '{"session_id":"..","hook_event_name":"Stop"}', '{"session_id":"../x","hook_event_name":"Stop"}', '{"session_id":"session","hook_event_name":"UserPromptSubmit"}'])('silently ignores invalid input %s', async stdin => {
  expect(await start(stdin).result).toEqual({ code: 0, stdout: '', stderr: '' });
  expect(await fs.readdir(root)).toEqual([]);
});
it('wakes within 1s after append, without claiming or changing inbox/cursor/activity', async () => {
  await seed();
  await writeJsonAtomic(files.cursor, { lastDeliveredEventId: null, deliveredCount: 0 });
  const cursor = await fs.readFile(files.cursor);
  const activity = await fs.readFile(path.join(files.dir, 'activity.json'));
  const running = start();
  await armed();
  await sleep(300);
  const appendedAt = Date.now();
  await appendEntries(files, [entry()]);
  const inbox = await fs.readFile(files.inbox);
  expect(await running.result).toEqual({ code: 2, stdout: '', stderr: notice });
  expect(Date.now() - appendedAt).toBeLessThan(1000);
  expect(await watcher()).toMatchObject({ pid: running.child.pid, parentPid: process.pid, state: 'woke' });
  expect(await fs.readFile(files.cursor)).toEqual(cursor);
  expect(await fs.readFile(files.inbox)).toEqual(inbox);
  expect(await fs.readFile(path.join(files.dir, 'activity.json'))).toEqual(activity);
  expect((await fs.stat(path.join(files.dir, 'watcher.json'))).mode & 0o777).toBe(0o600);
  expect((await fs.stat(files.dir)).mode & 0o777).toBe(0o700);
});
it('stays running while busy and wakes within 500ms of idle', async () => {
  await seed('busy', [entry()]);
  const running = start();
  await armed();
  await sleep(1000);
  expect(running.child.exitCode).toBeNull();
  const flippedAt = Date.now();
  await writeActivity(files, 'idle');
  expect(await running.result).toEqual({ code: 2, stdout: '', stderr: notice });
  expect(Date.now() - flippedAt).toBeLessThan(500);
});
it.each(['missing', 'invalid'])('treats %s activity as busy', async variant => {
  await seed('idle', [entry()]);
  const activity = path.join(files.dir, 'activity.json');
  if (variant === 'missing') await fs.unlink(activity); else await fs.writeFile(activity, '{"state":"idle"}');
  expect(await start(input, 200).result).toEqual({ code: 0, stdout: '', stderr: '' });
});
it.each([{ entries: [] }, { entries: [entry(1, 'event')] }])('waits until the 3s deadline for no unread messages: %j', async ({ entries }) => {
  await seed('idle', entries);
  const running = start();
  await armed();
  const armedAt = Date.now();
  await sleep(1000);
  expect(running.child.exitCode).toBeNull();
  expect(await running.result).toEqual({ code: 0, stdout: '', stderr: '' });
  expect(Date.now() - armedAt).toBeGreaterThan(2700);
  expect(Date.now() - armedAt).toBeLessThan(3500);
});
it('supersedes the old watcher within 200ms; only the new watcher wakes', async () => {
  await seed('busy', [entry()]);
  const first = start();
  await armed();
  const firstNonce = await owner();
  const second = start();
  await armed(firstNonce);
  const secondArmed = Date.now();
  expect(await first.result).toEqual({ code: 0, stdout: '', stderr: '' });
  expect(Date.now() - secondArmed).toBeLessThan(200);
  expect(await watcher()).toMatchObject({ pid: second.child.pid, parentPid: process.pid, state: 'armed' });
  await writeActivity(files, 'idle');
  expect(await second.result).toEqual({ code: 2, stdout: '', stderr: notice });
});
it('exits silently within 500ms when the launching parent dies', async () => {
  await seed();
  const exitProbe = path.join(root, 'exit-probe.mjs');
  const exitFile = path.join(root, 'child-exit');
  await fs.writeFile(exitProbe, `import {writeFileSync} from 'node:fs'; if(process.argv[1]===${JSON.stringify(bin)}) process.on('exit',code=>writeFileSync(${JSON.stringify(exitFile)},String(code)));`);
  const launcher = spawn(process.execPath, ['-e', `const {spawn}=require('node:child_process'); const c=spawn(process.execPath,[process.argv[1],'hook','claude-wake'],{stdio:['pipe',process.stdout,process.stderr]}); c.stdin.end(process.argv[2]); setInterval(()=>{},1000);`, bin, input], {
    env: { ...process.env, NODE_OPTIONS: `--import=${exitProbe}`, XDG_STATE_HOME: root, KHALA_WAKE_TEST_POLL_MS: '50', KHALA_WAKE_TEST_DEADLINE_MS: '3000' },
  });
  const running = observe(launcher);
  await armed();
  const killedAt = Date.now();
  launcher.kill();
  // The child holds the inherited pipes open until it notices parent loss.
  const result = await running.result;
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe('');
  expect(await fs.readFile(exitFile, 'utf8')).toBe('0');
  expect((await watcher()).state).toBe('exited');
  expect(Date.now() - killedAt).toBeLessThan(500);
});
it('handles corrupt cursor/lines and wakes only for valid unread messages', async () => {
  await seed();
  await fs.writeFile(files.cursor, '{broken');
  await fs.writeFile(files.inbox, 'broken\n' + JSON.stringify(entry()) + '\n' + JSON.stringify(entry(2)));
  expect(await start().result).toEqual({ code: 2, stdout: '', stderr: notice });
});
it.each([0, 1, 2, 4, -1])('matches inbox unreadCount with cursor %s, corrupt records and a partial tail', async deliveredCount => {
  await seed('idle', [entry(1), entry(2, 'event'), entry(3), entry(4, 'event')]);
  await fs.writeFile(files.inbox, 'broken\nnull\n' + await fs.readFile(files.inbox, 'utf8') + JSON.stringify(entry(5)));
  await writeJsonAtomic(files.cursor, { lastDeliveredEventId: null, deliveredCount });
  expect(await unreadMessages(files.dir)).toBe((await unreadCount(files.dir)).messages);
});
it('silently contains storage and IO errors', async () => {
  await seed('idle', [entry()]);
  await fs.mkdir(files.cursor);
  expect(await start().result).toEqual({ code: 0, stdout: '', stderr: '' });
  expect((await watcher()).state).toBe('exited');
  await fs.rm(files.cursor, { recursive: true });
  expect(await watch(input, [], { env: { XDG_STATE_HOME: root }, now: () => new Date(), stderr: { write: () => { throw Error('failed'); } } })).toBe(0);
  expect((await watcher()).state).toBe('exited');
});
it.each(['busy', 'claimed', 'superseded'])('rechecks %s after observing unread messages', async race => {
  await seed('idle', [entry()]);
  const realRead = fs.readFile;
  let inboxReads = 0;
  vi.spyOn(fs, 'readFile').mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
    const result = await realRead(...args);
    if (args[0] === files.inbox && ++inboxReads === 1) {
      if (race === 'busy') await writeActivity(files, 'busy');
      if (race === 'claimed') await writeJsonAtomic(files.cursor, { lastDeliveredEventId: '$e1', deliveredCount: 1 });
      if (race === 'superseded') await writeJsonAtomic(path.join(files.dir, 'watcher.json'), { nonce: 'new-owner', armedAt: new Date().toISOString() });
    }
    return result;
  });
  const stderr = { write: vi.fn() };
  expect(await watch(input, [], { env: { XDG_STATE_HOME: root, KHALA_WAKE_TEST_DEADLINE_MS: '100', KHALA_WAKE_TEST_POLL_MS: '10' }, now: () => new Date(), stderr })).toBe(0);
  expect(stderr.write).not.toHaveBeenCalled();
});

it('exits silently at the deadline in async despite idle unread messages', async () => {
  await seed('idle', [entry()]);
  await writeJsonAtomic(files.mode, { mode: 'async' });
  expect(await start(input, 250).result).toEqual({ code: 0, stdout: '', stderr: '' });
});
it('keeps polling in async and wakes after switching to sync', async () => {
  await seed('idle', [entry()]);
  await writeJsonAtomic(files.mode, { mode: 'async' });
  const running = start();
  await armed(); await sleep(250);
  expect(running.child.exitCode).toBeNull();
  await writeJsonAtomic(files.mode, { mode: 'sync' });
  expect(await running.result).toEqual({ code: 2, stdout: '', stderr: notice });
});

async function channel(name: string, mode = 'sync', entries = [entry()]) {
  const target = filesForDir(path.join(files.dir, 'channels', name));
  await fs.mkdir(target.dir, { recursive: true, mode: 0o700 });
  await writeJsonAtomic(target.mode, { mode });
  await appendEntries(target, entries);
  return target;
}
it('wakes for sync channel B even when the legacy root is async', async () => {
  await seed();
  await writeJsonAtomic(files.mode, { mode: 'async' });
  await channel('b');
  expect(await start().result).toEqual({ code: 2, stdout: '', stderr: notice });
});
it('does not wake for async channels beside an empty sync channel', async () => {
  await seed();
  await channel('a', 'async');
  await channel('b', 'sync', []);
  expect(await start(input, 200).result).toEqual({ code: 0, stdout: '', stderr: '' });
});
it('counts the legacy inbox and channel inbox separately without advancing cursors', async () => {
  await seed('idle', [entry()]);
  const target = await channel('b', 'steer', [entry(2), entry(3)]);
  await writeJsonAtomic(target.cursor, { deliveredCount: 1, lastDeliveredEventId: '$e2' });
  const cursor = await fs.readFile(target.cursor);
  expect(await unreadMessages(files.dir)).toBe(2);
  expect(await fs.readFile(target.cursor)).toEqual(cursor);
});
it('finds a channel joined after the watcher is armed', async () => {
  await seed();
  const running = start();
  await armed();
  await channel('later');
  expect(await running.result).toEqual({ code: 2, stdout: '', stderr: notice });
});

it('retains backup wake after the former 50-minute deadline', async () => {
  await seed('idle', [entry()]);
  let reads = 0;
  const now = () => new Date(reads++ === 0 ? 0 : 51 * 60 * 1000);
  const stderr = { write: vi.fn() };
  expect(await watch(input, [], { env: { XDG_STATE_HOME: root }, now, stderr })).toBe(2);
  expect(stderr.write).toHaveBeenCalledExactlyOnceWith(notice);
});

it('defaults to a 24-hour deadline and records expiry at its boundary', async () => {
  expect(DEADLINE_MS).toBe(24 * 60 * 60 * 1000);
  await seed('idle', [entry()]);
  let reads = 0;
  const stderr = { write: vi.fn() };
  expect(await watch(input, [], { env: { XDG_STATE_HOME: root }, now: () => new Date(reads++ === 0 ? 0 : DEADLINE_MS), stderr })).toBe(0);
  expect(stderr.write).not.toHaveBeenCalled();
  expect(await watcher()).toMatchObject({ armedAt: new Date(0).toISOString(), pid: process.pid, parentPid: process.ppid, state: 'expired' });
});

it('does not overwrite a re-arm that races the exit-state write', async () => {
  await seed();
  const replacement = { nonce: 'replacement', armedAt: new Date().toISOString(), pid: 123, parentPid: 456, state: 'armed' };
  const realOpen = fs.open;
  vi.spyOn(fs, 'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const file = await realOpen(...args);
    const read = file.readFile.bind(file);
    vi.spyOn(file, 'readFile').mockImplementationOnce(async () => {
      const body = await read('utf8');
      await writeJsonAtomic(path.join(files.dir, 'watcher.json'), replacement);
      return body;
    });
    return file;
  });
  let reads = 0;
  expect(await watch(input, [], { env: { XDG_STATE_HOME: root }, now: () => new Date(reads++ === 0 ? 0 : DEADLINE_MS), stderr: { write: vi.fn() } })).toBe(0);
  expect(await watcher()).toEqual(replacement);
});
