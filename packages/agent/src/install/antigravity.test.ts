import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { runInstall } from './main';
import { antigravityPaths, antigravityFormat, antigravityHooks, mergeAntigravity } from './antigravity';
import { readWakeSettings } from '../wake/shared';
import { stateRoot } from '../state';

let root: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'khala-agy-install-')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
function setup() {
  const env = { HOME: root, XDG_STATE_HOME: path.join(root, 'state') };
  const paths = antigravityPaths({ platform: 'linux', path: path.posix, home: root, env });
  const deps = { env, home: root, package: { name: 'khala-cli', version: '1.2.3' }, npmInstall: vi.fn(() => true), stdout: vi.fn(), stderr: vi.fn() };
  return { env, paths, deps };
}
it('installs both configs, records consent and restores exact JSONC bytes after reinstall', async () => {
  const { paths, deps, env } = setup();
  await fs.mkdir(path.dirname(paths.mcpFile), { recursive: true });
  const original = '// original\n{"mcpServers":{"sibling":{"command":"https://x/*ok*/",},},}\n';
  await fs.writeFile(paths.mcpFile, original);
  expect(await runInstall(['antigravity'], deps)).toBe(0);
  const installed = await fs.readFile(paths.mcpFile, 'utf8');
  expect(JSON.parse(installed).mcpServers).toMatchObject({ sibling: { command: 'https://x/*ok*/' }, khala: { command: paths.bin, args: ['mcp', '--harness', 'antigravity'] } });
  const hooks = JSON.parse(await fs.readFile(paths.hooksFile, 'utf8')).khala;
  expect(Object.keys(hooks)).toEqual(['PreInvocation', 'Stop']);
  expect(hooks.Stop[0].timeout).toBe(10);
  expect(hooks.Stop[0].command).toContain(' hook deliver --harness antigravity --event Stop');
  expect(Object.keys((await readWakeSettings(stateRoot(env))).consent)).toEqual(['antigravity/antigravity-native', 'antigravity/terminal']);
  expect(await runInstall(['antigravity'], deps)).toBe(0);
  expect(await fs.readFile(paths.mcpFile, 'utf8')).toBe(installed);
  expect(await runInstall(['antigravity', '--uninstall'], deps)).toBe(0);
  expect(await fs.readFile(paths.mcpFile, 'utf8')).toBe(original);
  await expect(fs.stat(paths.hooksFile)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('preserves edits and sibling named hooks, declines consent and refuses foreign entries before npm', async () => {
  const { paths, deps, env } = setup();
  await fs.mkdir(path.dirname(paths.mcpFile), { recursive: true });
  await fs.writeFile(paths.hooksFile, '{"sibling":{"Stop":[]}}');
  expect(await runInstall(['antigravity', '--no-wake'], deps)).toBe(0);
  expect((await readWakeSettings(stateRoot(env))).consent).toEqual({});
  const edited = JSON.parse(await fs.readFile(paths.mcpFile, 'utf8')); edited.newSetting = true;
  await fs.writeFile(paths.mcpFile, JSON.stringify(edited));
  expect(await runInstall(['antigravity', '--uninstall'], deps)).toBe(0);
  expect(JSON.parse(await fs.readFile(paths.mcpFile, 'utf8'))).toEqual({ newSetting: true });
  expect(JSON.parse(await fs.readFile(paths.hooksFile, 'utf8'))).toEqual({ sibling: { Stop: [] } });
  await fs.writeFile(paths.hooksFile, '{"khala":{"Stop":[{"command":"foreign"}]}}');
  deps.npmInstall.mockClear();
  expect(await runInstall(['antigravity'], deps)).toBe(1);
  expect(deps.npmInstall).not.toHaveBeenCalled();
});
it('does not corrupt strings and refuses invalid containers', () => {
  expect(antigravityFormat.parse('{/*c*/"a": "x,} //y", "b":[1,],}')).toEqual({ a: 'x,} //y', b: [1] });
  expect(() => antigravityFormat.parse('{"x":1/*comment*/2}')).toThrow();
  expect(() => mergeAntigravity({ mcpServers: { khala: { args: ['antigravity', 'mcp'] } } }, 'mcp', null)).toThrow();
  expect(() => mergeAntigravity({ mcpServers: [] }, 'mcp', null)).toThrow();
  expect(() => mergeAntigravity({ mcpServers: { khala: { command: 'foreign' } } }, 'mcp', null)).toThrow();
});

it('uses stable launchers on POSIX and Windows and quotes hook paths', async () => {
  const layouts = [
    { platform: 'linux' as const, path: path.posix, home: "/home/agent's space", env: {} },
    { platform: 'win32' as const, path: path.win32, home: 'C:\\Users\\Agent Space', env: {} },
  ].map(input => {
    const paths = antigravityPaths(input);
    return { bin: paths.bin, mcp: { command: paths.bin, args: ['mcp', '--harness', 'antigravity'] }, hooks: antigravityHooks(input.platform, paths.bin) };
  });
  expect(layouts).toEqual(JSON.parse(await fs.readFile(new URL('./__golden__/antigravity-launchers.json', import.meta.url), 'utf8')));
});
it('upgrades and uninstalls previously managed node-script entries', async () => {
  const { paths, deps } = setup();
  await fs.mkdir(path.dirname(paths.mcpFile), { recursive: true });
  const legacy = { mcpServers: { khala: { command: '/versioned/node', args: [paths.script, 'mcp', '--harness', 'antigravity'] } } };
  const hooks = Object.fromEntries(['PreInvocation', 'Stop'].map(event => [event, [{ command: `/versioned/node ${paths.script} hook deliver --harness antigravity --event ${event}`, type: 'command', timeout: 10 }]]));
  await fs.writeFile(paths.mcpFile, JSON.stringify(legacy));
  await fs.writeFile(paths.hooksFile, JSON.stringify({ khala: hooks }));
  expect(await runInstall(['antigravity'], deps)).toBe(0);
  expect(JSON.parse(await fs.readFile(paths.mcpFile, 'utf8')).mcpServers.khala.command).toBe(paths.bin);
  expect(await runInstall(['antigravity', '--uninstall'], deps)).toBe(0);
  // The pre-existing managed entry is restored by provenance, and remains removable without provenance.
  expect(mergeAntigravity(legacy, 'mcp', null)).toEqual({ mcpServers: {} });
  expect(mergeAntigravity({ khala: hooks }, 'hooks', null)).toEqual({});
});
