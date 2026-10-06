import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openSessionDir, stateRoot, writeJsonAtomic } from '../../state';
import { appendEntries } from '../../inbox';
import { createWakeLadder } from '../ladder';
import { writeActivity } from '../../activity';
import { wakeLine, readWakeState, recordAttempt, settleAttempts } from '../shared';
import { createClaudeWatcherDriver, createTerminalWakeDriver, promptPrefix } from './driver';
import type { WakeDriverContext } from '../driver';
import type { ProcessReader } from '../../harness/proc';
import type { CommandRunner } from './process';
let root: string, ctx: WakeDriverContext;
let line: string, column: number, mode: string, sync: string, row: number, tty: string;
let calls: string[][];
const at = Date.parse('2026-10-05T12:00:00Z');
const guard = { pattern: /^›$/, cursorColumn: 2 };
const read: ProcessReader = async pid => pid === 100 ? { pid, ppid: 50, command: 'codex', startTime: '1' } : pid === 50 ? { pid, ppid: 1, command: 'shell', startTime: '2' } : null;
const run: CommandRunner = async (_command, argv) => {
  calls.push([...argv]);
  if (argv[0] === 'display-message') return `50|${mode}|0|${column}|${row}|${tty}|${sync === 'on' ? 1 : 0}`;
  // Real tmux drops trailing blank cells from captured rows.
  if (argv[0] === 'capture-pane') return line.replace(/ +$/, '');
  if (argv.includes('-l')) { line = `› ${argv.at(-1)}`; column = line.length; }
  return '';
};
const sends = () => calls.filter(args => args[0] === 'send-keys');
beforeEach(async () => {
 root = await mkdtemp(path.join(os.tmpdir(), 'khala-terminal-driver-'));
 const env = { XDG_STATE_HOME: root };
 ctx = { files: await openSessionDir('codex', 's', env), harness: 'codex', sessionId: 's', env, now: at, signal: new AbortController().signal };
 await writeJsonAtomic(path.join(ctx.files.dir, 'pane.json'), { kind: 'tmux', paneId: '%7', agentPid: 100, agentStartTime: '1', capturedAt: new Date(at).toISOString() });
 await writeActivity(ctx.files, 'idle', () => new Date(at - 30_000));
 await writeJsonAtomic(path.join(stateRoot(env), 'wake-settings.json'), { consent: { 'codex/terminal': { at: 'now' } }, off: {} });
 line = '› '; column = 2; row = 3; tty = '/dev/pts/1'; mode = '0'; sync = 'off'; calls = [];
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const make = (extra = {}) => createTerminalWakeDriver(guard, { run, readProcess: read, ownsTerminal: async () => true, delay: async () => {}, ...extra });
it('sends only the fixed line then delayed Enter, rechecking ownership twice', async () => {
 const owns = vi.fn(async () => true), pause = vi.fn(async () => { expect(sends()).toHaveLength(1); });
 const driver = make({ ownsTerminal: owns, delay: pause });
 await driver.wake(ctx, wakeLine('1234abcd'));
 expect(sends()).toEqual([['send-keys', '-t', '%7', '-l', wakeLine('1234abcd')], ['send-keys', '-t', '%7', 'Enter']]);
 expect(owns).toHaveBeenCalledTimes(2); expect(pause).toHaveBeenCalledOnce();
});
describe('trimmed prompt captures', () => {
 // Each case: guard, the on-screen empty prompt, and what a trimming capture returns for it.
 const cases = [
  ['❯', { pattern: /^❯[  ]?(Try ".*")?$/u, cursorColumn: 2 }, '❯ '],
  ['›', { pattern: /^› ?(Ask Codex to do anything)?$/u, cursorColumn: 2 }, '› '],
  [' >', { pattern: /^ > ?$/u, cursorColumn: 3 }, ' > '],
  ['❯ ', { pattern: /^❯[  ]?(Try ".*")?$/u, cursorColumn: 2 }, '❯ '],
 ] as const;
 const fake = (screen: string, column0: number) => {
  let composer = screen, cursor = column0;
  const commands: string[][] = [];
  const fakeRun: CommandRunner = async (_command, argv) => {
   commands.push([...argv]);
   if (argv[0] === 'display-message') return `50|0|0|${cursor}|3|/dev/pts/1|0`;
   if (argv[0] === 'capture-pane') return composer.replace(/ +$/, '');
   if (argv.includes('-l')) { composer += argv.at(-1)!; cursor += argv.at(-1)!.length; }
   if (argv.includes('BSpace')) { const n = Number(argv[argv.indexOf('-N') + 1]); composer = composer.slice(0, -n); cursor -= n; }
   return '';
  };
  return { fakeRun, commands, composer: () => composer, keys: () => commands.filter(args => args[0] === 'send-keys') };
 };
 it.each(cases)('submits from a captured empty %j prompt', async (_name, promptGuard, screen) => {
  const { fakeRun, keys } = fake(screen, promptGuard.cursorColumn);
  const driver = createTerminalWakeDriver(promptGuard, { run: fakeRun, readProcess: read, ownsTerminal: async () => true, delay: async () => {} });
  expect(await driver.available(ctx)).toBe(true);
  await driver.wake(ctx, wakeLine('1234abcd'));
  expect(keys()).toEqual([['send-keys', '-t', '%7', '-l', wakeLine('1234abcd')], ['send-keys', '-t', '%7', 'Enter']]);
 });
 it.each(cases)('cleans up only its own line from a captured empty %j prompt', async (_name, promptGuard, screen) => {
  const { fakeRun, keys, composer } = fake(screen, promptGuard.cursorColumn);
  const driver = createTerminalWakeDriver(promptGuard, { run: fakeRun, readProcess: read, ownsTerminal: async () => true, delay: async () => {
   await writeJsonAtomic(path.join(stateRoot(ctx.env), 'wake-settings.json'), { consent: {}, off: {} });
  } });
  await driver.wake(ctx, wakeLine('1234abcd'));
  expect(keys()).toEqual([
   ['send-keys', '-t', '%7', '-l', wakeLine('1234abcd')],
   ['send-keys', '-t', '%7', '-N', String(wakeLine('1234abcd').length), 'BSpace'],
  ]);
  expect(composer()).toBe(screen);
 });
 it.each(cases)('never submits or cleans a user draft typed after a captured empty %j prompt', async (_name, promptGuard, screen) => {
  const { fakeRun, keys, composer } = fake(screen, promptGuard.cursorColumn);
  let typed = false;
  const typing: CommandRunner = async (command, argv, env, signal) => {
   const out = await fakeRun(command, argv, env, signal);
   if (argv.includes('-l') && !typed) { typed = true; await fakeRun(command, ['send-keys', '-t', '%7', '-l', ' draft'], env, signal); }
   return out;
  };
  const driver = createTerminalWakeDriver(promptGuard, { run: typing, readProcess: read, ownsTerminal: async () => true, delay: async () => {
   await writeActivity(ctx.files, 'busy', () => new Date(at));
  } });
  await driver.wake(ctx, wakeLine('1234abcd'));
  expect(keys()).toEqual([['send-keys', '-t', '%7', '-l', wakeLine('1234abcd')], ['send-keys', '-t', '%7', '-l', ' draft']]);
  expect(composer()).toBe(`${screen}${wakeLine('1234abcd')} draft`);
 });
 it('does not treat a regular space as Claude\'s U+00A0 prompt cell', () => {
  expect(promptPrefix('❯ ', 2)).toBe('❯ ');
  expect(promptPrefix('❯', 2)).toBe('❯ ');
  expect(promptPrefix('\x1b[1m›\x1b[0m', 2)).toBe('› ');
  expect(promptPrefix(' >', 3)).toBe(' > ');
 });
});
it.each(['consent', 'busy', 'recent', 'guard', 'exited', 'reused', 'copy', 'sync', 'draft', 'space', 'abort'])('refuses unsafe %s without recording a failure', async kind => {
 let driver = make();
 if (kind === 'consent') await writeJsonAtomic(path.join(stateRoot(ctx.env), 'wake-settings.json'), { consent: {}, off: {} });
 if (kind === 'busy' || kind === 'recent') await writeActivity(ctx.files, kind === 'busy' ? 'busy' : 'idle', () => new Date(at));
 if (kind === 'guard') driver = createTerminalWakeDriver(undefined);
 if (kind === 'exited') driver = make({ readProcess: async () => null });
 if (kind === 'reused') driver = make({ readProcess: async (pid: number) => ({ pid, ppid: 1, command: 'shell', startTime: 'changed' }) });
 if (kind === 'copy') mode = '1';
 if (kind === 'sync') sync = 'on';
 if (kind === 'draft') { line = '› draft'; column = 7; }
 if (kind === 'space') { line = '›  '; column = 3; }
 if (kind === 'abort') { const abort = new AbortController(); abort.abort(); ctx = { ...ctx, signal: abort.signal }; }
 expect(await driver.available(ctx)).toBe(false);
 expect(await driver.wake(ctx, wakeLine('1234abcd'))).toBe('skipped');
 expect(sends()).toEqual([]); expect(await readWakeState(ctx.files.dir)).toEqual({});
});
it.each(['ownership', 'activity', 'consent', 'copy', 'draft', 'cursor-column', 'cursor-row', 'capture', 'pane', 'tty'])('never submits when %s changes after literal send', async kind => {
 let owned = true;
 const driver = make({ ownsTerminal: async () => owned, delay: async () => {
  if (kind === 'ownership') owned = false;
  if (kind === 'activity') await writeActivity(ctx.files, 'busy', () => new Date(at));
  if (kind === 'consent') await writeJsonAtomic(path.join(stateRoot(ctx.env), 'wake-settings.json'), { consent: {}, off: {} });
  if (kind === 'copy') mode = '1';
  if (kind === 'draft') line += ' user draft';
  if (kind === 'cursor-column') column--;
  if (kind === 'cursor-row') row++;
  if (kind === 'tty') tty = '/dev/pts/2';
  if (kind === 'capture' || kind === 'pane') await writeJsonAtomic(path.join(ctx.files.dir, 'pane.json'), {
    kind: 'tmux', paneId: kind === 'pane' ? '%8' : '%7', agentPid: 100, agentStartTime: '1',
    capturedAt: new Date(at + (kind === 'capture' ? 1 : 0)).toISOString(),
  });
 } });
 await driver.wake(ctx, wakeLine('1234abcd'));
 expect(sends()).toHaveLength(['activity', 'consent'].includes(kind) ? 2 : 1);
 if (['activity', 'consent'].includes(kind)) expect(sends().at(-1)).toEqual(['send-keys', '-t', '%7', '-N', String(wakeLine('1234abcd').length), 'BSpace']);
});
it('rejects hostile caller text before executing any terminal command', async () => {
 for (const text of ['$(touch /tmp/evil)', 'hello; Enter', wakeLine('1234abcd') + '\nother']) await expect(make().wake(ctx, text)).rejects.toThrow('invalid_terminal_wake_line');
 expect(calls).toEqual([]);
});
it('two nonce failures disable this transport', async () => {
 for (const [i, nonce] of ['1234abcd', 'abcd1234'].entries()) {
  await recordAttempt(ctx.files.dir, { nonce, driver: 'terminal', at: at + i * 20_000, deadline: at + i * 20_000 + 10_000 });
  await settleAttempts(ctx.files.dir, { now: at + i * 20_000 + 10_000, activity: { state: 'idle', updatedAt: at - 30_000 } });
 }
 expect((await readWakeState(ctx.files.dir)).terminal?.disabled).toBe(true);
 expect(await make().available(ctx)).toBe(false);
});
it.each([['armed', true, true], ['armed', false, false], ['exited', true, false]])('watcher %s alive=%s availability=%s', async (state, alive, expected) => {
 await writeJsonAtomic(path.join(ctx.files.dir, 'watcher.json'), { state, pid: 100 });
 expect(await createClaudeWatcherDriver(alive ? read : async () => null).available(ctx)).toBe(expected);
});

it('arbitrary hostile inbox text produces only the fixed literal through the real ladder', async () => {
 const alphabet = ['$(touch evil)', '; Enter', '\n\r', '"', '`shell`', '💬', '\x1b[2J'];
 for (let seed = 0; seed < 12; seed++) {
  const files = await openSessionDir('codex', `fuzz-${seed}`, ctx.env);
  await writeJsonAtomic(path.join(files.dir, 'pane.json'), { kind: 'tmux', paneId: '%7', agentPid: 100, agentStartTime: '1', capturedAt: new Date(at).toISOString() });
  await writeActivity(files, 'idle', () => new Date(at - 30_000));
  const body = Array.from({ length: 8 }, (_, i) => alphabet[(seed * 7 + i * 3) % alphabet.length]).join('');
  await appendEntries(files, [{ eventId: `event-${seed}`, roomId: 'room', ts: 'now', sender: 'peer', senderLabel: body, senderKind: 'human', body, kind: 'message' }]);
  line = '› '; column = 2; calls = [];
  const loop = createWakeLadder({ files, harness: 'codex', sessionId: `fuzz-${seed}`, env: ctx.env, drivers: [make()], pollMs: 100_000, now: () => at });
  try {
   loop.notify(); await vi.waitFor(() => expect(sends()).toHaveLength(2));
   expect(sends()[0]?.slice(0, 4)).toEqual(['send-keys', '-t', '%7', '-l']);
   expect(sends()[0]?.[4]).toMatch(/^Khala: channel messages are waiting\. Continue\. \(k-[a-f0-9]{8}\)$/);
   expect(sends()[1]).toEqual(['send-keys', '-t', '%7', 'Enter']);
  } finally { await loop.stop(); }
 }
});

it('validates WezTerm renderer framing before text and before Enter', async () => {
 await writeJsonAtomic(path.join(ctx.files.dir, 'pane.json'), { kind: 'wezterm', paneId: '9', agentPid: 100,
  agentStartTime: '1', capturedAt: new Date(at).toISOString() });
 let pending: string | undefined;
 const commands: string[][] = [];
 const wezRun: CommandRunner = async (_command, argv) => {
  commands.push([...argv]);
  if (argv[1] === 'list') return JSON.stringify([{ pane_id: 9, tty_name: '/dev/pts/1', cursor_x: pending ? 2 + pending.length : 2, cursor_y: 3 }]);
  if (argv[1] === 'get-text') return `\x1b(B\x1b[m› ${pending ?? '\x1b[2mAsk Codex to do anything'}\r\n\x1b(B\x1b[m\n`;
  if (argv[1] === 'send-text' && argv.at(-1) !== '\r') pending = argv.at(-1);
  return '';
 };
 const driver = createTerminalWakeDriver({ pattern: /^› ?(Ask Codex to do anything)?$/, cursorColumn: 2 },
  { run: wezRun, readProcess: read, ownsTerminal: async () => true, delay: async () => {} });
 expect(await driver.available(ctx)).toBe(true);
 await driver.wake(ctx, wakeLine('1234abcd'));
 expect(commands.filter(argv => argv[1] === 'send-text')).toEqual([
  ['cli', 'send-text', '--pane-id', '9', '--no-paste', wakeLine('1234abcd')],
  ['cli', 'send-text', '--pane-id', '9', '--no-paste', '\r'],
 ]);
});

it('waits the default 500ms between literal send and Enter', async () => {
 let insertedAt = 0, enteredAt = 0;
 const timedRun: CommandRunner = async (command, argv, env, signal) => {
  if (argv[0] === 'send-keys') {
   if (argv.includes('-l')) insertedAt = performance.now();
   else enteredAt = performance.now();
  }
  return run(command, argv, env, signal);
 };
 await createTerminalWakeDriver(guard, { run: timedRun, readProcess: read, ownsTerminal: async () => true }).wake(ctx, wakeLine('1234abcd'));
 expect(sends()).toHaveLength(2);
 expect(enteredAt - insertedAt).toBeGreaterThanOrEqual(450);
});

it('aborts the default Enter delay without submitting the composer', async () => {
 const controller = new AbortController();
 let timer: ReturnType<typeof setTimeout> | undefined;
 const abortingRun: CommandRunner = async (command, argv, env, signal) => {
  if (argv.includes('-l')) timer = setTimeout(() => controller.abort(), 10);
  return run(command, argv, env, signal);
 };
 try {
  const driver = createTerminalWakeDriver(guard, { run: abortingRun, readProcess: read, ownsTerminal: async () => true });
  await expect(driver.wake({ ...ctx, signal: controller.signal }, wakeLine('1234abcd'))).rejects.toMatchObject({ name: 'AbortError' });
  expect(sends()).toHaveLength(2);
  expect(sends().at(-1)?.at(-1)).toBe('BSpace');
 } finally { if (timer) clearTimeout(timer); }
});

it('reports capture pending for Codex until its first prompt in a supported terminal', async () => {
 await rm(path.join(ctx.files.dir, 'pane.json'));
 ctx.env.TMUX = '/private/socket,1,0';
 expect(await make().available(ctx)).toBe(false);
 expect(await make().unavailableReason!(ctx)).toBe('terminal_capture_pending_prompt');
 delete ctx.env.TMUX;
 expect(await make().unavailableReason!(ctx)).toBe('no remote-control API');
});
