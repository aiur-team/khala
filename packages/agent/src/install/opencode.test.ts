import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mergeOpenCodeConfig, opencodeMcpEntry, opencodePaths } from './opencode';
import { runInstall } from './main';

let home: string;
beforeEach(async () => { home = await fs.mkdtemp(path.join(os.tmpdir(), 'khala-opencode-install-')); });
afterEach(async () => { await fs.rm(home, { recursive: true, force: true }); });

it.each(['linux', 'darwin', 'win32'] as const)('uses documented global paths and stable binary on %s', platform => {
  const api = platform === 'win32' ? path.win32 : path.posix;
  const home = platform === 'win32' ? 'C:\\Users\\Ada' : '/home/ada';
  const paths = opencodePaths({ platform, path: api, home, env: {} });
  expect(paths.configFile).toBe(api.join(home, '.config', 'opencode', 'opencode.json'));
  const entry = opencodeMcpEntry(platform, paths.bin);
  expect(entry).toEqual({ type: 'local', command: [...(platform === 'win32' ? ['cmd', '/c'] : []), paths.bin, 'mcp', '--harness', 'opencode'], environment: {}, enabled: true });
  expect(entry).not.toHaveProperty('env');
  expect(opencodePaths({ platform, path: api, home, env: { XDG_CONFIG_HOME: api.join(home, 'cfg') } }).configDir)
    .toBe(api.join(home, 'cfg', 'opencode'));
});

it('has fresh, sibling, reinstall and uninstall config goldens', () => {
  const pin = 'khala-opencode@1.2.3';
  expect(mergeOpenCodeConfig({}, pin)).toEqual({ config: { plugin: [pin] } });
  const siblings = { model: 'provider/model', plugin: ['other@1', 'khala-opencode@0.1.0'], mcp: { other: { enabled: true } } };
  const installed = { ...siblings, plugin: ['other@1', pin] };
  expect(mergeOpenCodeConfig(siblings, pin)).toEqual({ config: installed });
  expect(mergeOpenCodeConfig(installed, pin)).toEqual({ config: installed });
  expect(mergeOpenCodeConfig({ ...installed, mcp: { ...installed.mcp, khala: opencodeMcpEntry('linux', '/bin/khala') } }, null))
    .toEqual({ config: { ...installed, plugin: ['other@1'], mcp: installed.mcp } });
  expect(mergeOpenCodeConfig({ plugin: [], mcp: { khala: { command: ['other'] } } }, null))
    .toEqual({ config: { plugin: [], mcp: { khala: { command: ['other'] } } } });
});
it.each([null, [], { plugin: 'bad' }, { plugin: [1] }, { mcp: [] }])('refuses invalid config %s', config => {
  expect(mergeOpenCodeConfig(config, 'khala-opencode@1')).toEqual({ error: 'invalid_config' });
});
it('installs, replaces the pin with a test override, preserves backup and uninstalls', async () => {
  const npmInstall = vi.fn(() => true);
  const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, 'config'), KHALA_INSTALL_SPEC: '/test/cli.tgz' };
  const deps = { home, env, package: { name: 'khala-cli', version: '1.2.3' }, npmInstall, stdout: vi.fn(), stderr: vi.fn() };
  const paths = opencodePaths({ home, env, platform: process.platform, path });
  await fs.mkdir(paths.configDir, { recursive: true });
  const original = '{"plugin":["sibling"],"model":"mine"}\n';
  await fs.writeFile(paths.configFile, original);
  expect(await runInstall(['opencode'], deps)).toBe(0);
  expect(npmInstall).toHaveBeenCalledWith(paths.prefix, '/test/cli.tgz');
  const installed = await fs.readFile(paths.configFile, 'utf8');
  expect(JSON.parse(installed)).toEqual({ plugin: ['sibling', 'khala-opencode@1.2.3'], model: 'mine' });
  expect(await runInstall(['opencode'], deps)).toBe(0);
  expect(await fs.readFile(paths.configFile, 'utf8')).toBe(installed);
  const override = 'file:/test/custom-plugin.tgz';
  expect(await runInstall(['opencode'], { ...deps, env: { ...env, KHALA_OPENCODE_PLUGIN_SPEC: override } })).toBe(0);
  expect(JSON.parse(await fs.readFile(paths.configFile, 'utf8')).plugin).toEqual(['sibling', override]);
  expect(await fs.readFile(paths.configFile + '.khala-bak', 'utf8')).toBe(original);
  expect(await runInstall(['opencode', '--uninstall'], { ...deps, package: undefined })).toBe(0);
  expect(JSON.parse(await fs.readFile(paths.configFile, 'utf8'))).toEqual({ plugin: ['sibling'], model: 'mine' });
});
it('does not install or modify invalid JSON or a failed package install', async () => {
  const deps = { home, env: { HOME: home }, package: { name: 'khala-cli', version: '1' }, npmInstall: vi.fn(() => false), stdout: vi.fn(), stderr: vi.fn() };
  const paths = opencodePaths({ home, env: deps.env, platform: process.platform, path });
  expect(await runInstall(['opencode'], deps)).toBe(1);
  await expect(fs.stat(paths.configFile)).rejects.toMatchObject({ code: 'ENOENT' });
  await fs.mkdir(paths.configDir, { recursive: true });
  await fs.writeFile(paths.configFile, 'bad');
  deps.npmInstall.mockClear();
  expect(await runInstall(['opencode'], deps)).toBe(1);
  expect(deps.npmInstall).not.toHaveBeenCalled();
  expect(await fs.readFile(paths.configFile, 'utf8')).toBe('bad');
  expect(await runInstall(['opencode', '--unknown'], deps)).toBe(1);
});
