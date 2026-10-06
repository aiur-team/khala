import * as fs from 'node:fs/promises';
import * as syncFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { installQwen, mergeQwenSettings, QWEN_WATCH_PERMISSION } from './qwen';
import { parseQwenControllerIds, runInstall, runQwenInstall } from './main';
import { qwenControllerFile } from '../wake/qwen-socket';

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
    expect(JSON.parse(await fs.readFile(path.join(root, '.qwen/settings.json'), 'utf8'))).toEqual({});
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

it('Windows install grants the exact persisted private CLI watcher command', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qw-win-command-'));
  const env = { HOME: root, QWEN_HOME: path.join(root, 'qwen'), XDG_STATE_HOME: path.join(root, 'state'), LOCALAPPDATA: 'C:\\Users\\Example User\\AppData\\Local' };
  try {
    expect(await runQwenInstall([], { env, platform: 'win32', node: 'C:\\Program Files\\nodejs\\node.exe', package: { name: 'khala-cli', version: '0.4.8' }, npmInstall: () => true, stdout: () => {}, stderr: () => {} })).toBe(0);
    const installed = JSON.parse(await fs.readFile(path.join(env.XDG_STATE_HOME, 'khala/qwen/watch-command.json'), 'utf8'));
    expect(installed.command).toContain('"C:/Program Files/nodejs/node.exe"');
    expect(installed.command).toContain('khala.mjs" watch --harness qwen');
    const settings = JSON.parse(await fs.readFile(path.join(env.QWEN_HOME, 'settings.json'), 'utf8'));
    expect(settings.permissions.allow).toEqual([`Bash(${installed.command} --session *)`]);
    expect(settings.permissions.allow).not.toContain(QWEN_WATCH_PERMISSION);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
