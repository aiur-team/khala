import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { mergeQwenSettings, QWEN_WATCH_PERMISSION } from './qwen';
import { runInstall } from './main';
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
    expect(JSON.parse(await fs.readFile(path.join(env.QWEN_HOME, 'settings.json'), 'utf8'))).toEqual({ agents: { crossSessionInbound: 'hold' }, mcpServers: {}, hooks: {} });
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
