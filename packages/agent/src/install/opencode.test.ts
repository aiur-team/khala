import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mergeOpenCodeConfig, opencodeMcpEntry, opencodePaths, opencodePluginPublished } from './opencode';
import { runInstall } from './main';

let home: string;
beforeEach(async () => { home = await fs.mkdtemp(path.join(os.tmpdir(), 'khala-opencode-install-')); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(home, { recursive: true, force: true }); });

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
    .toEqual({ config: { mcp: { khala: { command: ['other'] } } } });
});
it.each([null, [], { plugin: 'bad' }, { plugin: [1] }, { mcp: [] }])('refuses invalid config %s', config => {
  expect(mergeOpenCodeConfig(config, 'khala-opencode@1')).toEqual({ error: 'invalid_config' });
});
it('installs, replaces the pin with a test override and uninstalls to the exact original', async () => {
  const npmInstall = vi.fn(() => true);
  const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, 'config'), KHALA_INSTALL_SPEC: '/test/cli.tgz' };
  const deps = { home, env, package: { name: 'khala-cli', version: '1.2.3' }, npmInstall, fetchRegistry: vi.fn(async () => new Response('{}')), stdout: vi.fn(), stderr: vi.fn() };
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
  expect(await runInstall(['opencode', '--uninstall'], { ...deps, package: undefined })).toBe(0);
  expect(await fs.readFile(paths.configFile, 'utf8')).toBe(original);
  expect(await fs.readdir(paths.configDir)).toEqual(['opencode.json']);
});
it('does not install or modify invalid JSON or a failed package install', async () => {
  const deps = { home, env: { HOME: home }, package: { name: 'khala-cli', version: '1' }, fetchRegistry: vi.fn(async () => new Response('{}')), npmInstall: vi.fn(() => false), stdout: vi.fn(), stderr: vi.fn() };
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

it.each(['missing', 'network'] as const)('falls back on %s, reinstalls and cleans up', async failure => {
  const fetchRegistry = vi.fn(async () => {
    if (failure === 'network') throw new Error('offline');
    return new Response('{}', { status: 404 });
  });
  const deps = { home, env: { HOME: home }, package: { name: 'khala-cli', version: '1.2.3' }, fetchRegistry,
    npmInstall: vi.fn(() => true), stdout: vi.fn(), stderr: vi.fn() };
  const paths = opencodePaths({ home, env: deps.env, platform: process.platform, path });
  expect(await runInstall(['opencode'], deps)).toBe(0);
  const installed = await fs.readFile(paths.configFile, 'utf8');
  expect(JSON.parse(installed)).toEqual({ mcp: { khala: opencodeMcpEntry(process.platform, paths.bin) } });
  expect(deps.stdout).toHaveBeenCalledWith(expect.stringContaining('MCP-only mode (Async, no wake)'));
  expect(await runInstall(['opencode'], deps)).toBe(0);
  expect(await fs.readFile(paths.configFile, 'utf8')).toBe(installed);
  const overrideDeps = { ...deps, env: { ...deps.env, KHALA_OPENCODE_PLUGIN_SPEC: 'file:/custom.tgz' } };
  fetchRegistry.mockClear();
  expect(await runInstall(['opencode'], overrideDeps)).toBe(0);
  expect(fetchRegistry).not.toHaveBeenCalled();
  expect(JSON.parse(await fs.readFile(paths.configFile, 'utf8'))).toEqual({ plugin: ['file:/custom.tgz'] });
  expect(await runInstall(['opencode'], deps)).toBe(0);
  expect(JSON.parse(await fs.readFile(paths.configFile, 'utf8'))).toEqual(JSON.parse(installed));
  fetchRegistry.mockClear();
  expect(await runInstall(['opencode', '--uninstall'], deps)).toBe(0);
  expect(fetchRegistry).not.toHaveBeenCalled();
  // The config did not exist before install, so uninstall removes it and the directory Khala created.
  await expect(fs.stat(paths.configDir)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('checks the exact version with a short timeout', async () => {
  const timeout = vi.spyOn(AbortSignal, 'timeout');
  const fetchRegistry = vi.fn(async () => new Response('{}'));
  expect(await opencodePluginPublished('1.2.3', fetchRegistry)).toBe(true);
  expect(fetchRegistry).toHaveBeenCalledWith('https://registry.npmjs.org/khala-opencode/1.2.3', { signal: expect.any(AbortSignal) });
  expect(fetchRegistry).toHaveBeenCalledTimes(1);
  expect(timeout).toHaveBeenCalledWith(3000);
  expect(await opencodePluginPublished('1.2.3', vi.fn(async () => { throw new DOMException('timeout', 'TimeoutError'); }))).toBe(false);
});
it('merges a single comment-free JSONC in place', async () => {
  const deps = { home, env: { HOME: home }, package: { name: 'khala-cli', version: '1.2.3' },
    fetchRegistry: vi.fn(async () => new Response('{}')), npmInstall: vi.fn(() => true), stdout: vi.fn(), stderr: vi.fn() };
  const paths = opencodePaths({ home, env: deps.env, platform: process.platform, path });
  await fs.mkdir(paths.configDir, { recursive: true });
  const jsonc = paths.configFile.replace(/\.json$/u, '.jsonc');
  const original = '{"$schema": "https://opencode.ai/config.json"}';
  await fs.writeFile(jsonc, original);
  expect(await runInstall(['opencode'], deps)).toBe(0);
  expect(JSON.parse(await fs.readFile(jsonc, 'utf8'))).toEqual({
    $schema: 'https://opencode.ai/config.json', plugin: ['khala-opencode@1.2.3'],
  });
  const installed = await fs.readFile(jsonc, 'utf8');
  expect(await runInstall(['opencode'], deps)).toBe(0);
  expect(await fs.readFile(jsonc, 'utf8')).toBe(installed);
  expect(await runInstall(['opencode', '--uninstall'], deps)).toBe(0);
  expect(await fs.readFile(jsonc, 'utf8')).toBe(original);
  await expect(fs.stat(paths.configFile)).rejects.toMatchObject({ code: 'ENOENT' });
});
it.each(['plugin', 'mcp', 'uninstall'] as const)('refuses both config files before any mutation in %s mode', async mode => {
  const deps = { home, env: { HOME: home }, package: { name: 'khala-cli', version: '1' },
    fetchRegistry: vi.fn(async () => new Response('{}', { status: mode === 'mcp' ? 404 : 200 })),
    npmInstall: vi.fn(() => true), stdout: vi.fn(), stderr: vi.fn() };
  const paths = opencodePaths({ home, env: deps.env, platform: process.platform, path });
  await fs.mkdir(paths.configDir, { recursive: true });
  const jsonc = paths.configFile.replace(/\.json$/u, '.jsonc');
  const schema = { $schema: 'https://opencode.ai/config.json' };
  const scenarios = [
    { json: { mcp: { khala: { type: 'remote', url: 'https://foreign.example/mcp' } } }, jsonc: schema },
    { json: { plugin: ['sibling@1'] }, jsonc: schema },
    { json: { plugin: ['khala-opencode@0'], mcp: { khala: opencodeMcpEntry(process.platform, paths.bin) } },
      jsonc: { ...schema, plugin: ['file:/old-plugin.tgz'] } },
  ];
  for (const scenario of scenarios) {
    const files = new Map([
      [paths.configFile, JSON.stringify(scenario.json)], [jsonc, JSON.stringify(scenario.jsonc)],
      [paths.configFile + '.khala-plugin', 'file:/old-plugin.tgz\n'],
    ]);
    for (const [file, content] of files) await fs.writeFile(file, content);
    expect(await runInstall(mode === 'uninstall' ? ['opencode', '--uninstall'] : ['opencode'], deps)).toBe(1);
    expect(deps.npmInstall).not.toHaveBeenCalled();
    expect(deps.stderr).toHaveBeenLastCalledWith(expect.stringContaining(`${paths.configFile} and ${jsonc}`));
    expect(deps.stderr).toHaveBeenLastCalledWith(expect.stringContaining(mode === 'uninstall'
      ? 'remove the Khala config manually' : 'merge the Khala config manually'));
    for (const [file, content] of files) expect(await fs.readFile(file, 'utf8')).toBe(content);
    expect((await fs.readdir(paths.configDir)).sort()).toEqual([...files.keys()].map(file => path.basename(file)).sort());
  }
});
it('preserves sibling settings and removes arbitrary plugin overrides in JSONC', async () => {
  const deps = { home, env: { HOME: home, KHALA_OPENCODE_PLUGIN_SPEC: 'file:/custom.tgz' },
    package: { name: 'khala-cli', version: '1' }, npmInstall: vi.fn(() => true), stdout: vi.fn(), stderr: vi.fn() };
  const paths = opencodePaths({ home, env: deps.env, platform: process.platform, path });
  await fs.mkdir(paths.configDir, { recursive: true });
  const jsonc = paths.configFile.replace(/\.json$/u, '.jsonc');
  const original = { model: 'mine', plugin: ['sibling'], mcp: { other: { enabled: true } } };
  await fs.writeFile(jsonc, JSON.stringify(original));
  expect(await runInstall(['opencode'], deps)).toBe(0);
  expect(JSON.parse(await fs.readFile(jsonc, 'utf8'))).toEqual({ ...original, plugin: ['sibling', 'file:/custom.tgz'] });
  expect(await runInstall(['opencode', '--uninstall'], { ...deps, env: { HOME: home } })).toBe(0);
  expect(JSON.parse(await fs.readFile(jsonc, 'utf8'))).toEqual(original);
});
it('installs MCP-only mode into schema-only JSONC and uninstalls cleanly', async () => {
  const deps = { home, env: { HOME: home }, package: { name: 'khala-cli', version: '1' },
    fetchRegistry: vi.fn(async () => new Response('{}', { status: 404 })),
    npmInstall: vi.fn(() => true), stdout: vi.fn(), stderr: vi.fn() };
  const paths = opencodePaths({ home, env: deps.env, platform: process.platform, path });
  await fs.mkdir(paths.configDir, { recursive: true });
  const jsonc = paths.configFile.replace(/\.json$/u, '.jsonc');
  const schema = { $schema: 'https://opencode.ai/config.json' };
  await fs.writeFile(jsonc, JSON.stringify(schema));
  expect(await runInstall(['opencode'], deps)).toBe(0);
  expect(JSON.parse(await fs.readFile(jsonc, 'utf8'))).toEqual({ ...schema, mcp: { khala: opencodeMcpEntry(process.platform, paths.bin) } });
  expect(await runInstall(['opencode', '--uninstall'], deps)).toBe(0);
  expect(JSON.parse(await fs.readFile(jsonc, 'utf8'))).toEqual(schema);
  await expect(fs.stat(paths.configFile)).rejects.toMatchObject({ code: 'ENOENT' });
});
it.each([
  [false, '// comment\n{}'], [true, '// comment\n{}'],
  [false, '/* comment */\n{"$schema":"https://opencode.ai/config.json"}'],
  [false, '{"plugin":[],}'], [false, 'bad'],
] as const)('refuses non-JSON JSONC without modifying either config (JSON exists: %s, content: %s)', async (jsonExists, original) => {
  const deps = { home, env: { HOME: home }, package: { name: 'khala-cli', version: '1' },
    fetchRegistry: vi.fn(async () => new Response('{}')), npmInstall: vi.fn(() => true), stdout: vi.fn(), stderr: vi.fn() };
  const paths = opencodePaths({ home, env: deps.env, platform: process.platform, path });
  await fs.mkdir(paths.configDir, { recursive: true });
  const jsonc = paths.configFile.replace(/\.json$/u, '.jsonc');
  await fs.writeFile(jsonc, original);
  if (jsonExists) await fs.writeFile(paths.configFile, '{}');
  expect(await runInstall(['opencode'], deps)).toBe(1);
  expect(deps.npmInstall).not.toHaveBeenCalled();
  expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining(jsonExists ? `both ${paths.configFile} and ${jsonc} exist` : 'opencode.jsonc exists'));
  expect(await fs.readFile(jsonc, 'utf8')).toBe(original);
  if (jsonExists) expect(await fs.readFile(paths.configFile, 'utf8')).toBe('{}');
  else await expect(fs.stat(paths.configFile)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('removes the last plugin without leaving an empty list', () => {
  expect(mergeOpenCodeConfig({ plugin: ['khala-opencode@1'] }, null)).toEqual({ config: {} });
});

it.each([
  { plugin: null, foreign: { type: 'local', command: ['foreign-server'] } },
  { plugin: null, foreign: { type: 'remote', url: 'https://my.khala.example/mcp' } },
  { plugin: 'khala-opencode@1', foreign: { type: 'local', command: ['foreign-server'] } },
  { plugin: 'khala-opencode@1', foreign: { type: 'remote', url: 'https://my.khala.example/mcp' } },
])('protects foreign mcp.khala: %j', async ({ plugin, foreign }) => {
  const deps = { home, env: { HOME: home }, package: { name: 'khala-cli', version: '1' },
    fetchRegistry: vi.fn(async () => new Response('{}', { status: plugin ? 200 : 404 })),
    npmInstall: vi.fn(() => true), stdout: vi.fn(), stderr: vi.fn() };
  const paths = opencodePaths({ home, env: deps.env, platform: process.platform, path });
  await fs.mkdir(paths.configDir, { recursive: true });
  const original = JSON.stringify({ mcp: { khala: foreign }, model: 'mine' });
  await fs.writeFile(paths.configFile, original);
  const marker = paths.configFile + '.khala-plugin';
  await fs.writeFile(marker, 'file:/old-plugin.tgz\n');
  expect(await runInstall(['opencode'], deps)).toBe(plugin ? 0 : 1);
  if (plugin) {
    expect(JSON.parse(await fs.readFile(paths.configFile, 'utf8'))).toEqual({ mcp: { khala: foreign }, model: 'mine', plugin: [plugin] });
  } else {
    expect(deps.npmInstall).not.toHaveBeenCalled();
    expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('refusing to overwrite'));
    expect(await fs.readFile(paths.configFile, 'utf8')).toBe(original);
    expect(await fs.readFile(marker, 'utf8')).toBe('file:/old-plugin.tgz\n');
    await expect(fs.stat(paths.configFile + '.khala-bak')).rejects.toMatchObject({ code: 'ENOENT' });
  }
});
it('removes the last managed MCP entry and preserves MCP siblings', () => {
  const khala = opencodeMcpEntry('linux', '/bin/khala');
  expect(mergeOpenCodeConfig({ mcp: { khala }, model: 'mine' }, null)).toEqual({ config: { model: 'mine' } });
  const sibling = { command: ['other'] };
  expect(mergeOpenCodeConfig({ mcp: { khala, sibling } }, null)).toEqual({ config: { mcp: { sibling } } });
});
it('explains manual removal when uninstall is blocked by JSONC', async () => {
  const deps = { home, env: { HOME: home }, npmInstall: vi.fn(() => true), stdout: vi.fn(), stderr: vi.fn() };
  const paths = opencodePaths({ home, env: deps.env, platform: process.platform, path });
  await fs.mkdir(paths.configDir, { recursive: true });
  const jsonc = paths.configFile.replace(/\.json$/u, '.jsonc');
  const original = '// comment\n{}';
  await fs.writeFile(jsonc, original);
  expect(await runInstall(['opencode', '--uninstall'], deps)).toBe(1);
  expect(deps.stderr).toHaveBeenCalledWith(expect.stringContaining('remove the Khala config manually'));
  expect(deps.npmInstall).not.toHaveBeenCalled();
  expect(await fs.readFile(jsonc, 'utf8')).toBe(original);
  await expect(fs.stat(paths.configFile)).rejects.toMatchObject({ code: 'ENOENT' });
});
