import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mergeMuseSettings, musePaths, museMcpEntry, museHookCommand } from './muse';
import { runInstall } from './main';

const entry = museMcpEntry('/node', '/khala.mjs');
const command = museHookCommand('linux', '/node', '/khala.mjs');
it.each(['mcp_servers', 'mcpServers'])('preserves schema, siblings, %s spelling and foreign hook handlers', key => {
  const original = { schema_version: 1, model: 'custom', [key]: { other: { command: 'other' } }, hooks: {
    Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'other-hook', timeout: 7 }] }],
  } };
  const merged = mergeMuseSettings(original, entry, command);
  expect(merged).not.toHaveProperty('error');
  const config = 'config' in merged ? merged.config : {};
  expect(config).toMatchObject({ schema_version: 1, model: 'custom', [key]: original[key] });
  expect((config.hooks as { Stop: unknown[] }).Stop[0]).toEqual(original.hooks.Stop[0]);
  expect((config[key] as Record<string, unknown>).khala).toEqual(entry);
  expect(config).not.toHaveProperty(key === 'mcp_servers' ? 'mcpServers' : 'mcp_servers');
  expect(mergeMuseSettings(config, entry, command)).toEqual(merged);
  expect(mergeMuseSettings(config, null, null)).toEqual({ config: original });
});
it('uses one table when both spellings exist and refuses a foreign khala in either', () => {
  expect(mergeMuseSettings({ mcp_servers: { khala: entry }, mcpServers: { other: {} } }, entry, command)).toMatchObject({
    config: { mcp_servers: { khala: entry }, mcpServers: { other: {} } },
  });
  expect(mergeMuseSettings({ mcp_servers: {}, mcpServers: { khala: { command: 'foreign' } } }, entry, command))
    .toEqual({ error: 'muse_mcp_exists' });
});
it.each([null, [], { schema_version: 2 }, { mcp_servers: [] }, { mcpServers: null }, { hooks: [] },
  { hooks: { Stop: {} } }, { hooks: { Stop: [{ hooks: [null] }] } }])('refuses invalid settings %#', config => {
  expect(mergeMuseSettings(config, entry, command)).toEqual({ error: 'invalid_config' });
});
it('uses absolute XDG config and platform npm layouts', () => {
  expect(musePaths({ platform: 'linux', path: path.posix, home: '/home/a', env: { XDG_CONFIG_HOME: '/config', XDG_DATA_HOME: '/data' } }))
    .toMatchObject({ settingsFile: '/config/muse/settings.json', prefix: '/data/khala/npm', script: '/data/khala/npm/lib/node_modules/khala-cli/dist/khala.mjs' });
  expect(musePaths({ platform: 'win32', path: path.win32, home: 'C:\\Users\\Ada', env: {} }).settingsFile)
    .toBe('C:\\Users\\Ada\\.config\\muse\\settings.json');
  expect(museHookCommand('win32', 'C:\\Node\\node.exe', 'C:\\Ada Lovelace\\khala.mjs'))
    .toBe('node "C:/Ada Lovelace/khala.mjs" hook deliver --harness muse');
});

let home: string;
beforeEach(async () => { home = await fs.mkdtemp(path.join(os.tmpdir(), 'khala-install-muse-')); });
afterEach(async () => { await fs.rm(home, { recursive: true, force: true }); });
it('installs in one step, backs up once, reinstalls and uninstalls only its own definitions', async () => {
  const settingsFile = path.join(home, '.config/muse/settings.json');
  await fs.mkdir(path.dirname(settingsFile), { recursive: true });
  const original = JSON.stringify({ schema_version: 1, model: 'custom', mcp_servers: { other: {} } });
  await fs.writeFile(settingsFile, original);
  const npmInstall = vi.fn(() => true);
  const deps = { home, env: { HOME: home, XDG_STATE_HOME: path.join(home, 'state') }, package: { name: 'khala-cli', version: '1.2.3' },
    platform: 'linux' as const, node: '/node', npmInstall, stdout: vi.fn(), stderr: vi.fn() };
  expect(await runInstall(['muse'], deps)).toBe(0);
  expect(npmInstall).toHaveBeenCalledWith(path.join(home, '.local/share/khala/npm'), 'khala-cli@1.2.3');
  const config = JSON.parse(await fs.readFile(settingsFile, 'utf8'));
  expect(config.mcp_servers.khala).toMatchObject({ transport: 'stdio', command: '/node', env: { XDG_STATE_HOME: path.join(home, 'state') }, args: expect.arrayContaining(['mcp', '--harness', 'muse']) });
  expect(await fs.readFile(path.join(home, '.config/muse/skills/khala/SKILL.md'), 'utf8')).toContain('wake_delay_ms: 0');
  expect(Object.keys(config.hooks)).toEqual(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop']);
  expect(await fs.readFile(settingsFile + '.khala-bak', 'utf8')).toBe(original);
  expect(await runInstall(['muse', '--no-wake'], deps)).toBe(0);
  expect(await fs.readFile(settingsFile + '.khala-bak', 'utf8')).toBe(original);
  expect(await runInstall(['muse', '--uninstall'], deps)).toBe(0);
  await expect(fs.stat(path.join(home, '.config/muse/skills/khala/SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(JSON.parse(await fs.readFile(settingsFile, 'utf8'))).toEqual({ schema_version: 1, model: 'custom', mcp_servers: { other: {} }, hooks: {} });
});
it.each(['{bad', '', 'null', '{"schema_version":2}', '{"hooks":{"Stop":false}}'])('refuses malformed file %s without writing or installing', async text => {
  const settingsFile = path.join(home, '.config/muse/settings.json');
  await fs.mkdir(path.dirname(settingsFile), { recursive: true });
  await fs.writeFile(settingsFile, text);
  const npmInstall = vi.fn(() => true), stderr = vi.fn();
  expect(await runInstall(['muse'], { home, env: {}, package: { name: 'khala-cli', version: '1' }, npmInstall, stderr })).toBe(1);
  expect(npmInstall).not.toHaveBeenCalled();
  expect(await fs.readFile(settingsFile, 'utf8')).toBe(text);
  expect(await fs.readdir(path.dirname(settingsFile))).toEqual(['settings.json']);
  expect(stderr).toHaveBeenCalledWith(expect.stringContaining('nothing written'));
});

it('refuses an existing user skill before installing or writing settings', async () => {
  const skillFile = path.join(home, '.config/muse/skills/khala/SKILL.md');
  await fs.mkdir(path.dirname(skillFile), { recursive: true });
  await fs.writeFile(skillFile, 'user skill');
  const npmInstall = vi.fn(() => true);
  expect(await runInstall(['muse'], { home, env: {}, package: { name: 'khala-cli', version: '1' }, npmInstall, stderr: vi.fn() })).toBe(1);
  expect(npmInstall).not.toHaveBeenCalled();
  expect(await fs.readFile(skillFile, 'utf8')).toBe('user skill');
  await expect(fs.stat(path.join(home, '.config/muse/settings.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});
