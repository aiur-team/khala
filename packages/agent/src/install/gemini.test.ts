import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { runInstall } from './main';
import { GEMINI_HOOK_EVENTS, geminiMcpEntry, geminiPaths, mergeGeminiSettings } from './gemini';
import { resolveSources } from '../harness/session-sources';
import { deliverCore } from '../harness/deliver-core';
import { gemini } from '../harness/gemini';
import { readWakeSettings } from '../wake/shared';
import { stateRoot } from '../state';

let home: string;
let lines: string[];
beforeEach(async () => { home = await fs.mkdtemp(path.join(os.tmpdir(), 'khala-gemini-install-')); lines = []; });
afterEach(async () => { await fs.rm(home, { recursive: true, force: true }); });
const settingsFile = () => path.join(home, '.gemini', 'settings.json');
const deps = () => ({ home, env: { HOME: home, XDG_STATE_HOME: path.join(home, 'state') }, platform: 'linux' as const,
  node: process.execPath, package: { name: 'khala-cli', version: '1.2.3' }, npmInstall: () => true,
  stdout: (line: string) => { lines.push(line); }, stderr: (line: string) => { lines.push(line); } });

it('merges siblings, installs without tool trust, reinstalls idempotently, and uninstalls only Khala', async () => {
  const audit = { matcher: '*', hooks: [{ type: 'command', command: './audit' }] };
  const original = { theme: 'dark', mcpServers: { other: { command: 'other' } }, hooks: { AfterTool: [audit] } };
  await fs.mkdir(path.dirname(settingsFile()), { recursive: true });
  await fs.writeFile(settingsFile(), JSON.stringify(original));
  expect(await runInstall(['gemini'], deps())).toBe(0);
  const installed = JSON.parse(await fs.readFile(settingsFile(), 'utf8'));
  expect(installed.theme).toBe('dark');
  expect(installed.mcpServers.other).toEqual(original.mcpServers.other);
  expect(installed.mcpServers.khala).not.toHaveProperty('trust');
  expect(installed.hooks.AfterTool[0]).toEqual(audit);
  for (const event of GEMINI_HOOK_EVENTS) expect(installed.hooks[event].at(-1).hooks[0].command).toContain('hook deliver --harness gemini');
  expect((await readWakeSettings(stateRoot(deps().env))).consent['gemini/terminal']).toHaveProperty('at');
  expect(await runInstall(['gemini'], deps())).toBe(0);
  expect(JSON.parse(await fs.readFile(settingsFile(), 'utf8'))).toEqual(installed);
  expect(await runInstall(['gemini', '--uninstall'], deps())).toBe(0);
  expect(JSON.parse(await fs.readFile(settingsFile(), 'utf8'))).toEqual(original);
  expect(JSON.parse(await fs.readFile(settingsFile() + '.khala-bak', 'utf8'))).toEqual(original);
});
it('records explicit tool trust, explains approvals, and removes trust on default reinstall', async () => {
  expect(await runInstall(['gemini', '--trust-tools', '--no-wake'], deps())).toBe(0);
  expect(JSON.parse(await fs.readFile(settingsFile(), 'utf8')).mcpServers.khala.trust).toBe(true);
  expect(lines.join('\n')).toMatch(/auto-approves.*khala_send.*khala_join/);
  expect((await readWakeSettings(stateRoot(deps().env))).consent).toEqual({});
  expect(await runInstall(['gemini'], deps())).toBe(0);
  expect(JSON.parse(await fs.readFile(settingsFile(), 'utf8')).mcpServers.khala).not.toHaveProperty('trust');
});
it('refuses malformed settings and foreign Khala servers without installing', async () => {
  for (const original of ['{oops', JSON.stringify({ mcpServers: { khala: { command: 'foreign' } } }), JSON.stringify({ mcpServers: { khala: { args: ['gemini', 'mcp'] } } })]) {
    await fs.mkdir(path.dirname(settingsFile()), { recursive: true });
    await fs.writeFile(settingsFile(), original);
    expect(await runInstall(['gemini'], { ...deps(), npmInstall: () => { throw new Error('must not install'); } })).toBe(1);
    expect(await fs.readFile(settingsFile(), 'utf8')).toBe(original);
  }
  expect(mergeGeminiSettings({ hooks: { AfterTool: [{}] } }, null, null)).toEqual({ error: 'invalid_config' });
});
it('preserves sibling handlers in the same hook group', () => {
  const audit = { type: 'command', command: './audit' };
  const source = { hooks: { AfterTool: [{ matcher: 'read_file', sequential: true, hooks: [audit,
    { type: 'command', command: '/old hook deliver --harness gemini' }] }] } };
  expect(mergeGeminiSettings(source, null, null)).toEqual({ config: { mcpServers: {}, hooks: { AfterTool: [{ matcher: 'read_file', sequential: true, hooks: [audit] }] } } });
});
it('uses the native Windows global layout', () => {
  expect(geminiPaths({ platform: 'win32', path: path.win32, home: 'C:\\Users\\Ada', env: {} })).toMatchObject({
    settingsFile: 'C:\\Users\\Ada\\.gemini\\settings.json',
    script: 'C:\\Users\\Ada\\AppData\\Local\\khala\\npm\\node_modules\\khala-cli\\dist\\khala.mjs',
  });
});
it('installed hooks and MCP resolve the same nearest non-shell harness', async () => {
  expect(await runInstall(['gemini'], deps())).toBe(0);
  const settings = JSON.parse(await fs.readFile(settingsFile(), 'utf8'));
  const entry = settings.mcpServers.khala;
  expect(entry.command).toBe(process.execPath);
  expect(entry.args).toEqual([geminiPaths({ platform: 'linux', path: path.posix, home, env: deps().env }).script, 'mcp', '--harness', 'gemini']);
  const command = settings.hooks.SessionStart[0].hooks[0].command;
  expect(command).toBe(`${entry.command} ${entry.args[0]} hook deliver --harness gemini`);
  // Direct Node children share the harness; only the hook shell is skipped.
  const processes = new Map([
    [100, { pid: 100, ppid: 1, command: 'gemini', startTime: 'harness' }],
    [200, { pid: 200, ppid: 100, command: 'sh', startTime: 'shell' }],
    [300, { pid: 300, ppid: 200, command: entry.command, startTime: 'hook' }],
    [400, { pid: 400, ppid: 100, command: entry.command, startTime: 'mcp' }],
  ]);
  const readProcess = async (pid: number) => processes.get(pid) ?? null;
  await deliverCore('{"session_id":"installed","hook_event_name":"SessionStart"}', gemini, {
    env: deps().env, now: () => new Date(), pid: 300, readProcess, stdout: { write: () => {} }, stderr: { write: () => {} },
  });
  expect(await resolveSources(gemini.sessionSources, undefined, deps().env, { harness: 'gemini', pid: 400, readProcess }))
    .toEqual({ sessionId: 'installed', rejoinable: true });
});
it.each([true, false])('does not mutate settings, backup or consent when npm installation fails (existing=%s)', async existing => {
  const original = '{ "theme": "dark" }\n';
  if (existing) {
    await fs.mkdir(path.dirname(settingsFile()), { recursive: true });
    await fs.writeFile(settingsFile(), original);
  }
  expect(await runInstall(['gemini'], { ...deps(), npmInstall: () => false })).toBe(1);
  if (existing) expect(await fs.readFile(settingsFile(), 'utf8')).toBe(original);
  else await expect(fs.stat(settingsFile())).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(fs.stat(settingsFile() + '.khala-bak')).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await readWakeSettings(stateRoot(deps().env))).consent).toEqual({});
});
it('uninstalls absent settings without creating files', async () => {
  expect(await runInstall(['gemini', '--uninstall'], { ...deps(), package: undefined, npmInstall: () => { throw new Error('must not install'); } })).toBe(0);
  await expect(fs.stat(settingsFile())).rejects.toMatchObject({ code: 'ENOENT' });
});
it.each([true, false])('preserves the global hooks enabled=%s setting', enabled => {
  const added = mergeGeminiSettings({ hooks: { enabled }, theme: 'dark' }, geminiMcpEntry('/node', '/script'), '/node /script hook deliver --harness gemini');
  expect(added).toHaveProperty('config.hooks.enabled', enabled);
  if ('config' in added) expect(mergeGeminiSettings(added.config, null, null))
    .toEqual({ config: { theme: 'dark', mcpServers: {}, hooks: { enabled } } });
});
