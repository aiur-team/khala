import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { InboxEntry } from '@khala/contracts/m1/inbox';
import { appendEntries } from './inbox';
import { openSessionDir, writeJsonAtomic, writeStatus, type SessionFiles } from './state';
import { mentions, monitorArmed, watchSession } from './watch';

vi.mock('node:fs/promises', { spy: true });

let root: string;
let files: SessionFiles;
let controller: AbortController;
let result: Promise<number> | undefined;
let children: ChildProcess[];
const lines: string[] = [];
const entry = (id: number, body = 'BODYMARK @Owner-Claude', sender = '@peer:local', kind: InboxEntry['kind'] = 'message'): InboxEntry => ({
  eventId: `$${id}`, roomId: '!room:local', ts: new Date().toISOString(), sender,
  senderLabel: 'LABELMARK', senderKind: 'human', kind, body,
});
function start() {
  result = watchSession(files, { signal: controller.signal, write: line => { lines.push(line); } });
  return result;
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'khala-watch-1100-'));
  files = await openSessionDir('claude', 'session', { XDG_STATE_HOME: root });
  await writeJsonAtomic(files.session, { userId: '@self:local', roomId: '!room:local' });
  await writeStatus(files, 'connected', undefined, undefined, 'ecosystem', 'Owner-Claude');
  controller = new AbortController(); lines.length = 0; children = []; result = undefined;
});
afterEach(async () => {
  controller.abort(); await result;
  for (const child of children) child.kill();
  await Promise.all(children.map(child => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise(resolve => child.once('close', resolve))));
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});
// Start returns the long-lived result: launch without awaiting it.
async function armed() {
  start();
  await vi.waitFor(async () => expect(await monitorArmed(files)).toBe(true));
}
it.each(['sync', 'steer'])('emits one content-free line per new peer message in %s', async mode => {
  await writeJsonAtomic(files.mode, { mode });
  await armed();
  await appendEntries(files, [entry(1), entry(2, 'BODYMARK hello'), entry(3, 'BODYMARK', '@self:local'), entry(4, 'BODYMARK', '@peer:local', 'event')]);
  await vi.waitFor(() => expect(lines).toHaveLength(2));
  expect(lines).toEqual([
    'khala: 1 new message in #ecosystem (1 mentions you)\n',
    'khala: 1 new message in #ecosystem (0 mentions you)\n',
  ]);
  expect(lines.join('')).not.toMatch(/BODYMARK|LABELMARK|@peer/);
  await appendEntries(files, [entry(1)]);
  await writeJsonAtomic(files.mode, { mode });
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(lines).toHaveLength(2);
  await expect(fs.readFile(files.cursor)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('stays silent in Async, including mentions, and never replays its observed messages', async () => {
  await writeJsonAtomic(files.mode, { mode: 'async' });
  await armed();
  await appendEntries(files, [entry(1)]);
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(lines).toEqual([]);
  await writeJsonAtomic(files.mode, { mode: 'sync' });
  await appendEntries(files, [entry(2)]);
  await vi.waitFor(() => expect(lines).toHaveLength(1));
});
it('notifies existing unread once on resume and uses the current renamed you name', async () => {
  await appendEntries(files, [entry(1), entry(2)]);
  await writeJsonAtomic(files.cursor, { deliveredCount: 1, lastDeliveredEventId: '$1' });
  await armed();
  await vi.waitFor(() => expect(lines).toHaveLength(1));
  await writeStatus(files, 'connected', undefined, undefined, 'ecosystem\nINJECT', 'New.Name');
  await appendEntries(files, [entry(3, '@New.Name BODYMARK')]);
  await vi.waitFor(() => expect(lines).toHaveLength(2));
  expect(lines[1]).toBe('khala: 1 new message in #ecosystem INJECT (1 mentions you)\n');
});
it.each(['leave', 'remove', 'switch', 'delete'])('exits silently on %s and clears ownership', async action => {
  await armed();
  if (action === 'leave') await fs.unlink(files.session);
  if (action === 'remove') await writeStatus(files, 'disconnected', 'removed');
  if (action === 'switch') await writeJsonAtomic(files.session, { userId: '@self:local', roomId: '!new:local' });
  if (action === 'delete') await fs.rm(files.dir, { recursive: true });
  await expect(result).resolves.toBe(0);
  expect(lines).toEqual([]);
  expect(await monitorArmed(files)).toBe(false);
});
it('ignores corrupt and partial records, then emits when the write completes', async () => {
  await armed();
  await fs.writeFile(files.inbox, 'broken\n' + JSON.stringify(entry(1)));
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(lines).toEqual([]);
  await fs.appendFile(files.inbox, '\n');
  await vi.waitFor(() => expect(lines).toHaveLength(1));
});
it('does not arm when disconnected or missing session credentials', async () => {
  await fs.unlink(files.session);
  expect(await watchSession(files, { signal: controller.signal, write: line => { lines.push(line); } })).toBe(0);
  expect(await monitorArmed(files)).toBe(false);
});
it.each([
  ['@Owner-Claude, hello', 'Owner-Claude', true],
  ['Owner-Claude hello', 'Owner-Claude', true],
  ['@Owner-ClaudeExtra', 'Owner-Claude', false],
  ['@New.Name', 'New.Name', true],
  ['@NewXName', 'New.Name', false],
])('matches the current name literally: %s', (body, name, matches) => {
  expect(mentions(entry(1, body as string), name as string)).toBe(matches);
});
it('dispatches the CLI without stdin, supersedes duplicates, and re-arms after exit', async () => {
  const bin = fileURLToPath(new URL('../bin/khala.mjs', import.meta.url));
  const launch = () => {
    const child = spawn(process.execPath, [bin, 'watch', '--harness', 'claude', '--session', 'session'], {
      env: { ...process.env, XDG_STATE_HOME: root }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    children.push(child);
    let output = '', error = '';
    child.stdout!.on('data', chunk => { output += chunk; });
    child.stderr!.on('data', chunk => { error += chunk; });
    const closed = new Promise<number | null>((resolve, reject) => { child.on('close', resolve); child.on('error', reject); });
    return { child, closed, output: () => output, error: () => error };
  };
  const first = launch();
  await vi.waitFor(async () => expect(await monitorArmed(files)).toBe(true));
  const second = launch();
  await expect(first.closed).resolves.toBe(0);
  expect(first.output()).toBe('');
  second.child.kill();
  await expect(second.closed).resolves.toBe(0);
  expect(await monitorArmed(files)).toBe(false);
  const resumed = launch();
  await vi.waitFor(async () => expect(await monitorArmed(files)).toBe(true));
  await appendEntries(files, [entry(1)]);
  await vi.waitFor(() => expect(resumed.output()).toContain('(1 mentions you)\n'));
  expect(resumed.error()).toBe('');
  await fs.unlink(files.session);
  await expect(resumed.closed).resolves.toBe(0);
});
it('renews without replaying unread messages and notices new events after renewal', async () => {
  await armed();
  await appendEntries(files, [entry(1)]);
  await vi.waitFor(() => expect(lines).toHaveLength(1));
  controller.abort(); await result;
  expect(await monitorArmed(files)).toBe(false);
  controller = new AbortController();
  await armed();
  await appendEntries(files, [entry(2)]);
  await vi.waitFor(() => expect(lines).toHaveLength(2));
  expect(lines).toHaveLength(2);
  await expect(fs.readFile(files.cursor)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('ignores a stale ownership marker whose process is still alive without its lease', async () => {
  await writeJsonAtomic(path.join(files.dir, 'monitor.json'), { nonce: '11111111-1111-1111-1111-111111111111', pid: process.pid });
  expect(await monitorArmed(files)).toBe(false);
});
it.each(['async', 'remove'])('rechecks a %s change racing the inbox read before notifying', async race => {
  await armed();
  const realRead = (await vi.importActual<typeof fs>('node:fs/promises')).readFile;
  let raced = false;
  vi.spyOn(fs, 'readFile').mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
    const content = await realRead(...args);
    if (args[0] === files.inbox && !raced) {
      raced = true;
      if (race === 'async') await writeJsonAtomic(files.mode, { mode: 'async' });
      else await writeStatus(files, 'disconnected', 'removed');
    }
    return content;
  });
  await appendEntries(files, [entry(1)]);
  await vi.waitFor(() => expect(raced).toBe(true));
  if (race === 'remove') await expect(result).resolves.toBe(0);
  else await new Promise(resolve => setTimeout(resolve, 100));
  expect(lines).toEqual([]);
});
it('does not consume a notification when its output stream fails', async () => {
  result = watchSession(files, { signal: controller.signal, write: () => { throw new Error('closed'); } });
  await vi.waitFor(async () => expect(await monitorArmed(files)).toBe(true));
  await appendEntries(files, [entry(1)]);
  await expect(result).resolves.toBe(1);
  controller = new AbortController();
  await armed();
  await vi.waitFor(() => expect(lines).toHaveLength(1));
});

it('still notifies a live append when delivery advances before evaluation', async () => {
  await armed();
  await new Promise(resolve => setTimeout(resolve, 50));
  await appendEntries(files, [entry(1)]);
  await writeJsonAtomic(files.cursor, { deliveredCount: 1, lastDeliveredEventId: '$1' });
  await vi.waitFor(() => expect(lines).toHaveLength(1));
});


it('prints watch help and reports invalid arguments without an internal error', async () => {
  const { default: run, WATCH_USAGE } = await import('./watch');
  const out = vi.spyOn(console, 'log').mockImplementation(() => {});
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    for (const flag of ['--help', '-h']) expect(await run([flag])).toBe(0);
    expect(out).toHaveBeenCalledWith(WATCH_USAGE);
    expect(await run(['--bogus'])).toBe(1);
    expect(err).toHaveBeenCalledWith(`khala: invalid_arguments\n${WATCH_USAGE}`);
    expect(await run(['--session', '--bogus'])).toBe(1);
    expect(err).toHaveBeenCalledWith(`khala: invalid_session_id\n${WATCH_USAGE}`);
    expect(await run(['--harness', 'unknown', '--session', 'valid'])).toBe(1);
    expect(err).toHaveBeenCalledWith(`khala: invalid_harness\n${WATCH_USAGE}`);
  } finally { out.mockRestore(); err.mockRestore(); }
});
