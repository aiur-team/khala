import * as fs from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { parse } from 'smol-toml';

const base = fileURLToPath(new URL('../../', import.meta.url));
const installer = path.join(base, 'codex/install-hooks.mjs');
const command = 'khala hook deliver --harness codex';
let home: string;
const install = (action = 'install') => spawnSync(process.execPath, [installer, action, '--codex-home', home], { encoding: 'utf8' });
beforeEach(async () => { home = await fs.mkdtemp(path.join(os.tmpdir(), 'khala-853-config-')); });
afterEach(async () => { await fs.rm(home, { recursive: true, force: true }); });
it('registers exactly the three shared delivery hooks', async () => {
  const config = JSON.parse(await fs.readFile(path.join(base, 'hooks/hooks.codex.json'), 'utf8'));
  expect(Object.keys(config.hooks).sort()).toEqual(['PostToolUse', 'Stop', 'UserPromptSubmit']);
  for (const groups of Object.values(config.hooks)) expect(groups).toEqual([{ hooks: [{ type: 'command', command, timeout: 10 }] }]);
});
it('preserves legacy and unrelated groups, backs up once, installs idempotently and uninstalls exactly ours', async () => {
  const old = { type: 'command', command: "'/old/khala/bin/khala' codex-hook", timeout: 8 };
  const original = { extra: 'keep', hooks: { UserPromptSubmit: [{ matcher: 'keep', hooks: [old] }], Stop: [{ hooks: [old] }], PreToolUse: [{ hooks: [old] }], PostToolUse: [{ hooks: [old] }] } };
  const file = path.join(home, 'hooks.json');
  const bytes = JSON.stringify(original);
  await fs.writeFile(file, bytes, { mode: 0o640 });
  const first = install(); expect(first.status).toBe(0); expect(first.stderr).toContain('codex-hook');
  expect(first.stdout).toContain('installed; restart or resume Codex and trust the Khala hooks');
  const installed = await fs.readFile(file, 'utf8');
  const config = JSON.parse(installed);
  expect(config.hooks.UserPromptSubmit[0]).toEqual(original.hooks.UserPromptSubmit[0]);
  expect(config.hooks.PostToolUse[1]).toEqual({ hooks: [{ type: 'command', command, timeout: 10 }] });
  expect(Object.values(config.hooks).flat()).toHaveLength(7);
  expect((await fs.stat(file)).mode & 0o777).toBe(0o640);
  expect(install().status).toBe(0); expect(await fs.readFile(file, 'utf8')).toBe(installed);
  expect(await fs.readFile(file + '.khala-bak', 'utf8')).toBe(bytes);
  expect(install('uninstall').status).toBe(0); expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual(original);
});
it('removes only our handlers from mixed groups', async () => {
  const file = path.join(home, 'hooks.json');
  const other = { type: 'command', command: command + ' extra' };
  await fs.writeFile(file, JSON.stringify({ hooks: { Empty: [], Other: [{ hooks: [] }], Stop: [{ matcher: 'x', hooks: [{ command }, other] }] } }));
  expect(install('uninstall').status).toBe(0);
  expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({ hooks: { Empty: [], Other: [{ hooks: [] }], Stop: [{ matcher: 'x', hooks: [other] }] } });
});
it('refuses malformed input without changing it or creating a backup', async () => {
  const file = path.join(home, 'hooks.json');
  for (const bytes of ['{bad', 'null', '{"hooks":[]}']) {
    await fs.writeFile(file, bytes); expect(install().status).toBe(1);
    expect(await fs.readFile(file, 'utf8')).toBe(bytes);
    await expect(fs.stat(file + '.khala-bak')).rejects.toMatchObject({ code: 'ENOENT' });
  }
});
it('supports missing config and CODEX_HOME', async () => {
  execFileSync(process.execPath, [installer, 'install'], { env: { ...process.env, CODEX_HOME: home } });
  expect((await fs.stat(path.join(home, 'hooks.json'))).mode & 0o777).toBe(0o600);
  expect(install('uninstall').status).toBe(0);
  expect(JSON.parse(await fs.readFile(path.join(home, 'hooks.json'), 'utf8'))).toEqual({ hooks: {} });
});
it('parses the MCP example and uses the merged KM-112 setup defaults', async () => {
  const config = parse(await fs.readFile(path.join(base, 'codex/config.toml.example'), 'utf8'));
  expect(config).toMatchObject({ mcp_servers: { khala: { command: 'khala', args: ['mcp', '--harness', 'codex'], env: { HOME: '/home/you', XDG_STATE_HOME: '/home/you/.local/state' } } } });
});
