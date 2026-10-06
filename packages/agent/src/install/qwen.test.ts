import * as fs from 'node:fs/promises';
import * as syncFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { installQwen, mergeQwenSettings, QWEN_WATCH_PERMISSION } from './qwen';
import { parseQwenControllerIds, runInstall, runQwenInstall } from './main';
import { qwenControllerFile } from '../wake/qwen-socket';

it.each(['absent home', 'seeded settings', 'empty registry', 'existing controller', 'new controller', 'registry metadata'])
('restores the Qwen controller registry without losing user data (%s)', async scenario => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qw-registry-'));
  const home = path.join(root, scenario === 'absent home' ? '.qwen' : 'custom-qwen');
  const env = { HOME: root, ...(scenario === 'absent home' ? {} : { QWEN_HOME: home }), XDG_STATE_HOME: path.join(root, 'state') };
  const registry = path.join(home, 'peer-controllers.json');
  const settings = path.join(home, 'settings.json');
  const originalSettings = '{\n  "model": {"name": "deepseek-chat"}\n}\n';
  const originalRegistry = scenario === 'empty registry' ? '\uFEFF{\r\n\t"schemaVersion": 1, "controllers": []\r\n}\r\n'
    : scenario === 'existing controller' ? '{"schemaVersion":1,"controllers":[{"id":"user"}]}\n' : null;
  const readRegistry = () => JSON.parse(syncFs.readFileSync(registry, 'utf8').replace(/^\uFEFF/u, ''));
  let minted = 0;
  let revoke = false;
  const input = { env, entry: { args: ['mcp', '--harness', 'qwen'] }, command: 'khala hook deliver --harness qwen',
    uninstall: false, stdout: () => {}, stderr: () => {},
    list: () => syncFs.existsSync(registry) ? readRegistry().controllers.map((c: { id: string }) => c.id) : [],
    mint: () => {
      const value = syncFs.existsSync(registry) ? readRegistry() : { schemaVersion: 1, controllers: [] };
      value.controllers.push({ id: 'khala' });
      syncFs.mkdirSync(home, { recursive: true });
      syncFs.writeFileSync(registry, JSON.stringify(value));
      minted++;
      return { id: 'khala', token: 'qpc_' + 'a'.repeat(64) };
    },
    remove: (id: string) => {
      if (!revoke) return false;
      const value = readRegistry();
      value.controllers = value.controllers.filter((c: { id: string }) => c.id !== id);
      syncFs.writeFileSync(registry, JSON.stringify(value));
      return true;
    } };
  try {
    if (scenario !== 'absent home') {
      await fs.mkdir(home); await fs.writeFile(settings, originalSettings);
    }
    if (originalRegistry !== null) await fs.writeFile(registry, originalRegistry);
    expect(await installQwen(input)).toBe(0);
    expect(await installQwen(input)).toBe(0);
    expect(minted).toBe(1);
    if (scenario === 'new controller' || scenario === 'registry metadata') {
      const value = readRegistry();
      if (scenario === 'new controller') value.controllers.push({ id: 'later-user' });
      else value.metadata = { keep: true };
      await fs.writeFile(registry, JSON.stringify(value));
    }
    expect(await installQwen({ ...input, uninstall: true })).toBe(1);
    expect(readRegistry().controllers).toContainEqual({ id: 'khala' });
    expect(JSON.parse(await fs.readFile(qwenControllerFile(env), 'utf8')).id).toBe('khala');
    revoke = true;
    expect(await installQwen({ ...input, uninstall: true })).toBe(0);
    if (originalRegistry !== null) expect(await fs.readFile(registry, 'utf8')).toBe(originalRegistry);
    else if (scenario === 'new controller') expect(readRegistry().controllers).toEqual([{ id: 'later-user' }]);
    else if (scenario === 'registry metadata') expect(readRegistry()).toEqual({ schemaVersion: 1, controllers: [], metadata: { keep: true } });
    else await expect(fs.stat(registry)).rejects.toMatchObject({ code: 'ENOENT' });
    if (scenario === 'absent home') await expect(fs.stat(home)).rejects.toMatchObject({ code: 'ENOENT' });
    else expect(await fs.readFile(settings, 'utf8')).toBe(originalSettings);
    expect(await installQwen({ ...input, uninstall: true })).toBe(0);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it('merges hooks idempotently and uninstalls only managed entries', () => {
  const original = { agents: { crossSessionInbound: 'hold' }, mcpServers: { other: { command: 'other' } },
    hooks: { Stop: [{ matcher: '*', hooks: [{ type: 'command', command: 'other' }] }] } };
  const entry = { command: 'khala', args: ['mcp', '--harness', 'qwen'] };
  const command = 'khala hook deliver --harness qwen';
  const installed = mergeQwenSettings(original, entry, command);
  if ('error' in installed) throw new Error(installed.error);
  expect(mergeQwenSettings(installed.config, entry, command)).toEqual(installed);
  const removed = mergeQwenSettings(installed.config, null, null);
  expect(removed).toEqual({ config: original });
  expect(mergeQwenSettings({ mcpServers: { khala: { command: 'other' } } }, entry, command)).toEqual({ error: 'qwen_mcp_exists' });
  const unmanaged = { mcpServers: { khala: { command: 'other', args: ['qwen', 'mcp'] } } };
  expect(mergeQwenSettings(unmanaged, entry, command)).toEqual({ error: 'qwen_mcp_exists' });
  expect(mergeQwenSettings(unmanaged, null, null)).toEqual({ error: 'qwen_mcp_exists' });
  expect(mergeQwenSettings({ hooks: { Stop: [{}] } }, entry, command)).toEqual({ error: 'invalid_config' });
});

it('CLI installs with a private controller token, preserves hold, and uninstalls', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qw-install-'));
  const env = { HOME: root, QWEN_HOME: path.join(root, 'qwen'), XDG_STATE_HOME: path.join(root, 'state') };
  const token = 'qpc_' + 'a'.repeat(64);
  const logs: string[] = [];
  let minted = 0;
  const deps = { env, package: { name: 'khala-cli', version: '0.0.0' }, npmInstall: () => true,
    qwenList: () => minted ? ['c_test'] : [], qwenRemove: () => true,
    qwenMint: () => { minted++; return { id: 'c_test', token }; }, stdout: (line: string) => logs.push(line), stderr: (line: string) => logs.push(line) };
  try {
    await fs.mkdir(env.QWEN_HOME);
    await fs.writeFile(path.join(env.QWEN_HOME, 'settings.json'), JSON.stringify({ agents: { crossSessionInbound: 'hold' } }));
    expect(await runInstall(['qwen'], deps)).toBe(0);
    expect(await runInstall(['qwen'], deps)).toBe(0);
    expect(minted).toBe(1);
    const credential = qwenControllerFile(env);
    expect((await fs.stat(credential)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await fs.readFile(credential, 'utf8')).token).toBe(token);
    const config = JSON.parse(await fs.readFile(path.join(env.QWEN_HOME, 'settings.json'), 'utf8'));
    expect(config.agents.crossSessionInbound).toBe('hold');
    expect(Object.keys(config.hooks)).toEqual(['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop']);
    expect(JSON.stringify(config)).not.toContain(token);
    expect(logs.join('\n')).not.toContain(token);
    expect(await runInstall(['qwen', '--no-wake'], deps)).toBe(0);
    const settings = JSON.parse(await fs.readFile(path.join(env.XDG_STATE_HOME, 'khala', 'wake-settings.json'), 'utf8'));
    expect(settings.off['qwen/socket']).toBeDefined();
    expect(await runInstall(['qwen', '--uninstall'], deps)).toBe(0);
    await expect(fs.stat(credential)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.parse(await fs.readFile(path.join(env.QWEN_HOME, 'settings.json'), 'utf8'))).toEqual({ agents: { crossSessionInbound: 'hold' } });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it('adds only the scoped Qwen watch permission on Windows', () => {
  const config = { permissions: { allow: ['Bash(git status)'], deny: ['Bash(rm *)'] } };
  const entry = { command: 'khala', args: ['mcp', '--harness', 'qwen'] };
  const merged = mergeQwenSettings(config, entry, 'khala hook deliver --harness qwen', true);
  if ('error' in merged) throw new Error(merged.error);
  expect(merged.config.permissions).toEqual({ allow: ['Bash(git status)', QWEN_WATCH_PERMISSION], deny: ['Bash(rm *)'] });
  const removed = mergeQwenSettings(merged.config, null, null, true);
  if ('error' in removed) throw new Error(removed.error);
  expect(removed.config.permissions).toEqual(config.permissions);
});

it('revokes removed controllers, remints revoked IDs, and leaves no empty managed objects', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qw-lifecycle-'));
  const env = { HOME: root, XDG_STATE_HOME: path.join(root, 'state') };
  let ids: string[] = []; let minted = 0; const removed: string[] = [];
  const input = { env, entry: { args: ['mcp', '--harness', 'qwen'] }, command: 'khala hook deliver --harness qwen',
    uninstall: false, mint: () => { const id = `c_${++minted}`; ids.push(id); return { id, token: 'qpc_' + 'a'.repeat(64) }; },
    list: () => ids, remove: (id: string) => { removed.push(id); return true; }, stdout: () => {}, stderr: () => {} };
  try {
    await fs.mkdir(env.XDG_STATE_HOME, { mode: 0o755 });
    expect(await installQwen(input)).toBe(0);
    expect(await installQwen({ ...input, list: () => undefined })).toBe(1);
    expect(minted).toBe(1);
    expect((await fs.stat(env.XDG_STATE_HOME)).mode & 0o777).toBe(0o755);
    ids = []; // Controller revoked outside Khala.
    expect(await installQwen(input)).toBe(0);
    expect(minted).toBe(2);
    expect(await installQwen({ ...input, uninstall: true })).toBe(0);
    expect(removed).toEqual(['c_2']);
    await expect(fs.stat(path.join(root, '.qwen/settings.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it('rejects unsafe Khala directories before minting and rolls back a later failure', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qw-security-'));
  const env = { HOME: root, XDG_STATE_HOME: path.join(root, 'state') };
  let minted = 0; const removed: string[] = [];
  const input = { env, entry: { args: ['mcp', '--harness', 'qwen'] }, command: 'khala hook deliver --harness qwen',
    uninstall: false, mint: () => { minted++; return { id: 'c_test', token: 'qpc_' + 'a'.repeat(64) }; }, list: () => [],
    remove: (id: string) => { removed.push(id); return true; }, stdout: () => {}, stderr: () => {} };
  try {
    await fs.mkdir(env.XDG_STATE_HOME);
    await fs.mkdir(path.join(root, 'redirect'));
    await fs.symlink(path.join(root, 'redirect'), path.join(env.XDG_STATE_HOME, 'khala'));
    expect(await installQwen(input)).toBe(1); expect(minted).toBe(0);
    await fs.rm(path.join(env.XDG_STATE_HOME, 'khala'));
    await fs.mkdir(path.join(env.XDG_STATE_HOME, 'khala'), { mode: 0o755 });
    expect(await installQwen(input)).toBe(1); expect(minted).toBe(0);
    await fs.rm(path.join(env.XDG_STATE_HOME, 'khala'), { recursive: true });
    await fs.mkdir(path.join(root, '.qwen'));
    await fs.writeFile(path.join(root, '.qwen/settings.json'), '{}');
    const failInput = { ...input, mint: () => {
      minted++;
      syncFs.unlinkSync(path.join(root, '.qwen/settings.json'));
      syncFs.mkdirSync(path.join(root, '.qwen/settings.json'));
      return { id: 'c_test', token: 'qpc_' + 'a'.repeat(64) };
    } };
    expect(await installQwen(failInput)).toBe(1);
    expect(removed).toEqual(['c_test']);
    await expect(fs.stat(qwenControllerFile(env))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it('parses Qwen controller NDJSON and fails closed on malformed listing', () => {
  expect(parseQwenControllerIds('')).toEqual([]);
  expect(parseQwenControllerIds(' {"id":"one","label":"khala"}\n{"id":"two"}\n')).toEqual(['one', 'two']);
  expect(() => parseQwenControllerIds('{"token":"secret"}')).toThrow('invalid controller list');
});

it('retains a private recovery credential when rollback revocation fails', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qw-rollback-'));
  const env = { HOME: root, XDG_STATE_HOME: path.join(root, 'state') }; const messages: string[] = [];
  try {
    await fs.mkdir(path.join(root, '.qwen')); await fs.writeFile(path.join(root, '.qwen/settings.json'), '{}');
    expect(await installQwen({ env, uninstall: false, entry: {}, command: 'khala hook deliver --harness qwen',
      mint: () => {
        syncFs.unlinkSync(path.join(root, '.qwen/settings.json')); syncFs.mkdirSync(path.join(root, '.qwen/settings.json'));
        return { id: 'c_recovery', token: 'qpc_' + 'b'.repeat(64) };
      }, list: () => [], remove: () => false, stdout: () => {}, stderr: line => messages.push(line) })).toBe(1);
    expect(JSON.parse(await fs.readFile(qwenControllerFile(env), 'utf8')).id).toBe('c_recovery');
    expect((await fs.stat(qwenControllerFile(env))).mode & 0o777).toBe(0o600);
    expect(messages.join(' ')).toContain('rollback failed'); expect(messages.join(' ')).not.toContain('qpc_');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it('reports and tolerates a missing Qwen executable during uninstall', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qw-missing-'));
  const env = { HOME: root, XDG_STATE_HOME: path.join(root, 'state'), PATH: '' }; const logs: string[] = [];
  try {
    await fs.mkdir(path.dirname(qwenControllerFile(env)), { recursive: true, mode: 0o700 });
    await fs.writeFile(qwenControllerFile(env), JSON.stringify({ id: 'c_missing', token: 'qpc_' + 'a'.repeat(64) }), { mode: 0o600 });
    expect(await runQwenInstall(['--uninstall'], { env, stdout: line => logs.push(line), stderr: line => logs.push(line) })).toBe(0);
    expect(logs.join(' ')).toContain('Qwen executable unavailable');
    expect(logs.join(' ')).not.toContain('qpc_');
    await expect(fs.stat(qwenControllerFile(env))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it.each(['Example', 'Example User'])('Windows install pairs the stable launcher with Qwen permission semantics (%s)', async user => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qw-win-command-'));
  const env = { HOME: root, QWEN_HOME: path.join(root, 'qwen'), XDG_STATE_HOME: path.join(root, 'state'), LOCALAPPDATA: `C:/Users/${user}/AppData/Local` };
  const launcher = `${env.LOCALAPPDATA}/khala/npm/khala.cmd`;
  try {
    expect(await runQwenInstall([], { env, platform: 'win32', node: 'C:/Program Files/nodejs/node.exe', package: { name: 'khala-cli', version: '0.4.8' }, npmInstall: () => true, stdout: () => {}, stderr: () => {} })).toBe(0);
    const installed = JSON.parse(await fs.readFile(path.join(env.XDG_STATE_HOME, 'khala/qwen/watch-command.json'), 'utf8'));
    expect(installed.command).toBe(`${user.includes(' ') ? `"${launcher}"` : launcher} watch --harness qwen`);
    const settings = JSON.parse(await fs.readFile(path.join(env.QWEN_HOME, 'settings.json'), 'utf8'));
    expect(settings.permissions.allow).toEqual([`Bash(${launcher} watch --harness qwen --session *)`]);
    expect(installed.permission).toBe(settings.permissions.allow[0]);
    // Qwen 0.25 normalizes quotes in commands, but matches the rule's prefix literally.
    const prefix = installed.permission.slice('Bash('.length, -2);
    const command = `${installed.command} --session session-1`.replaceAll('"', '');
    expect(command.startsWith(prefix)).toBe(true);
    expect(`${launcher} mcp --harness qwen`.startsWith(prefix)).toBe(false);
    expect(`node other.mjs watch --harness qwen --session session-1`.startsWith(prefix)).toBe(false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it('reinstall replaces the recorded legacy watcher rule and preserves unrelated permissions', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qw-win-migrate-'));
  const env = { HOME: root, QWEN_HOME: path.join(root, 'qwen'), XDG_STATE_HOME: path.join(root, 'state'), LOCALAPPDATA: 'C:/Users/Example/AppData/Local' };
  const deps = { env, platform: 'win32' as const, package: { name: 'khala-cli', version: '0.4.8' }, npmInstall: () => true, stdout: () => {}, stderr: () => {} };
  const file = path.join(env.QWEN_HOME, 'settings.json');
  const watchFile = path.join(env.XDG_STATE_HOME, 'khala/qwen/watch-command.json');
  try {
    await fs.mkdir(env.QWEN_HOME);
    const original = JSON.stringify({ permissions: { allow: ['Bash(git status)'] } });
    await fs.writeFile(file, original);
    expect(await runQwenInstall([], deps)).toBe(0);
    const settings = JSON.parse(await fs.readFile(file, 'utf8'));
    const legacy = '"C:/Program Files/nodejs/node.exe" "C:/khala/khala.mjs" watch --harness qwen';
    settings.permissions.allow = ['Bash(git status)', `Bash(${legacy} --session *)`];
    await fs.writeFile(file, JSON.stringify(settings));
    await fs.writeFile(watchFile, JSON.stringify({ command: legacy }));
    expect(await runQwenInstall([], deps)).toBe(0);
    expect(JSON.parse(await fs.readFile(file, 'utf8')).permissions.allow).toEqual([
      'Bash(git status)', 'Bash(C:/Users/Example/AppData/Local/khala/npm/khala.cmd watch --harness qwen --session *)',
    ]);
    expect(await runQwenInstall(['--uninstall'], deps)).toBe(0);
    expect(await fs.readFile(file, 'utf8')).toBe(original);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it('restores exact Qwen settings bytes and preserves subsequent user changes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qw-restore-'));
  const env = { HOME: root, QWEN_HOME: path.join(root, 'qwen'), XDG_STATE_HOME: path.join(root, 'state') };
  const file = path.join(env.QWEN_HOME, 'settings.json');
  const original = '\uFEFF{\r\n\t"agents": {"crossSessionInbound": "hold"}, "hooks": {}\r\n}';
  const input = { env, entry: { command: 'node', args: ['mcp', '--harness', 'qwen'] }, command: 'node khala hook deliver --harness qwen', uninstall: false, stdout: () => {}, stderr: () => {} };
  try {
    await fs.mkdir(env.QWEN_HOME); await fs.writeFile(file, original);
    expect(await installQwen(input)).toBe(0);
    expect(await installQwen(input)).toBe(0);
    expect(await installQwen({ ...input, uninstall: true })).toBe(0);
    expect(await fs.readFile(file, 'utf8')).toBe(original);
    expect(await installQwen(input)).toBe(0);
    const changed = JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/u, ''));
    changed.theme = 'dark'; await fs.writeFile(file, JSON.stringify(changed));
    expect(await installQwen({ ...input, uninstall: true })).toBe(0);
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ agents: { crossSessionInbound: 'hold' }, hooks: {}, theme: 'dark' });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
