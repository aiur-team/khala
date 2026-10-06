import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { parse } from 'smol-toml';
import { MCP_MARKER, runInstall, shellQuote, updateCodexToml } from './main';

let home: string;
let lines: string[];
let installs: Array<[string, string]>;
beforeEach(async () => { home = await fs.mkdtemp(path.join(os.tmpdir(), 'khala-install-')); lines = []; installs = []; });
afterEach(async () => { await fs.rm(home, { recursive: true, force: true }); });

const codex = () => path.join(home, '.codex');
const run = (argv: string[], ok = true) => runInstall(argv, {
  env: { HOME: home },
  package: { name: 'khala-cli', version: '9.8.7' },
  npmInstall: (prefix, spec) => { installs.push([prefix, spec]); return ok; },
  stdout: line => { lines.push(line); }, stderr: line => { lines.push(line); },
});

it('installs the pinned package and points Codex MCP and hooks at its stable bin', async () => {
  await fs.mkdir(codex());
  await fs.writeFile(path.join(codex(), 'config.toml'), 'model = "x"\n\n[mcp_servers.other]\ncommand = "o"\n');
  expect(await run(['codex'])).toBe(0);
  const prefix = path.join(home, '.local/share/khala/npm');
  expect(installs).toEqual([[prefix, 'khala-cli@9.8.7']]);
  const bin = path.join(prefix, 'bin/khala');
  const toml = await fs.readFile(path.join(codex(), 'config.toml'), 'utf8');
  expect(parse(toml)).toEqual({
    model: 'x',
    mcp_servers: {
      other: { command: 'o' },
      khala: { command: bin, args: ['mcp', '--harness', 'codex'], env: { HOME: home, XDG_STATE_HOME: path.join(home, '.local/state') } },
    },
  });
  const hooks = JSON.parse(await fs.readFile(path.join(codex(), 'hooks.json'), 'utf8'));
  expect(Object.keys(hooks.hooks).sort()).toEqual(['PostToolUse', 'Stop', 'UserPromptSubmit']);
  for (const groups of Object.values(hooks.hooks)) {
    expect(groups).toEqual([{ hooks: [{ type: 'command', command: `${shellQuote(bin)} hook deliver --harness codex`, timeout: 10 }] }]);
  }
  // Idempotent: a second install rewrites the managed block in place and adds no hooks.
  expect(await run(['codex'])).toBe(0);
  expect(await fs.readFile(path.join(codex(), 'config.toml'), 'utf8')).toBe(toml);
  expect(JSON.parse(await fs.readFile(path.join(codex(), 'hooks.json'), 'utf8'))).toEqual(hooks);
  // Uninstall restores the original config and removes the hooks.json it created.
  expect(await run(['codex', '--uninstall'])).toBe(0);
  expect(await fs.readFile(path.join(codex(), 'config.toml'), 'utf8')).toBe('model = "x"\n\n[mcp_servers.other]\ncommand = "o"\n');
  expect((await fs.readdir(codex())).sort()).toEqual(['config.toml']);
});

it('refuses an unmanaged khala table and malformed hooks without writing or installing', async () => {
  await fs.mkdir(codex());
  await fs.writeFile(path.join(codex(), 'config.toml'), '[mcp_servers.khala]\ncommand = "khala"\n');
  expect(await run(['codex'])).toBe(1);
  expect(lines.join('\n')).toContain('unmanaged [mcp_servers.khala]');
  await fs.writeFile(path.join(codex(), 'config.toml'), '');
  await fs.writeFile(path.join(codex(), 'hooks.json'), '{bad');
  expect(await run(['codex'])).toBe(1);
  expect(installs).toEqual([]);
  expect(await fs.readFile(path.join(codex(), 'hooks.json'), 'utf8')).toBe('{bad');
});

it('stops before touching config when npm install fails, and rejects bad usage', async () => {
  expect(await run(['codex'], false)).toBe(1);
  await expect(fs.stat(codex())).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await run(['claude'])).toBe(1);
  expect(await run(['codex', '--bogus'])).toBe(1);
  expect(await runInstall(['codex'], { env: { HOME: home }, package: undefined, stderr: line => { lines.push(line); } })).toBe(1);
  expect(lines.at(-1)).toContain('published package');
});

it('keeps surrounding tables when replacing the managed block', () => {
  const block = `${MCP_MARKER}\n[mcp_servers.khala]\ncommand = "/a"`;
  const first = updateCodexToml('[a]\nx = 1\n', block);
  expect(first).toEqual({ text: `[a]\nx = 1\n\n${block}\n` });
  const withAfter = ('text' in first ? first.text : '') + '\n[b]\ny = 2\n';
  expect(updateCodexToml(withAfter, null)).toEqual({ text: '[a]\nx = 1\n\n[b]\ny = 2\n' });
  expect(shellQuote("/home/a b/it's")).toBe(`'/home/a b/it'\\''s'`);
});

it('records terminal consent once in shared dispatch and supports withdrawal and explicit re-consent', async () => {
  const { readWakeSettings } = await import('../wake/shared');
  const { stateRoot } = await import('../state');
  const settings = () => readWakeSettings(stateRoot({ HOME: home }));
  expect(await run(['codex'])).toBe(0);
  expect((await settings()).consent['codex/terminal']).toBeDefined();
  expect(lines.at(-1)).toContain('Idle wake is on (terminal)');
  expect(lines.at(-1)).toContain('khala wake off --harness codex');
  expect(await run(['codex', '--no-wake'])).toBe(0);
  expect((await settings()).consent).toEqual({});
  expect(lines.at(-1)).toContain('Idle wake is off for terminal.');
  expect(lines.at(-1)).toContain('khala wake on --harness codex');
  expect(await run(['codex', '--wake'])).toBe(0);
  expect((await settings()).consent['codex/terminal']).toBeDefined();
});
it('does not consent after a failed install', async () => {
  const { readWakeSettings } = await import('../wake/shared');
  const { stateRoot } = await import('../state');
  expect(await run(['codex'], false)).toBe(1);
  expect((await readWakeSettings(stateRoot({ HOME: home }))).consent).toEqual({});
});

it('passes a custom Codex home to MCP and removes it on uninstall', async () => {
  const custom = path.join(home, 'custom codex');
  const original = 'model = "gpt-5"\n';
  await fs.mkdir(custom, { recursive: true });
  await fs.writeFile(path.join(custom, 'config.toml'), original);
  expect(await run(['codex', '--codex-home', custom])).toBe(0);
  const config = () => fs.readFile(path.join(custom, 'config.toml'), 'utf8');
  expect(parse(await config())).toMatchObject({ mcp_servers: { khala: { env: { CODEX_HOME: custom } } } });
  expect(await run(['codex', '--codex-home', custom])).toBe(0);
  expect(parse(await config())).toMatchObject({ mcp_servers: { khala: { env: { CODEX_HOME: custom } } } });
  expect(await run(['codex', '--codex-home', custom, '--uninstall'])).toBe(0);
  expect(await config()).toBe(original);
});
it('passes an environment-selected custom home to MCP', async () => {
  const custom = path.join(home, 'env-codex');
  expect(await runInstall(['codex'], {
    env: { HOME: home, CODEX_HOME: custom }, package: { name: 'khala-cli', version: '9.8.7' },
    npmInstall: () => true, stdout: () => {},
  })).toBe(0);
  expect(parse(await fs.readFile(path.join(custom, 'config.toml'), 'utf8')))
    .toMatchObject({ mcp_servers: { khala: { env: { CODEX_HOME: custom } } } });
});
