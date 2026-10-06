import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import type { LocalChannelCreated } from '@khala/contracts/m1/local';
import { createWorld, cleanupWorld, cli, hook, inbox, prepareTerminal, wakeCalls } from '../../local/fixtures/e2e-harness';
import { eventually } from '../../local/fixtures/egress';
import { writeActivity } from '../../activity';
import { fileURLToPath } from 'node:url';
import { stateRoot } from '../../state';
import { writeWakeSettings } from '../../wake/shared';

// Linux rows use actual PTY/process ownership, spawned MCP and hook processes,
// and production transport inspection and send guards. No user terminal is used.
describe.skipIf(process.env.KHALA_LOCAL_E2E !== '1')('Tier B terminal transport probes', () => {
  it.each(['wezterm', 'kitty'] as const)('%s inspects and submits the fixed wake', async kind => {
    const world = await createWorld({ guard: false });
    try {
      const agent = world.claude, peer = world.codex;
      const channel = (await cli(world, 'create', `terminal-${kind}`)).data as LocalChannelCreated;
      expect((await peer.call('khala_join', { link: channel.selfLink })).structuredContent.state).toBe('connected');
      expect((await agent.call('khala_join', { link: channel.shareLink })).structuredContent.state).toBe('connected');
      await hook(agent, 'prompt'); await hook(agent, 'stop');
      await writeWakeSettings(stateRoot(world.env), { consent: { 'claude/terminal': { at: new Date().toISOString() } }, off: {} });
      await prepareTerminal(agent, kind);
      await writeActivity(agent.files, 'idle', () => new Date(Date.now() - 31_000));
      expect((await peer.call('khala_send', { text: `terminal-${kind}-message` })).structuredContent).toHaveProperty('eventId');
      await eventually(async () => (await inbox(agent)).some(entry => entry.body === `terminal-${kind}-message`));
      await eventually(async () => !!JSON.parse(await readFile(path.join(world.root, 'bin/terminal.json'), 'utf8')).submitted);
      const calls = (await wakeCalls(world)).filter(call => call.command === (kind === 'kitty' ? 'kitten' : 'wezterm'));
      const sends = calls.filter(call => call.argv.includes(kind === 'kitty' ? 'send-text' : 'send-text'));
      const line = sends[0]!.argv.at(-1)!;
      expect(line).toMatch(/^Khala: channel messages are waiting\. Continue\. \(k-[a-f0-9]{8}\)$/);
      expect(line).not.toContain(`terminal-${kind}-message`);
      if (kind === 'wezterm') {
        expect(calls.some(call => JSON.stringify(call.argv) === JSON.stringify(['cli', 'list', '--format', 'json']))).toBe(true);
        expect(calls.some(call => call.argv.includes('get-text'))).toBe(true);
        expect(sends.map(call => call.argv)).toEqual([
          ['cli', 'send-text', '--pane-id', '7', '--no-paste', line],
          ['cli', 'send-text', '--pane-id', '7', '--no-paste', '\r'],
        ]);
      } else {
        const target = ['@', '--to', `unix:${world.root}/kitty.sock`];
        expect(calls.some(call => JSON.stringify(call.argv) === JSON.stringify([...target, 'ls']))).toBe(true);
        expect(calls.some(call => call.argv.includes('--add-cursor'))).toBe(true);
        expect(sends.map(call => call.argv)).toEqual([
          [...target, 'send-text', '--match', 'id:9', '--', line],
          [...target, 'send-text', '--match', 'id:9', '--', '\\r'],
        ]);
      }
      expect((await hook(agent, 'prompt', { promptText: line })).frame).toContain(`terminal-${kind}-message`);
    } finally { await cleanupWorld(world); }
  }, 60_000);
  it('pins the actual iTerm2 Python helper cell schema and guarded sends', async () => {
    const world = await createWorld({ guard: false });
    try {
      const stub = path.join(world.root, 'iterm2.py');
      await writeFile(stub, `import asyncio, json, os
from types import SimpleNamespace as S
class Contents:
    string = '❯ '
    def string_at(self, column): return self.string[column]
    def style_at(self, column): return S(faint=False)
class Screen:
    cursor_coord = S(x=2, y=17)
    windowed_coord_range = S(coord_range=S(start=S(y=17)))
    number_of_lines = 1
    def line(self, row):
        assert row == 0
        return Contents()
class Session:
    grid_size = S(width=2)
    async def async_get_screen_contents(self): return Screen()
    async def async_get_variable(self, name):
        assert name == 'tty'
        return '/dev/ttys007'
    async def async_send_text(self, text, suppress_broadcast=False):
        assert suppress_broadcast is True
        with open(os.environ['ITERM_FIXTURE_LOG'], 'a') as f: f.write(json.dumps(text) + '\\n')
class App:
    def get_session_by_id(self, uuid): return Session() if uuid == 'fixture-session' else None
async def async_get_app(connection): return App()
def run_until_complete(fn): asyncio.run(fn(None))
`);
      const helper = fileURLToPath(new URL('../../wake/terminal/iterm2_send.py', import.meta.url));
      const log = path.join(world.root, 'python-sends.jsonl');
      const run = (args: string[]) => new Promise<string>((resolve, reject) => {
        // Absolute Python bypasses the world-local python3 transport fake.
        const child = spawn('/usr/bin/python3', [helper, ...args], { env: { ...world.env, PYTHONPATH: world.root, ITERM_FIXTURE_LOG: log } });
        let stdout = '', stderr = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
        child.once('error', reject); child.once('close', code => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
      });
      const view = { tty: '/dev/ttys007', cursorX: 2, cursorY: 17, line: '\x1b[22m❯\x1b[22m ' };
      expect(JSON.parse(await run(['fixture-session']))).toEqual(view);
      const line = 'Khala: channel messages are waiting. Continue. (k-1234abcd)';
      expect(JSON.parse(await run(['fixture-session', line, JSON.stringify(view)]))).toEqual({ status: 'sent' });
      expect(JSON.parse(await run(['fixture-session', '\r', JSON.stringify(view)]))).toEqual({ status: 'sent' });
      expect(JSON.parse(await run(['fixture-session', line, JSON.stringify({ ...view, cursorX: 3 })]))).toEqual({ status: 'not_empty' });
      expect((await readFile(log, 'utf8')).trim().split('\n').map(row => JSON.parse(row))).toEqual([line, '\r']);
    } finally { await cleanupWorld(world); }
  }, 60_000);
  it('iTerm2 exercises the production driver in a spawned darwin-platform fixture', async () => {
    const world = await createWorld({ guard: false });
    try {
      const agent = world.claude;
      await writeWakeSettings(stateRoot(world.env), { consent: { 'claude/terminal': { at: new Date().toISOString() } }, off: {} });
      await prepareTerminal(agent, 'iterm2');
      await writeActivity(agent.files, 'idle', () => new Date(Date.now() - 31_000));
      // iTerm2 is macOS-only. This subprocess uses the public platform seam;
      // ps is the only ownership fixture, while python3 remains an executable
      // fake and every inspection/send passes the production driver guards.
      const executable = path.join(world.root, 'bin/ps');
      await writeFile(executable, `#!${process.execPath}
console.log('ttys007 700 700');
`, { mode: 0o755 });
      const entry = path.join(world.root, 'iterm-fixture.mts');
      const source = fileURLToPath(new URL('../../wake/terminal/driver.ts', import.meta.url));
      const line = 'Khala: channel messages are waiting. Continue. (k-1234abcd)';
      await writeFile(entry, `import { createTerminalWakeDriver } from ${JSON.stringify(source)};
const ctx = ${JSON.stringify({ files: agent.files, harness: 'claude', sessionId: agent.sessionId, now: Date.now() })};
ctx.env = process.env; ctx.signal = new AbortController().signal;
const driver = createTerminalWakeDriver({pattern: /^❯ ?$/u, cursorColumn: 2}, {platform: 'darwin'});
if (!await driver.available(ctx)) throw new Error(await driver.unavailableReason(ctx));
await driver.wake(ctx, ${JSON.stringify(line)});
`);
      const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', entry], { env: world.env, stdio: 'pipe' });
        let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; }); child.stdout.resume(); child.stdin.end();
        child.once('error', reject); child.once('close', code => resolve({ code, stderr }));
      });
      expect(result, result.stderr).toMatchObject({ code: 0 });
      const calls = (await wakeCalls(world)).filter(call => call.command === 'python3');
      expect(calls.filter(call => call.argv.length === 2).length).toBeGreaterThanOrEqual(2);
      const sends = calls.filter(call => call.argv.length === 4);
      expect(sends.map(call => call.argv.slice(1, 3))).toEqual([
        ['12345678-1234-1234-1234-123456789abc', line], ['12345678-1234-1234-1234-123456789abc', '\r'],
      ]);
      expect(JSON.parse(sends[0]!.argv[3]!)).toEqual({ tty: '/dev/ttys007', cursorX: 2, cursorY: 0, line: '❯ ' });
      expect(JSON.parse(sends[1]!.argv[3]!)).toEqual({ tty: '/dev/ttys007', cursorX: 2 + line.length, cursorY: 0, line: '❯ ' + line });
      expect(JSON.parse(await readFile(path.join(world.root, 'bin/terminal.json'), 'utf8')).submitted).toBe(line);
    } finally { await cleanupWorld(world); }
  }, 60_000);

});
