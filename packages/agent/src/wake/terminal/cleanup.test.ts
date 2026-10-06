import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openSessionDir, stateRoot, writeJsonAtomic } from '../../state';
import { writeActivity } from '../../activity';
import { wakeLine, recordAttempt, settleAttempts, readWakeState } from '../shared';
import { createTerminalWakeDriver } from './driver';
import type { CommandRunner } from './process';

it.each(['activity', 'consent', 'ownership', 'draft', 'row', 'column', 'copy', 'abort', 'wezterm'])('cleans only its unchanged owned composer after %s rejection', async kind => {
 const root = await mkdtemp(path.join(os.tmpdir(), 'khala-cleanup-'));
 try {
  const env = { XDG_STATE_HOME: root }, files = await openSessionDir('codex', 'cleanup', env);
  const now = Date.now(), controller = new AbortController();
  const text = wakeLine('1234abcd');
  await writeActivity(files, 'idle', () => new Date(now - 30_000));
  await writeJsonAtomic(path.join(stateRoot(env), 'wake-settings.json'), { consent: { 'codex/terminal': { at: 'now' } }, off: {} });
  await writeJsonAtomic(path.join(files.dir, 'pane.json'), { kind: kind === 'wezterm' ? 'wezterm' : 'tmux', paneId: kind === 'wezterm' ? '7' : '%7', agentPid: 100, agentStartTime: '1', capturedAt: new Date(now).toISOString() });
  let composer = '› ', column = 2, row = 3, owned = true, mode = '0';
  const commands: string[][] = [];
  const run: CommandRunner = async (_command, argv) => {
   commands.push([...argv]);
   if (argv[0] === 'display-message') return `100|${mode}|0|${column}|${row}|/dev/pts/1|0`;
   if (argv[0] === 'capture-pane') return composer;
   if (argv[1] === 'list') return JSON.stringify([{ pane_id: 7, tty_name: '/dev/pts/1', cursor_x: column, cursor_y: row }]);
   if (argv[1] === 'get-text') return composer;
   if (argv.includes('-l') || argv[1] === 'send-text') {
    const value = argv.at(-1)!;
    if (value.startsWith('\x7f')) { composer = composer.slice(0, -value.length); column -= value.length; }
    else { composer += value; column += value.length; }
   }
   if (argv.includes('BSpace')) { composer = composer.slice(0, -Number(argv[argv.indexOf('-N') + 1])); column = 2; }
   return '';
  };
  const driver = createTerminalWakeDriver({ pattern: /^›$/, cursorColumn: 2 }, { run, ownsTerminal: async () => owned,
   readProcess: async pid => ({ pid, ppid: 1, command: 'codex', startTime: '1' }), delay: async () => {
    if (kind === 'activity' || kind === 'wezterm') await writeActivity(files, 'busy', () => new Date(now));
    if (kind === 'consent') await writeJsonAtomic(path.join(stateRoot(env), 'wake-settings.json'), { consent: {}, off: {} });
    if (kind === 'ownership') owned = false;
    if (kind === 'draft') { composer += ' user'; column += 5; }
    if (kind === 'row') row++;
    if (kind === 'column') column--;
    if (kind === 'copy') mode = '1';
    if (kind === 'abort') { controller.abort(); throw new Error('aborted'); }
   } });
  await recordAttempt(files.dir, { nonce: '1234abcd', driver: 'terminal', at: now, deadline: now + 10000 });
  const result = driver.wake({ files, env, harness: 'codex', sessionId: 'cleanup', now, signal: controller.signal }, text);
  if (kind === 'abort') await expect(result).rejects.toThrow('aborted'); else await result;
  const shouldClean = ['activity', 'consent', 'abort', 'wezterm'].includes(kind);
  expect(composer === '› ').toBe(shouldClean);
  expect(commands.some(argv => argv.at(-1) === 'Enter' || argv.at(-1) === '\r')).toBe(false);
  if (kind === 'wezterm') expect(commands.at(-1)).toEqual(['cli', 'send-text', '--pane-id', '7', '--no-paste', '\x7f'.repeat(text.length)]);
  if (shouldClean && kind !== 'wezterm') expect(commands.at(-1)).toEqual(['send-keys', '-t', '%7', '-N', String(text.length), 'BSpace']);
  expect((await readWakeState(files.dir)).terminal?.failures).toBe(1);
  await settleAttempts(files.dir, { now: now + 10000, activity: { state: 'idle', updatedAt: now - 30000 } });
  expect((await readWakeState(files.dir)).terminal?.failures).toBe(1);
 } finally { await rm(root, { recursive: true, force: true }); }
});
