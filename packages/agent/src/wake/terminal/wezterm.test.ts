import { afterEach, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspectWezterm, sendWezterm } from './wezterm';
import { runTerminalCommand } from './process';
const pane = { kind: 'wezterm' as const, paneId: '9', agentPid: 100, capturedAt: new Date().toISOString() };
const signal = new AbortController().signal;
let dir: string | undefined;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });
it('uses cursor row rather than a footer or last nonblank line', async () => {
 const run = vi.fn(async (_command: string, args: readonly string[]) => args[1] === 'list' ? JSON.stringify([{ pane_id: 9, tty_name: '/dev/pts/1', cursor_x: 2, cursor_y: 4 }]) : '› ');
 expect(await inspectWezterm(pane, run, {}, signal)).toEqual({ view: { tty: '/dev/pts/1', cursorX: 2, cursorY: 4, line: '› ' } });
 expect(run.mock.calls[1]?.[1]).toEqual(['cli', 'get-text', '--pane-id', '9', '--escapes', '--start-line', '4', '--end-line', '4']);
});
it.each([[{ pane_id: 9, cursor_x: 2, cursor_y: 4 }, 'wezterm_tty_unavailable'], [{ pane_id: 9, tty_name: '/dev/pts/1' }, 'wezterm_cursor_unavailable'], [{ pane_id: 8 }, 'wezterm_pane_missing']])('fails closed on unavailable evidence %j', async (row, reason) => {
 const run = vi.fn(async () => JSON.stringify([row]));
 expect(await inspectWezterm(pane, run, {}, signal)).toEqual({ reason }); expect(run).toHaveBeenCalledOnce();
});
it('spawns fake WezTerm with literal argv and a separate carriage return', async () => {
 dir = await mkdtemp(path.join(os.tmpdir(), 'khala-wezterm-bin-'));
 const binary = path.join(dir, 'wezterm'), log = path.join(dir, 'argv.jsonl');
 await writeFile(binary, `#!${process.execPath}\nimport fs from 'node:fs'; fs.appendFileSync(process.env.ARGV_LOG,JSON.stringify(process.argv.slice(2))+'\n');` .replace("+'\n'", "+'\\n'"));
 await chmod(binary, 0o700);
 const env = { ...process.env, PATH: dir, ARGV_LOG: log };
 await sendWezterm(pane, 'fixed; $literal', false, runTerminalCommand, env, signal);
 await sendWezterm(pane, 'ignored', true, runTerminalCommand, env, signal);
 expect((await readFile(log, 'utf8')).trim().split('\n').map(value => JSON.parse(value))).toEqual([['cli', 'send-text', '--pane-id', '9', '--no-paste', 'fixed; $literal'], ['cli', 'send-text', '--pane-id', '9', '--no-paste', '\r']]);
});

it('normalizes the renderer single-row CRLF/reset framing while preserving dim text', async () => {
 const captured = '\x1b(B\x1b[m› \x1b[2mAsk Codex to do anything\r\n\x1b(B\x1b[m\n';
 const run = vi.fn(async (_command: string, args: readonly string[]) => args[1] === 'list'
  ? JSON.stringify([{ pane_id: 9, tty_name: '/dev/pts/1', cursor_x: 2, cursor_y: 4 }]) : captured);
 const result = await inspectWezterm(pane, run, {}, signal);
 expect(result.view?.line).toBe('\x1b[m› \x1b[2mAsk Codex to do anything');
 const { isEmptyPrompt } = await import('./prompt-guard');
 expect(isEmptyPrompt(result.view!.line, 2, { pattern: /^› ?(Ask Codex to do anything)?$/, cursorColumn: 2 })).toBe(true);
});
