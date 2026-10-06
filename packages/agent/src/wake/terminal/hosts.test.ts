import { afterEach, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspectKitty, sendKitty } from './kitty';
import { inspectIterm2, iterm2ScriptPath, sendIterm2 } from './iterm2';
import { runTerminalCommand, type CommandRunner } from './process';
import { isEmptyPrompt } from './prompt-guard';
import type { ProcessReader } from '../../harness/proc';
import { kittyLsFixture } from './kitty-fixture';
const pane = { kind: 'kitty' as const, paneId: '9', socket: 'unix:/tmp/kitty', agentPid: 100, capturedAt: new Date().toISOString() };
const signal = new AbortController().signal;
const read: ProcessReader = async pid => ({ pid, ppid: pid === 101 ? 100 : 1, command: 'agent', startTime: '1' });
const ls = JSON.stringify(kittyLsFixture());
const screen = 'transcript\n›\nfooter\x1b[?25h\x1b[2;3H\x1b[?12h';
const runner = (capture = screen): CommandRunner => async (_command, args) => args.at(-1) === 'ls' ? ls : args[0] === '-o' ? 'pts/1\n' : capture;
let dir: string | undefined;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });
it('uses kitty cursor coordinates rather than the footer and checks ancestry', async () => {
 const run = vi.fn(runner());
 expect(await inspectKitty(pane, run, {}, signal, read)).toEqual({ view: { tty: '/dev/pts/1', cursorX: 2, cursorY: 1, line: '›' } });
 expect(run.mock.calls[0]?.[1]).toEqual(['@', '--to', pane.socket, 'ls']);
 expect(run.mock.calls[2]?.[1]).toEqual(['@', '--to', pane.socket, 'get-text', '--match', 'id:9', '--extent', 'screen', '--ansi', '--add-cursor']);
 expect((await inspectKitty(pane, run, {}, signal, async () => null)).reason).toBe('kitty_window_not_owned');
});
it('rejects a foreground process outside the agent ancestry with a separate is_self window', async () => {
 const run: CommandRunner = async (command, args, env, signal) => args.at(-1) === 'ls'
  ? JSON.stringify(kittyLsFixture([100, 101, 60])) : runner()(command, args, env, signal);
 expect(await inspectKitty(pane, run, {}, signal, read)).toEqual({ reason: 'kitty_window_not_owned' });
});
it.each(['tcp:localhost:1234', '', undefined])('refuses kitty socket %s without probing', async socket => {
 const run = vi.fn(runner());
 expect(await inspectKitty({ ...pane, ...(socket === undefined ? { socket: '' } : { socket }) }, run, {}, signal, read)).toEqual({ reason: 'kitty_unix_socket_required' });
 expect(run).not.toHaveBeenCalled();
});
it('fails closed on command errors and absent cursor metadata', async () => {
 expect(await inspectKitty(pane, async () => { throw Error('disabled'); }, {}, signal, read)).toEqual({ reason: 'kitty_probe_failed' });
 expect((await inspectKitty(pane, runner('› '), {}, signal, read)).reason).toBe('kitty_cursor_unavailable');
});
it('preserves dim evidence on kitty placeholders and rejects typed drafts', async () => {
 for (const [styling, expected] of [['\x1b[2m', true], ['', false]] as const) {
  const result = await inspectKitty(pane, runner(`transcript\n› ${styling}Ask Codex to do anything\x1b[?25h\x1b[2;3H\x1b[?12h`), {}, signal, read);
  expect(isEmptyPrompt(result.view!.line, 2, { pattern: /^› ?(Ask Codex to do anything)?$/, cursorColumn: 2 })).toBe(expected);
 }
});
it('fake binaries receive literal kitty and python argv, with separate submission', async () => {
 dir = await mkdtemp(path.join(os.tmpdir(), 'khala-u15-bins-'));
 const log = path.join(dir, 'argv.jsonl');
 for (const name of ['kitten', 'python3']) {
  const binary = path.join(dir, name);
  await writeFile(binary, `#!${process.execPath}\nimport fs from 'node:fs'; fs.appendFileSync(process.env.ARGV_LOG,JSON.stringify(process.argv.slice(2))+'\\n'); console.log('{"status":"sent"}');`);
  await chmod(binary, 0o700);
 }
 const env = { ...process.env, PATH: dir, ARGV_LOG: log };
 await sendKitty(pane, 'fixed; $literal', false, runTerminalCommand, env, signal);
 await sendKitty(pane, 'ignored', true, runTerminalCommand, env, signal);
 const iterm = { ...pane, kind: 'iterm2' as const, paneId: '12345678-abcd-abcd-abcd-123456789abc' };
 const view = { tty: '/dev/ttys001', cursorX: 2, cursorY: 1, line: '›' };
 await sendIterm2(iterm, 'fixed; $literal', false, runTerminalCommand, env, signal, view);
 await sendIterm2(iterm, 'ignored', true, runTerminalCommand, env, signal, view);
 expect((await readFile(log, 'utf8')).trim().split('\n').map(value => JSON.parse(value))).toEqual([
  ['@', '--to', pane.socket, 'send-text', '--match', 'id:9', '--', 'fixed; $literal'],
  ['@', '--to', pane.socket, 'send-text', '--match', 'id:9', '--', '\\r'],
  [iterm2ScriptPath(), iterm.paneId, 'fixed; $literal', JSON.stringify(view)],
  [iterm2ScriptPath(), iterm.paneId, '\r', JSON.stringify(view)],
 ]);
});
it('iTerm reports unavailable API and skips a changed composer', async () => {
 const iterm = { ...pane, kind: 'iterm2' as const };
 expect(await inspectIterm2(iterm, async () => { throw Error('missing'); }, {}, signal)).toEqual({ reason: 'iterm2_python_api_unavailable' });
 expect(await sendIterm2(iterm, 'line', false, async () => '{"status":"not_empty"}', {}, signal,
  { tty: '/dev/ttys001', cursorX: 2, cursorY: 1, line: '›' })).toBe('skipped');
});
