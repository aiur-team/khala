import { expect, it, vi } from 'vitest';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runTerminalCommand } from './process';
import { inspectTmux, sendTmux } from './tmux';
const pane = { kind: 'tmux' as const, paneId: '%7', socket: '/private/socket', agentPid: 100, capturedAt: new Date().toISOString() };
const signal = new AbortController().signal;
const read = async (pid: number) => pid === 100 ? { pid, ppid: 50, command: 'codex', startTime: '1' } : pid === 50 ? { pid, ppid: 1, command: 'shell', startTime: '2' } : null;
it('requires pane ancestor and captures exactly the cursor row', async () => {
 const run = vi.fn(async (_command: string, args: readonly string[]) => args.includes('display-message') ? '50\t0\t0\t2\t4\t/dev/pts/1' : args.includes('show-window-options') ? 'off' : '› ');
 expect(await inspectTmux(pane, run, {}, signal, read)).toMatchObject({ cursorX: 2, cursorY: 4, line: '› ' });
 expect(run.mock.calls[2]?.[1]).toEqual(['-S', '/private/socket', 'capture-pane', '-p', '-e', '-t', '%7', '-S', '4', '-E', '4']);
});
it.each(['999\t0\t0\t2\t4\t/dev/pts/1', '50\t1\t0\t2\t4\t/dev/pts/1', '50\t0\t1\t2\t4\t/dev/pts/1'])('refuses reused pane, copy mode or disabled input %s', async query => {
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
