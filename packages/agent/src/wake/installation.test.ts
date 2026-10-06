import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { nativeWakeInstallation } from './installation';
let root: string;
beforeEach(async () => { root = await mkdtemp(path.join(os.tmpdir(), 'wake-installation-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it('reads a custom Codex home and rejects disabled or unrelated MCP entries', async () => {
  const dir = path.join(root, 'custom');
  await mkdir(dir);
  const env = { HOME: root, CODEX_HOME: dir };
  for (const config of ['[mcp_servers.other]\ncommand="khala"', '[mcp_servers.khala]\ncommand="khala"\nargs=["mcp","--harness","codex"]\nenabled=false', 'invalid = [']) {
    await writeFile(path.join(dir, 'config.toml'), config);
    expect(await nativeWakeInstallation('codex', env)).toContain('not installed');
  }
  await writeFile(path.join(dir, 'config.toml'), '[mcp_servers."khala"]\ncommand="/custom/khala"\nargs=["mcp","--harness","codex"]');
  expect(await nativeWakeInstallation('codex', env)).toBeUndefined();
});

it('recognizes Codex hook-only installs and ignores other handlers', async () => {
  const dir = path.join(root, '.codex');
  await mkdir(dir);
  for (const [command, installed] of [['audit', false], ['"/custom path/khala" hook deliver --harness codex', true]] as const) {
    await writeFile(path.join(dir, 'hooks.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ command }] }] } }));
    expect(await nativeWakeInstallation('codex', { HOME: root })).toBe(installed ? undefined : 'Khala is not installed for codex; run khala install codex.');
  }
});
