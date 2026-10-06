import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { filesForDir, writeJsonAtomic, type SessionFiles } from '../../state';
import { capturePane, readPane } from './capture';
import type { ProcessReader } from '../../harness/proc';

let files: SessionFiles;
beforeEach(async () => { files = filesForDir(await mkdtemp(path.join(os.tmpdir(), 'khala-pane-'))); });
afterEach(async () => { await rm(files.dir, { recursive: true, force: true }); });
const readProcess: ProcessReader = async pid => ({
  300: { pid: 300, ppid: 200, command: 'hook', startTime: '3' },
  200: { pid: 200, ppid: 100, command: '/bin/zsh', startTime: '2' },
  100: { pid: 100, ppid: 1, command: 'codex', startTime: '1' },
}[pid] ?? null);
const options = { pid: 300, readProcess, now: () => new Date('2026-10-05T12:00:00Z'), platform: 'linux' as const };
const tmux = { TMUX: '/tmp/socket,with,commas,123,0', TMUX_PANE: '%7', WEZTERM_PANE: '9' };

it('captures the harness ancestor, tmux socket with commas, and private state', async () => {
  expect(await capturePane(files, tmux, options)).toEqual({ kind: 'tmux', paneId: '%7', socket: '/tmp/socket,with,commas', agentPid: 100, agentStartTime: '1', capturedAt: options.now().toISOString() });
  expect((await readPane(files))?.agentPid).toBe(100);
  expect((await stat(path.join(files.dir, 'pane.json'))).mode & 0o777).toBe(0o600);
});
it('captures WezTerm without inventing a socket', async () => {
  expect(await capturePane(files, { WEZTERM_PANE: '9' }, options)).toMatchObject({ kind: 'wezterm', paneId: '9', agentPid: 100 });
});
it.each([{}, { WEZTERM_PANE: '9;evil' }, { TMUX: 'invalid', TMUX_PANE: '%7', WEZTERM_PANE: '9' }, { TMUX: '/tmp/socket,123,0', TMUX_PANE: '%7;evil' }])('plain or malformed hook environment clears a stale target: %j', async env => {
  await capturePane(files, tmux, options);
  expect(await capturePane(files, env, options)).toBeNull();
  expect(await readPane(files)).toBeNull();
});
it('Windows and an inaccessible ancestor never retain a previous capture', async () => {
  await capturePane(files, tmux, options);
  expect(await capturePane(files, tmux, { ...options, platform: 'win32' })).toBeNull();
  await capturePane(files, tmux, options);
  expect(await capturePane(files, tmux, { ...options, readProcess: async () => null })).toBeNull();
  expect(await readPane(files)).toBeNull();
});
it.each([null, {}, { kind: 'tmux', paneId: '%7', agentPid: 0, capturedAt: 'today' }, { kind: 'wezterm', paneId: '9', agentPid: 100, capturedAt: options.now().toISOString(), socket: '/tmp/socket' }])('rejects malformed disk state: %j', async pane => {
  await writeJsonAtomic(path.join(files.dir, 'pane.json'), pane);
  expect(await readPane(files)).toBeNull();
});

it('captures kitty window and socket including unsupported sockets for diagnostics', async () => {
 for (const socket of ['unix:/tmp/kitty', 'tcp:localhost:1234']) {
  expect(await capturePane(files, { KITTY_WINDOW_ID: '9', KITTY_LISTEN_ON: socket }, options)).toMatchObject({ kind: 'kitty', paneId: '9', socket });
  expect((await readPane(files))?.kind).toBe('kitty');
 }
});
it('captures only a valid iTerm session UUID', async () => {
 const uuid = '12345678-abcd-abcd-abcd-123456789abc';
 expect(await capturePane(files, { ITERM_SESSION_ID: `w0t0p0:${uuid}` }, options)).toMatchObject({ kind: 'iterm2', paneId: uuid });
 expect((await readPane(files))?.paneId).toBe(uuid);
 for (const value of [uuid, 'w0t0p0:bad', `other:${uuid}`]) {
  expect(await capturePane(files, { ITERM_SESSION_ID: value }, options)).toBeNull();
 }
});
