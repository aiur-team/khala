import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256 } from '../filesystem.js';
import { snapshot, syntheticHome, type Snapshot } from '../fixtures/setup-home.js';
import { executeSetupPlan, setupStatePaths, type ExecutablePlan, type SetupRoots } from '../transaction.js';
import type { HarnessObservation, SetupEnvironment, SetupOperation, SetupProbe } from '../types.js';
import {
  CLAUDE_PLUGIN_ID, ClaudeSetupAdapter, ClaudeSetupRefusal, claudePaths, parseClaudeVersion, readClaudePluginAssets,
} from './claude.js';

const PLUGIN_PACKAGE = fileURLToPath(new URL('../../../../claude-plugin/', import.meta.url));
const SUPPORTED = '2.1.283 (Claude Code)';
const SENTINEL_PORT = '48713';
const SENTINEL_TOKEN = 'SENTINELtokenSENTINELtokenSENTINELtoken0123';

let root: string;
let roots: SetupRoots;
let binDirectory: string;
let assets: Map<string, Uint8Array>;

/** A read-only probe over the synthetic home: no-follow reads, a fake PATH, and a canned version. */
function probe(versionOutput: string | Error = SUPPORTED): SetupProbe {
  return {
    async resolveExecutable(name) {
      const candidate = path.join(binDirectory, name);
      return (await fsp.lstat(candidate).then(() => true, () => false)) ? candidate : null;
    },
    async runVersion() {
      if (versionOutput instanceof Error) throw versionOutput;
      return versionOutput;
    },
    async readFile(target) {
      const stat = await fsp.lstat(target).catch(() => null);
      if (stat === null) return null;
      if (!stat.isFile()) throw new Error(`not a regular file: ${target}`);
      return new Uint8Array(await fsp.readFile(target));
    },
    async listDirectory(target) {
      const stat = await fsp.lstat(target).catch(() => null);
      if (stat === null || !stat.isDirectory()) return null;
      return (await fsp.readdir(target)).sort();
    },
  };
}

const environment = (versionOutput?: string | Error): SetupEnvironment => ({ ...roots, probe: probe(versionOutput) });
const adapter = (version = '1.0.0', cwd?: string) => new ClaudeSetupAdapter({ version, assets, ...(cwd === undefined ? {} : { cwd }) });
const paths = (version = '1.0.0') => claudePaths(roots, version);
const installClaude = async () => {
  await fsp.writeFile(path.join(binDirectory, 'claude'), '#!/bin/sh\n', { mode: 0o755 });
};
const write = async (target: string, contents: string, mode = 0o644) => {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, contents, { mode });
};
const read = async (target: string) => new TextDecoder().decode(await fsp.readFile(target));
const exists = (target: string) => fsp.lstat(target).then(() => true, () => false);

async function observe(instance = adapter(), versionOutput?: string | Error): Promise<HarnessObservation> {
  const env = environment(versionOutput);
  return instance.inspect(env, await instance.detect(env));
}

/** Plans with the adapter, then applies through the real transaction executor. */
async function apply(instance: ClaudeSetupAdapter, desired: 'present' | 'absent') {
  const observation = await observe(instance);
  const planned = instance.planWithContents({ desired, observation });
  const executable: ExecutablePlan = {
    command: desired === 'present' ? 'setup' : 'remove',
    planDigest: sha256(new TextEncoder().encode(JSON.stringify(planned.operations))),
    operations: planned.operations,
    contents: planned.contents,
  };
  const outcome = await executeSetupPlan({
    roots, searchPath: binDirectory, confirmedDigest: executable.planDigest, replan: async () => executable,
  });
  expect(outcome.kind).toBe('committed');
  return planned.operations;
}

/** Everything under the synthetic root except Khala state (executor state, descriptor) and the fake PATH. */
const userState = () => snapshot(root, { exclude: [path.join(roots.xdgStateHome, 'khala'), binDirectory] });

/** Every path that changed, appeared, or disappeared between two snapshots, ignoring directories. */
function changedFiles(before: Snapshot, after: Snapshot): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter(key => before[key] !== after[key] && !(before[key] ?? after[key])!.startsWith('dir ')).sort();
}

const planPaths = (operations: readonly SetupOperation[]) => new Set(operations.map(operation => operation.path));

async function allBytes(directory: string): Promise<string> {
  const files = await snapshot(directory);
  const parts: string[] = [];
  for (const [target, kind] of Object.entries(files)) if (kind.startsWith('file ')) parts.push(await read(target));
  return parts.join('\n');
}

beforeEach(async () => {
  ({ root, roots } = await syntheticHome());
  binDirectory = path.join(root, 'bin');
  await fsp.mkdir(binDirectory);
  assets = await readClaudePluginAssets(PLUGIN_PACKAGE);
});
afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

describe('claude setup adapter: detection', () => {
  it('parses the version banner and fails closed on anything else', () => {
    expect(parseClaudeVersion('2.1.283 (Claude Code)\n')).toBe('2.1.283');
    expect(parseClaudeVersion('Claude Code')).toBeNull();
    expect(parseClaudeVersion('2.1.283-beta (Claude Code)')).toBeNull();
  });

  it('reports absent Claude without planning anything or creating ~/.claude', async () => {
    const before = await userState();
    const instance = adapter();
    const observation = await observe(instance);
    expect(observation.detection).toEqual({ executable: null, version: null, supported: false });
    expect(observation.components.map(item => item.state)).toEqual(['absent', 'absent']);
    expect(observation.route).toBe('unavailable');
    expect(instance.plan({ desired: 'present', observation })).toEqual([]);
    expect(await exists(paths().claudeDirectory)).toBe(false);
    expect(await userState()).toEqual(before);
  });

  it.each([['2.1.282 (Claude Code)'], ['9.9.9 (Claude Code)'], ['garbled'], [new Error('exit 1')]])(
    'fails closed on an uncertified version (%s)', async versionOutput => {
      await installClaude();
      const instance = adapter();
      const observation = await observe(instance, versionOutput);
      expect(observation.detection.supported).toBe(false);
      expect(observation.components.map(item => item.state)).toEqual(['unsupported', 'unsupported']);
      expect(() => instance.plan({ desired: 'present', observation })).toThrow(ClaudeSetupRefusal);
    });
});

describe('claude setup adapter: footprint', () => {
  it('installs exactly one user-scope plugin in a clean home, touching only planned paths, then removes exactly', async () => {
    await installClaude();
    const before = await userState();
    const operations = await apply(adapter(), 'present');

    const after = await userState();
    // Every changed path is planned, and every planned path changed.
    expect(changedFiles(before, after)).toEqual([...planPaths(operations)].sort());
    const foreign = operations.filter(operation => !operation.path.startsWith(path.join(roots.xdgDataHome, 'khala') + path.sep));
    expect(foreign.map(operation => operation.path)).toEqual([paths().settings]);

    const settings = JSON.parse(await read(paths().settings));
    expect(settings).toEqual({
      extraKnownMarketplaces: { khala: { source: { source: 'directory', path: paths().marketplaceRoot } } },
      enabledPlugins: { [CLAUDE_PLUGIN_ID]: true },
    });
    // One plugin: one catalog entry, one enabled Khala plugin.
    const catalog = JSON.parse(await read(paths().catalog));
    expect(catalog.plugins).toEqual([{ name: 'khala', source: './plugins/khala' }]);
    expect(await read(path.join(paths().pluginRoot, '.claude-plugin', 'plugin.json')))
      .toBe(await read(path.join(PLUGIN_PACKAGE, '.claude-plugin', 'plugin.json')));

    const ready = await observe();
    expect(ready.components.map(item => item.state)).toEqual(['ready', 'ready']);
    // Configuration never claims a delivery route on its own.
    expect(ready.route).toBe('unknown');

    // Idempotent: nothing more to do.
    const again = adapter();
    expect(again.plan({ desired: 'present', observation: await observe(again) })).toEqual([]);

    await apply(adapter(), 'absent');
    expect(await userState()).toEqual(before);
    expect(await exists(paths().claudeDirectory)).toBe(false);
  });

  it('preserves a populated home and restores its settings byte-for-byte on removal', async () => {
    await installClaude();
    // Unusual formatting, a sentinel secret, and another enabled plugin.
    const original = '{"env":{"API_KEY":"sentinel-secret-9f2c"},\n   "enabledPlugins": {"other@market": true}, "theme":"dark"}';
    await write(paths().settings, original, 0o600);
    await write(path.join(paths().claudeDirectory, 'commands', 'deploy.md'), 'deploy\n');
    const before = await userState();

    const operations = await apply(adapter(), 'present');
    expect(changedFiles(before, await userState())).toEqual([...planPaths(operations)].sort());
    const settings = JSON.parse(await read(paths().settings));
    expect(settings.env).toEqual({ API_KEY: 'sentinel-secret-9f2c' });
    expect(settings.theme).toBe('dark');
    expect(settings.enabledPlugins).toEqual({ 'other@market': true, [CLAUDE_PLUGIN_ID]: true });
    expect((await fsp.stat(paths().settings)).mode & 0o777).toBe(0o600);
    // The plan carries hashes only, never foreign contents.
    expect(JSON.stringify(operations)).not.toContain('sentinel-secret');

    await apply(adapter(), 'absent');
    expect(await read(paths().settings)).toBe(original);
    expect(await userState()).toEqual(before);
  });

  it('upgrades to a new payload version and removal still restores the pre-Khala bytes', async () => {
    await installClaude();
    const original = '{ "model": "opus" }\n';
    await write(paths().settings, original);
    const before = await userState();
    await apply(adapter('1.0.0'), 'present');
    const upgrade = await apply(adapter('2.0.0'), 'present');
    expect(upgrade.find(operation => operation.path === paths().settings)?.type).toBe('config_entry_set');
    expect(JSON.parse(await read(paths().settings)).extraKnownMarketplaces.khala.source.path).toBe(paths('2.0.0').marketplaceRoot);
    expect((await observe(adapter('2.0.0'))).components.map(item => item.state)).toEqual(['ready', 'ready']);

    await apply(adapter('2.0.0'), 'absent');
    expect(await read(paths().settings)).toBe(original);
    expect(await userState()).toEqual(before);
  });

  it('writes no runtime port or token anywhere: installed entries read the descriptor at call time', async () => {
    await installClaude();
    const descriptor = path.join(roots.xdgStateHome, 'khala', 'runtime', 'active.json');
    await write(descriptor, JSON.stringify({ port: Number(SENTINEL_PORT), token: SENTINEL_TOKEN }), 0o600);
    const instance = adapter();
    const observation = await observe(instance);
    const planned = instance.planWithContents({ desired: 'present', observation });
    const planText = JSON.stringify(planned.operations) + [...planned.contents.values()].map(bytes => new TextDecoder().decode(bytes)).join('\n');
    await apply(instance, 'present');
    const installed = await allBytes(paths().claudeDirectory) + await allBytes(path.join(roots.xdgDataHome, 'khala'));
    for (const text of [planText, installed]) {
      expect(text).not.toContain(SENTINEL_TOKEN);
      expect(text).not.toContain(SENTINEL_PORT);
    }
    const mcp = JSON.parse(await read(path.join(paths().pluginRoot, '.mcp.json')));
    // The frozen entry (#316, amended by #333 with the harness marker) carries no port or token.
    expect(mcp.mcpServers.khala).toEqual({ command: 'khala', args: ['mcp-serve'], env: { KHALA_MCP_HARNESS: 'claude' } });
  });
});

describe('claude setup adapter: optional hardening', () => {
  it('reports a hardened home as present, and setup leaves the sandbox setting as it was', async () => {
    await installClaude();
    await write(paths().settings, '{"sandbox":{"enabled":true}}\n');
    const instance = adapter();
    const observation = await observe(instance);
    expect(instance.hardening(observation)).toBe('present');
    await apply(instance, 'present');
    const ready = await observe();
    expect(ready.components.map(item => item.state)).toEqual(['ready', 'ready']);
    expect(ready.diagnostics.map(item => item.code)).toContain('claude_hardening_present');
    expect(JSON.parse(await read(paths().settings)).sandbox).toEqual({ enabled: true });
  });

  // Wrong-implementation killer: absent optional hardening must not gate readiness, and setup
  // must not install a profile. A gating adapter, or one that writes a sandbox, permissions,
  // or profile entry, fails here.
  it('stays ready with hardening absent and writes no hardening profile', async () => {
    await installClaude();
    const original = '{"permissions":{"allow":["Bash(ls)"]}}\n';
    await write(paths().settings, original);
    const before = await userState();
    const instance = adapter();
    expect(instance.hardening(await observe(instance))).toBe('absent');

    const operations = await apply(instance, 'present');
    const ready = await observe();
    expect(ready.components.map(item => item.state)).toEqual(['ready', 'ready']);
    expect(ready.diagnostics.filter(item => item.severity === 'error')).toEqual([]);
    expect(ready.diagnostics.map(item => item.code)).toContain('claude_hardening_absent');

    // Setup's only foreign write adds exactly the two registration keys.
    const settings = JSON.parse(await read(paths().settings));
    expect(Object.keys(settings).sort()).toEqual(['enabledPlugins', 'extraKnownMarketplaces', 'permissions']);
    expect(settings.permissions).toEqual({ allow: ['Bash(ls)'] });
    expect(settings.sandbox).toBeUndefined();
    const changed = changedFiles(before, await userState());
    expect(changed).toEqual([...planPaths(operations)].sort());
    expect(changed.filter(target => !target.startsWith(path.join(roots.xdgDataHome, 'khala') + path.sep))).toEqual([paths().settings]);
  });

  it('reports folder trust separately without gating readiness', async () => {
    await installClaude();
    const project = path.join(root, 'project');
    await write(path.join(roots.home, '.claude.json'), JSON.stringify({ projects: { [project]: { hasTrustDialogAccepted: true } } }));
    await apply(adapter('1.0.0', project), 'present');
    const trusted = await observe(adapter('1.0.0', project));
    expect(trusted.diagnostics.map(item => item.code)).toContain('claude_folder_trusted');
    const untrusted = await observe(adapter('1.0.0', path.join(root, 'elsewhere')));
    expect(untrusted.diagnostics.map(item => item.code)).toContain('claude_folder_trust_unknown');
    expect(untrusted.components.map(item => item.state)).toEqual(['ready', 'ready']);
  });
});

describe('claude setup adapter: conflicts', () => {
  const refusal = async (instance = adapter()) => {
    const observation = await observe(instance);
    try {
      instance.plan({ desired: 'present', observation });
    } catch (error) {
      if (error instanceof ClaudeSetupRefusal) return { observation, error };
      throw error;
    }
    throw new Error('expected a refusal');
  };

  it.each([
    ['a user /khala command', async () => write(path.join(paths().claudeDirectory, 'commands', 'khala.md'), 'mine\n')],
    ['a user /khala: command namespace', async () => write(path.join(paths().claudeDirectory, 'commands', 'khala', 'send.md'), 'mine\n')],
    ['a legacy user khala skill', async () => write(path.join(paths().claudeDirectory, 'skills', 'khala', 'SKILL.md'), 'mine\n')],
    ['another enabled khala plugin', async () => write(paths().settings, JSON.stringify({ enabledPlugins: { 'khala@elsewhere': true } }))],
    ['an enabled plugin that ships a khala command', async () => {
      const installPath = path.join(paths().claudeDirectory, 'plugins', 'cache', 'm', 'tools', '1.0.0');
      await write(path.join(installPath, 'commands', 'khala.md'), 'theirs\n');
      await write(paths().installedPlugins, JSON.stringify({ version: 2, plugins: { 'tools@m': [{ scope: 'user', installPath }] } }));
      await write(paths().settings, JSON.stringify({ enabledPlugins: { 'tools@m': true } }));
    }],
  ])('detects %s as a /khala collision and fails the plan without writing', async (_name, seed) => {
    await installClaude();
    await seed();
    const before = await userState();
    const { observation, error } = await refusal();
    expect(error.state).toBe('conflict');
    expect(observation.components.find(item => item.component === 'plugin')?.state).toBe('conflict');
    expect(error.diagnostics.map(item => item.code)).toContain('claude_command_collision');
    expect(await userState()).toEqual(before);
  });

  it('ignores a disabled plugin that ships a khala command', async () => {
    await installClaude();
    const installPath = path.join(paths().claudeDirectory, 'plugins', 'cache', 'm', 'tools', '1.0.0');
    await write(path.join(installPath, 'commands', 'khala.md'), 'theirs\n');
    await write(paths().installedPlugins, JSON.stringify({ version: 2, plugins: { 'tools@m': [{ scope: 'user', installPath }] } }));
    await write(paths().settings, JSON.stringify({ enabledPlugins: { 'tools@m': false } }));
    expect((await observe()).components.map(item => item.state)).toEqual(['absent', 'absent']);
  });

  it('treats an unowned Khala entry as a conflict even when identical', async () => {
    await installClaude();
    await write(paths().settings, JSON.stringify({
      extraKnownMarketplaces: { khala: { source: { source: 'directory', path: paths().marketplaceRoot } } },
      enabledPlugins: { [CLAUDE_PLUGIN_ID]: true },
    }));
    const { error } = await refusal();
    expect(error.state).toBe('conflict');
    expect(error.diagnostics.map(item => item.code)).toContain('claude_unowned_entry');
  });

  it.each([['not JSON', '{"theme": '], ['a JSON array', '[]'], ['a non-object enabledPlugins', '{"enabledPlugins": []}']])(
    'refuses to edit settings that are %s', async (_name, contents) => {
      await installClaude();
      await write(paths().settings, contents);
      const { error } = await refusal();
      expect(error.state).toBe('conflict');
      expect(error.diagnostics.map(item => item.code)).toContain('claude_settings_unusable');
    });

  it('reports drift after setup and refuses removal, preserving the user edit', async () => {
    await installClaude();
    await apply(adapter(), 'present');
    const edited = (await read(paths().settings)).replace('{', '{"theme":"light",');
    await fsp.writeFile(paths().settings, edited);
    const instance = adapter();
    const observation = await observe(instance);
    expect(observation.components.map(item => item.state)).toEqual(['drifted', 'drifted']);
    expect(() => instance.plan({ desired: 'present', observation })).toThrow(ClaudeSetupRefusal);
    expect(() => instance.plan({ desired: 'absent', observation })).toThrow(ClaudeSetupRefusal);
    expect(await read(paths().settings)).toBe(edited);
    expect(await exists(setupStatePaths(roots).manifest)).toBe(true);
  });
});
