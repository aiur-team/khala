import { expect, it, vi } from 'vitest';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readProcess } from '../../harness/proc';
import { runTerminalCommand } from './process';
import { inspectTmux, sendTmux } from './tmux';
const pane = { kind: 'tmux' as const, paneId: '%7', socket: '/private/socket', agentPid: 100, capturedAt: new Date().toISOString() };
const signal = new AbortController().signal;
const hasTmux = (() => { try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const read = async (pid: number) => pid === 100 ? { pid, ppid: 50, command: 'codex', startTime: '1' } : pid === 50 ? { pid, ppid: 1, command: 'shell', startTime: '2' } : null;
it('requires pane ancestor and captures exactly the cursor row', async () => {
 const run = vi.fn(async (_command: string, args: readonly string[]) => args.includes('display-message') ? '50|0|0|2|4|/dev/pts/1|0' : '› ');
 expect(await inspectTmux(pane, run, {}, signal, read)).toMatchObject({ cursorX: 2, cursorY: 4, line: '› ' });
 expect(run.mock.calls[1]?.[1]).toEqual(['-S', '/private/socket', 'capture-pane', '-p', '-e', '-t', '%7', '-S', '4', '-E', '4']);
});
it.each(['999|0|0|2|4|/dev/pts/1|0', '50|1|0|2|4|/dev/pts/1|0', '50|0|1|2|4|/dev/pts/1|0', '50|0|0|2|4|/dev/pts/1|1'])('refuses reused pane, copy mode or disabled input %s', async query => {
 const run = vi.fn(async () => query);
 expect(await inspectTmux(pane, run, {}, signal, read)).toBeNull(); expect(run).toHaveBeenCalledOnce();
});
it('passes socket and literal text as separate argv without shell interpretation', async () => {
 const run = vi.fn<import('./process').CommandRunner>().mockResolvedValue('');
 await sendTmux(pane, 'fixed; $literal', false, run, {}, signal); await sendTmux(pane, 'ignored', true, run, {}, signal);
 expect(run.mock.calls.map(call => call[1])).toEqual([['-S', '/private/socket', 'send-keys', '-t', '%7', '-l', 'fixed; $literal'], ['-S', '/private/socket', 'send-keys', '-t', '%7', 'Enter']]);
});

it('spawns fake tmux with exact socket and literal argv', async () => {
 const dir = await mkdtemp(path.join(os.tmpdir(), 'khala-tmux-bin-'));
 try {
  const binary = path.join(dir, 'tmux'), log = path.join(dir, 'argv.jsonl');
  await writeFile(binary, `#!${process.execPath}\nimport fs from 'node:fs'; fs.appendFileSync(process.env.ARGV_LOG,JSON.stringify(process.argv.slice(2))+'\\n');`);
  await chmod(binary, 0o700);
  const env = { ...process.env, PATH: dir, ARGV_LOG: log };
  await sendTmux(pane, 'fixed; $literal', false, runTerminalCommand, env, signal);
  await sendTmux(pane, 'ignored', true, runTerminalCommand, env, signal);
  expect((await readFile(log, 'utf8')).trim().split('\n').map(value => JSON.parse(value))).toEqual([['-S', '/private/socket', 'send-keys', '-t', '%7', '-l', 'fixed; $literal'], ['-S', '/private/socket', 'send-keys', '-t', '%7', 'Enter']]);
 } finally { await rm(dir, { recursive: true, force: true }); }
});

it.skipIf(!hasTmux || process.platform === 'win32')('inspects a real private tmux pane with inherited defaults and refuses sync and copy mode', async () => {
 const dir = await mkdtemp(path.join(os.tmpdir(), 'khala-tmux-inspect-'));
 const socket = path.join(dir, 'socket');
 const command = async (...args: string[]) => runTerminalCommand('tmux', ['-S', socket, ...args], process.env, signal);
 try {
  // A small prompt process in a detached private server avoids interacting with
  // any user terminal while exercising actual tmux format/default behavior.
  const prompt = path.join(dir, 'prompt.cjs');
  await writeFile(prompt, "process.stdout.write('❯\u00a0'); setInterval(() => {}, 1000);\n");
  const quoted = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  await command('-f', '/dev/null', 'new-session', '-d', '-s', 'guard', `${quoted(process.execPath)} ${quoted(prompt)}`);
  const info = (await command('display-message', '-p', '-t', 'guard', '#{pane_id}|#{pane_pid}')).trim().split('|');
  const actual = { ...pane, paneId: info[0]!, socket, agentPid: Number(info[1]) };
  await vi.waitFor(async () => {
   expect(await inspectTmux(actual, runTerminalCommand, process.env, signal, readProcess)).toMatchObject({ cursorX: 2, cursorY: 0, line: '❯\u00a0\n' });
  });
  await command('set-window-option', '-t', actual.paneId, 'synchronize-panes', 'on');
  expect(await inspectTmux(actual, runTerminalCommand, process.env, signal, readProcess)).toBeNull();
  await command('set-window-option', '-t', actual.paneId, 'synchronize-panes', 'off');
  await command('copy-mode', '-t', actual.paneId);
  expect(await inspectTmux(actual, runTerminalCommand, process.env, signal, readProcess)).toBeNull();
 } finally {
  await command('kill-server').catch(() => {});
  await rm(dir, { recursive: true, force: true });
 }
});
