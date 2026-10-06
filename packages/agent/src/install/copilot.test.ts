import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { copilotPaths, copilotHookCommands, mergeCopilotMcp, mergeCopilotHooks } from './copilot';
import { runInstall } from './main';
import { readWakeSettings } from '../wake/shared';
import { stateRoot } from '../state';

it('targets COPILOT_HOME and native Windows npm layout', () => {
  expect(copilotPaths({ platform: 'win32', path: path.win32, home: 'C:\\Users\\Ada', env: { COPILOT_HOME: 'D:\\copilot' } }))
    .toMatchObject({ mcpFile: 'D:\\copilot\\mcp-config.json', hooksFile: 'D:\\copilot\\hooks\\khala.json',
      script: 'C:\\Users\\Ada\\AppData\\Local\\khala\\npm\\node_modules\\khala-cli\\dist\\khala.mjs' });
});
it('quotes bash and PowerShell paths independently', () => {
  const commands = copilotHookCommands("/node's", "/script's $file.mjs", 'agentStop');
  expect(commands.bash).toBe("'/node'\\''s' '/script'\\''s $file.mjs' hook deliver --harness copilot --event agentStop");
  expect(commands.powershell).toBe("& '/node''s' '/script''s $file.mjs' hook deliver --harness copilot --event agentStop");
});
it('rejects malformed and foreign server configurations', () => {
  expect(mergeCopilotMcp({ mcpServers: { khala: { command: 'other' } } }, {})).toEqual({ error: 'copilot_mcp_exists' });
  expect(mergeCopilotMcp({ mcpServers: { khala: { args: ['copilot', 'mcp'] } } }, {})).toEqual({ error: 'copilot_mcp_exists' });
  expect(mergeCopilotMcp({ mcpServers: [] }, {})).toEqual({ error: 'invalid_config' });
  expect(mergeCopilotHooks({ hooks: { agentStop: [null] } }, null)).toEqual({ error: 'invalid_config' });
});
it.each([true, false])('installs once, preserves config, records wake=%s and uninstalls only Khala', async wake => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'khala-copilot-'));
  try {
    const env = { HOME: root, XDG_STATE_HOME: path.join(root, 'state'), XDG_DATA_HOME: path.join(root, 'data') };
    const paths = copilotPaths({ platform: 'linux', path, home: root, env });
    await fs.mkdir(path.dirname(paths.hooksFile), { recursive: true });
    const original = { mcpServers: { other: { command: 'other' } }, extra: true };
    const audit = { type: 'command', bash: 'audit.sh', powershell: 'audit.ps1' };
    await fs.writeFile(paths.mcpFile, JSON.stringify(original));
    await fs.writeFile(paths.hooksFile, JSON.stringify({ version: 1, hooks: { agentStop: [audit] } }));
    const output: string[] = [];
    const deps = { env, home: root, platform: 'linux' as const, node: '/node', package: { name: 'khala-cli', version: '1.2.3' },
      npmInstall: () => true, stdout: (line: string) => { output.push(line); }, stderr: (line: string) => { throw Error(line); } };
    const flags = ['copilot', wake ? '--wake' : '--no-wake'];
    expect(await runInstall(flags, deps)).toBe(0);
    const installed = JSON.parse(await fs.readFile(paths.mcpFile, 'utf8'));
    expect(installed).toEqual({ ...original, mcpServers: { ...original.mcpServers,
      khala: { type: 'local', command: '/node', args: [paths.script, 'mcp', '--harness', 'copilot'], tools: ['*'] } } });
    const hooks = JSON.parse(await fs.readFile(paths.hooksFile, 'utf8'));
    const normalized = JSON.stringify({ mcp: installed, hooks }, null, 2).replaceAll(root, '<HOME>') + '\n';
    expect(normalized).toBe(await fs.readFile(new URL('../harness/__golden__/install-copilot.json', import.meta.url), 'utf8'));
    expect(Object.keys(hooks.hooks).sort()).toEqual(['agentStop', 'postToolUse', 'sessionStart', 'userPromptSubmitted']);
    for (const [event, handlers] of Object.entries(hooks.hooks) as [string, Record<string, unknown>[]][]) {
      expect(handlers.at(-1)).toEqual({ type: 'command', ...copilotHookCommands('/node', paths.script, event), timeoutSec: 10 });
    }
    expect((await readWakeSettings(stateRoot(env))).consent['copilot/terminal'] !== undefined).toBe(wake);
    expect(await runInstall(flags, deps)).toBe(0);
    expect(JSON.parse(await fs.readFile(paths.hooksFile, 'utf8'))).toEqual(hooks);
    expect(JSON.parse(await fs.readFile(paths.mcpFile + '.khala-bak', 'utf8'))).toEqual(original);
    expect(await runInstall(['copilot', '--uninstall'], deps)).toBe(0);
    expect(JSON.parse(await fs.readFile(paths.mcpFile, 'utf8'))).toEqual(original);
    expect(JSON.parse(await fs.readFile(paths.hooksFile, 'utf8'))).toEqual({ version: 1, hooks: { agentStop: [audit] } });
    expect(output.join('\n')).toContain('AI credits');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it.each(['invalid-mcp', 'invalid-hooks', 'foreign-server', 'npm-failure'])('leaves config and consent untouched on %s', async failure => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'khala-copilot-failure-'));
  try {
    const env = { HOME: root, XDG_STATE_HOME: path.join(root, 'state') };
    const paths = copilotPaths({ platform: 'linux', path, home: root, env });
    await fs.mkdir(path.dirname(paths.hooksFile), { recursive: true });
    const mcp = failure === 'invalid-mcp' ? '{broken' : JSON.stringify({ mcpServers: failure === 'foreign-server'
      ? { khala: { command: 'other' } } : { other: { command: 'other' } } });
    const hooks = failure === 'invalid-hooks' ? '{broken' : '{"version":1,"hooks":{}}';
    await fs.writeFile(paths.mcpFile, mcp);
    await fs.writeFile(paths.hooksFile, hooks);
    const errors: string[] = [];
    expect(await runInstall(['copilot'], { env, home: root, platform: 'linux', node: '/node',
      package: { name: 'khala-cli', version: '1.2.3' }, npmInstall: () => false,
      stdout: () => {}, stderr: line => { errors.push(line); } })).toBe(1);
    expect(errors).toHaveLength(1);
    expect(await fs.readFile(paths.mcpFile, 'utf8')).toBe(mcp);
    expect(await fs.readFile(paths.hooksFile, 'utf8')).toBe(hooks);
    expect((await readWakeSettings(stateRoot(env))).consent['copilot/terminal']).toBeUndefined();
    expect(await fs.readdir(paths.copilotDir)).toEqual(expect.arrayContaining(['hooks', 'mcp-config.json']));
    expect(await fs.stat(paths.mcpFile + '.khala-bak').catch(() => null)).toBeNull();
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
