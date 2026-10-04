import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cursorDeeplink, cursorHookCommand, cursorMcpEntry, cursorPaths, mergeCursorHooks, mergeCursorMcp,
} from './cursor';
import { runInstall } from './main';

describe('cursor paths', () => {
  it('uses %USERPROFILE%\\.cursor and %LOCALAPPDATA% with npm\'s flat Windows prefix', () => {
    const paths = cursorPaths({ platform: 'win32', path: path.win32, home: 'C:\\Users\\Ada Lovelace', env: { LOCALAPPDATA: 'C:\\Users\\Ada Lovelace\\AppData\\Local' } });
    expect(paths).toEqual({
      cursorDir: 'C:\\Users\\Ada Lovelace\\.cursor',
      mcpFile: 'C:\\Users\\Ada Lovelace\\.cursor\\mcp.json',
      hooksFile: 'C:\\Users\\Ada Lovelace\\.cursor\\hooks.json',
      prefix: 'C:\\Users\\Ada Lovelace\\AppData\\Local\\khala\\npm',
      script: 'C:\\Users\\Ada Lovelace\\AppData\\Local\\khala\\npm\\node_modules\\khala-cli\\dist\\khala.mjs',
    });
    // Without LOCALAPPDATA it falls back under the profile; a relative value is ignored.
    expect(cursorPaths({ platform: 'win32', path: path.win32, home: 'C:\\Users\\a', env: { LOCALAPPDATA: 'rel' } }).prefix)
      .toBe('C:\\Users\\a\\AppData\\Local\\khala\\npm');
  });
  it('uses ~/.cursor and XDG_DATA_HOME with lib/node_modules on POSIX', () => {
    expect(cursorPaths({ platform: 'darwin', path: path.posix, home: '/Users/a', env: {} })).toMatchObject({
      mcpFile: '/Users/a/.cursor/mcp.json', prefix: '/Users/a/.local/share/khala/npm',
      script: '/Users/a/.local/share/khala/npm/lib/node_modules/khala-cli/dist/khala.mjs',
    });
    expect(cursorPaths({ platform: 'linux', path: path.posix, home: '/h', env: { XDG_DATA_HOME: '/d' } }).prefix).toBe('/d/khala/npm');
  });
});

describe('cursor hook command', () => {
  it('starts with bare node and forward slashes on Windows so PowerShell, cmd and bash agree', () => {
    expect(cursorHookCommand('win32', 'C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\Ada Lovelace\\AppData\\Local\\khala\\npm\\node_modules\\khala-cli\\dist\\khala.mjs'))
      .toBe('node "C:/Users/Ada Lovelace/AppData/Local/khala/npm/node_modules/khala-cli/dist/khala.mjs" hook deliver --harness cursor');
  });
  it('uses absolute, quoted paths on POSIX', () => {
    expect(cursorHookCommand('linux', '/opt/node/bin/node', "/home/o'k/x.mjs")).toBe(`/opt/node/bin/node '/home/o'\\''k/x.mjs' hook deliver --harness cursor`);
  });
});

describe('mcp.json merge', () => {
  const entry = cursorMcpEntry('/n', '/s.mjs');
  it('adds khala beside other servers and keeps other keys', () => {
    const merged = mergeCursorMcp({ mcpServers: { other: { command: 'o' } }, extra: 1 }, entry);
    expect(merged).toEqual({ config: { mcpServers: { other: { command: 'o' }, khala: entry }, extra: 1 } });
  });
  it('replaces its own or a deeplink entry, and removes it on uninstall', () => {
    const deeplink = { command: 'npx', args: ['-y', 'khala-cli@0.4.0', 'mcp', '--harness', 'cursor'] };
    expect(mergeCursorMcp({ mcpServers: { khala: deeplink } }, entry)).toEqual({ config: { mcpServers: { khala: entry } } });
    expect(mergeCursorMcp({ mcpServers: { khala: entry, other: {} } }, null)).toEqual({ config: { mcpServers: { other: {} } } });
  });
  it('refuses a foreign khala server and malformed config', () => {
    expect(mergeCursorMcp({ mcpServers: { khala: { url: 'https://x' } } }, entry)).toEqual({ error: 'cursor_mcp_exists' });
    expect(mergeCursorMcp([], entry)).toEqual({ error: 'invalid_config' });
    expect(mergeCursorMcp({ mcpServers: [] }, entry)).toEqual({ error: 'invalid_config' });
  });
});

describe('hooks.json merge', () => {
  const command = '/n /s.mjs hook deliver --harness cursor';
  it('adds three handlers, keeps others, and replaces an older Khala line', () => {
    const other = { command: './audit.sh' };
    const { config } = mergeCursorHooks({ version: 1, hooks: { stop: [other, { command: '/old/node /old.mjs hook deliver --harness cursor' }], afterFileEdit: [other] } }, command) as { config: { hooks: Record<string, unknown[]> } };
    expect(config).toEqual({ version: 1, hooks: {
      stop: [other, { command, timeout: 10 }], afterFileEdit: [other],
      beforeSubmitPrompt: [{ command, timeout: 10 }], postToolUse: [{ command, timeout: 10 }],
    } });
    expect(mergeCursorHooks(config, command)).toEqual({ config });
    expect(mergeCursorHooks(config, null)).toEqual({ config: { version: 1, hooks: { stop: [other], afterFileEdit: [other] } } });
  });
  it('rejects malformed hooks', () => {
    expect(mergeCursorHooks({ hooks: { stop: {} } }, command)).toEqual({ error: 'invalid_config' });
  });
});

it('builds a Cursor install deeplink with a base64 server object', () => {
  const link = new URL(cursorDeeplink('khala-cli@1.2.3'));
  expect(link.protocol).toBe('cursor:');
  expect(link.searchParams.get('name')).toBe('khala');
  expect(JSON.parse(Buffer.from(link.searchParams.get('config')!, 'base64').toString('utf8'))).toEqual({
    command: 'npx', args: ['-y', 'khala-cli@1.2.3', 'mcp', '--harness', 'cursor'], env: { KHALA_CURSOR_WORKSPACE: '${workspaceFolder}' },
  });
});

it('the published AGENTS.md deeplink pins the current package version', async () => {
  const [guide, manifest] = await Promise.all([
    fs.readFile(new URL('../../../../apps/web/src/landing/public/AGENTS.md', import.meta.url), 'utf8'),
    fs.readFile(new URL('../../npm/package.json', import.meta.url), 'utf8'),
  ]);
  const { name, version } = JSON.parse(manifest) as { name: string; version: string };
  expect(guide).toContain(cursorDeeplink(`${name}@${version}`));
  expect(guide).toContain(`"${name}@${version}", "mcp", "--harness", "cursor"`);
});

describe('khala install cursor', () => {
  let home: string;
  let lines: string[];
  let installs: Array<[string, string]>;
  beforeEach(async () => { home = await fs.mkdtemp(path.join(os.tmpdir(), 'khala-cursor-')); lines = []; installs = []; });
  afterEach(async () => { await fs.rm(home, { recursive: true, force: true }); });
  const run = (argv: string[], ok = true) => runInstall(argv, {
    env: {}, home, node: '/opt/node', platform: 'linux',
    package: { name: 'khala-cli', version: '9.8.7' },
    npmInstall: (prefix, spec) => { installs.push([prefix, spec]); return ok; },
    stdout: line => { lines.push(line); }, stderr: line => { lines.push(line); },
  });
  const read = async (name: string) => JSON.parse(await fs.readFile(path.join(home, '.cursor', name), 'utf8'));

  it('installs, is idempotent, backs up once and uninstalls without touching other entries', async () => {
    await fs.mkdir(path.join(home, '.cursor'));
    const original = '{ "mcpServers": { "other": { "command": "o" } } }';
    await fs.writeFile(path.join(home, '.cursor', 'mcp.json'), original);
    expect(await run(['cursor'])).toBe(0);
    const prefix = path.join(home, '.local', 'share', 'khala', 'npm');
    const script = path.join(prefix, 'lib', 'node_modules', 'khala-cli', 'dist', 'khala.mjs');
    expect(installs).toEqual([[prefix, 'khala-cli@9.8.7']]);
    const mcp = await read('mcp.json');
    expect(mcp).toEqual({ mcpServers: { other: { command: 'o' }, khala: cursorMcpEntry('/opt/node', script) } });
    const hooks = await read('hooks.json');
    expect(Object.keys(hooks.hooks).sort()).toEqual(['beforeSubmitPrompt', 'postToolUse', 'stop']);
    expect(hooks.version).toBe(1);
    expect(await fs.readFile(path.join(home, '.cursor', 'mcp.json.khala-bak'), 'utf8')).toBe(original);

    expect(await run(['cursor'])).toBe(0);
    expect(await read('mcp.json')).toEqual(mcp);
    expect(await read('hooks.json')).toEqual(hooks);
    expect(await fs.readFile(path.join(home, '.cursor', 'mcp.json.khala-bak'), 'utf8')).toBe(original);

    expect(await run(['cursor', '--uninstall'])).toBe(0);
    expect(await read('mcp.json')).toEqual({ mcpServers: { other: { command: 'o' } } });
    expect(await read('hooks.json')).toEqual({ version: 1, hooks: {} });
    expect(installs).toHaveLength(2);
  });

  it('writes nothing when npm install fails or a foreign khala server exists', async () => {
    expect(await run(['cursor'], false)).toBe(1);
    await expect(fs.stat(path.join(home, '.cursor'))).rejects.toThrow();
    await fs.mkdir(path.join(home, '.cursor'));
    await fs.writeFile(path.join(home, '.cursor', 'mcp.json'), '{"mcpServers":{"khala":{"url":"https://elsewhere"}}}');
    expect(await run(['cursor'])).toBe(1);
    expect(lines.at(-1)).toMatch(/already has a "khala" server/u);
    expect(installs).toHaveLength(1);
  });

  it('rejects unknown flags', async () => {
    expect(await run(['cursor', '--codex-home', 'x'])).toBe(1);
  });
});
