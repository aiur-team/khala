import fsp from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bytes, plan, snapshot, syntheticHome } from '../setup/fixtures/setup-home.js';
import { parseManifest } from '../setup/manifest.js';
import { executeSetupPlan, setupStatePaths, type ExecutablePlan, type SetupRoots } from '../setup/transaction.js';
import type { SetupEnvironment, SetupProbe } from '../setup/types.js';
import {
  CURSOR_DELIVERY_UNPROVEN, CURSOR_MCP_ENTRY, createCursorSetupAdapter, cursorMcpConfigPath, cursorRemovalOperations,
  khalaLauncherPath, parseCursorVersion,
} from './setup.js';

const CURSOR_BIN = '/opt/cursor/bin/cursor';
// A runtime descriptor sentinel: neither value may ever reach Cursor config.
const DESCRIPTOR_PORT = '48713';
const DESCRIPTOR_TOKEN = 'khala-descriptor-token-sentinel-7f3a';
// User config with unusual formatting and a secret of its own, to prove byte-exact removal.
const ORIGINAL = bytes('{\n    "mcpServers": {"github": {"command": "gh-mcp", "env": {"GITHUB_TOKEN": "user-secret-sentinel"}}},\n  "other": [1,2]\n}');

let root: string;
let roots: SetupRoots;
beforeEach(async () => {
  ({ root, roots } = await syntheticHome());
  const descriptor = path.join(roots.xdgStateHome, 'khala', 'runtime.json');
  await fsp.mkdir(path.dirname(descriptor), { recursive: true });
  await fsp.writeFile(descriptor, JSON.stringify({ port: Number(DESCRIPTOR_PORT), token: DESCRIPTOR_TOKEN }), { mode: 0o600 });
});
afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

function environment(options: Readonly<{ installed?: boolean; versionOutput?: string }> = {}): SetupEnvironment {
  const probe: SetupProbe = {
    resolveExecutable: async name => (options.installed !== false && name === 'cursor' ? CURSOR_BIN : null),
    runVersion: async (executable, args) => {
      expect([executable, args]).toEqual([CURSOR_BIN, ['--version']]);
      return options.versionOutput ?? '1.7.4\n0123456789abcdef0123456789abcdef01234567\nx64\n';
    },
    readFile: async target => {
      try {
        const stat = await fsp.lstat(target);
        if (!stat.isFile()) throw new Error(`not a regular file: ${target}`);
        return new Uint8Array(await fsp.readFile(target));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    listDirectory: async target => fsp.readdir(target).catch(() => null),
  };
  return { ...roots, probe };
}

const configPath = () => cursorMcpConfigPath(roots);
const seed = async (content: Uint8Array) => {
  await fsp.mkdir(path.dirname(configPath()), { recursive: true });
  await fsp.writeFile(configPath(), content, { mode: 0o644 });
};
const readConfig = async () => new Uint8Array(await fsp.readFile(configPath()));
const exists = (target: string) => fsp.lstat(target).then(() => true, () => false);

async function observe(env = environment()) {
  const adapter = createCursorSetupAdapter();
  const detection = await adapter.detect(env);
  const observation = await adapter.inspect(env, detection);
  return { adapter, detection, observation };
}

async function setupPlan(): Promise<ExecutablePlan> {
  const { adapter, observation } = await observe();
  return plan('setup', adapter.plan({ desired: 'present', observation }), [...adapter.contents().values()]);
}

const execute = (current: ExecutablePlan, confirmedDigest = current.planDigest) => executeSetupPlan({
  roots, searchPath: '/usr/bin:/bin', confirmedDigest, replan: async () => current,
});

const manifest = async () => parseManifest(new Uint8Array(await fsp.readFile(setupStatePaths(roots).manifest)));

describe('Cursor setup adapter', () => {
  it('reports an absent Cursor without reading or creating its config root', async () => {
    const before = await snapshot(root);
    const { detection, observation, adapter } = await observe(environment({ installed: false }));
    expect(detection).toEqual({ executable: null, version: null, supported: false });
    expect(observation).toMatchObject({ components: [{ component: 'mcp_entry', state: 'absent' }], route: 'unknown', diagnostics: [] });
    expect(adapter.plan({ desired: 'present', observation })).toEqual([]);
    expect(await snapshot(root)).toEqual(before);
    expect(await exists(path.join(roots.home, '.cursor'))).toBe(false);
  });

  it('says plainly that delivery is unproven and plans only the MCP entry', async () => {
    await seed(ORIGINAL);
    const { detection, observation, adapter } = await observe();
    expect(detection).toEqual({ executable: CURSOR_BIN, version: '1.7.4', supported: true });
    expect(observation.route).toBe('unknown');
    expect(observation.components).toEqual([{ component: 'mcp_entry', state: 'absent' }]);
    expect(observation.diagnostics).toEqual([
      { code: 'cursor_delivery_unproven', severity: 'warning', harness: 'cursor', message: CURSOR_DELIVERY_UNPROVEN },
    ]);
    const operations = adapter.plan({ desired: 'present', observation });
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({
      type: 'config_entry_set', harness: 'cursor', component: 'mcp_entry', path: configPath(), entry: CURSOR_MCP_ENTRY,
    });
    // Plans are repeatable and nothing about hooks is ever proposed.
    expect(adapter.plan({ desired: 'present', observation })).toEqual(operations);
    expect(operations.some(operation => operation.component === 'hooks')).toBe(false);
  });

  it('writes Cursor config only after the confirmed plan, and remove restores the exact bytes', async () => {
    await seed(ORIGINAL);
    const before = await snapshot(root, { exclude: [path.join(roots.xdgStateHome, 'khala', 'setup')] });

    // Inspecting and planning write nothing; an unconfirmed digest applies nothing.
    const confirmed = await setupPlan();
    expect(await snapshot(root, { exclude: [path.join(roots.xdgStateHome, 'khala', 'setup')] })).toEqual(before);
    const stale = await execute(confirmed, `sha256:${'0'.repeat(64)}`);
    expect(stale.kind).toBe('replanned');
    expect(await readConfig()).toEqual(ORIGINAL);

    expect((await execute(confirmed)).kind).toBe('committed');
    const installed = new TextDecoder().decode(await readConfig());
    const parsed = JSON.parse(installed);
    expect(parsed.mcpServers.khala).toEqual({ command: khalaLauncherPath(roots), args: ['mcp-serve'] });
    expect(parsed.mcpServers.github).toEqual({ command: 'gh-mcp', env: { GITHUB_TOKEN: 'user-secret-sentinel' } });
    expect(parsed.other).toEqual([1, 2]);
    // The entry reads the descriptor at runtime; its port and token never enter config or argv.
    expect(installed).not.toContain(DESCRIPTOR_PORT);
    expect(installed).not.toContain(DESCRIPTOR_TOKEN);

    // Status after setup: ready, still unproven, and a second setup plans nothing.
    const after = await observe();
    expect(after.observation.components).toEqual([{ component: 'mcp_entry', state: 'ready' }]);
    expect(after.observation.diagnostics.map(item => item.code)).toEqual(['cursor_delivery_unproven']);
    expect(after.adapter.plan({ desired: 'present', observation: after.observation })).toEqual([]);

    const removal = plan('remove', cursorRemovalOperations(await manifest()));
    expect(removal.operations).toMatchObject([{ type: 'file_restore', harness: 'cursor', path: configPath() }]);
    expect((await execute(removal)).kind).toBe('committed');
    expect(await readConfig()).toEqual(ORIGINAL);
    expect((await fsp.stat(configPath())).mode & 0o777).toBe(0o644);
    expect((await observe()).observation.components).toEqual([{ component: 'mcp_entry', state: 'absent' }]);
  });

  it('removes a config it created, along with the directory it created', async () => {
    expect((await execute(await setupPlan())).kind).toBe('committed');
    expect(await exists(configPath())).toBe(true);
    const removal = plan('remove', cursorRemovalOperations(await manifest()));
    expect(removal.operations).toMatchObject([{ type: 'file_delete', path: configPath() }]);
    expect((await execute(removal)).kind).toBe('committed');
    expect(await exists(path.join(roots.home, '.cursor'))).toBe(false);
  });

  it('refuses to touch a foreign khala entry or a config it cannot parse', async () => {
    for (const content of [
      bytes('{"mcpServers":{"khala":{"command":"somebody-else"}}}'),
      bytes('{"mcpServers": [] }'),
      bytes('// comments are not JSON\n{}'),
      bytes('[]'),
    ]) {
      await seed(content);
      const { observation, adapter } = await observe();
      expect(observation.components).toEqual([{ component: 'mcp_entry', state: 'conflict' }]);
      expect(observation.diagnostics.map(item => item.severity)).toEqual(['warning', 'error']);
      expect(adapter.plan({ desired: 'present', observation })).toEqual([]);
      expect(await readConfig()).toEqual(content);
    }
  });

  it('fails closed on a version it cannot read', async () => {
    await seed(ORIGINAL);
    for (const versionOutput of ['', 'Cursor\n', '1.7\n', `1.7.4${'-x'.repeat(40)}\n`]) {
      const { detection, observation, adapter } = await observe(environment({ versionOutput }));
      expect(detection).toMatchObject({ executable: CURSOR_BIN, version: null, supported: false });
      expect(observation.components).toEqual([{ component: 'mcp_entry', state: 'unsupported' }]);
      expect(adapter.plan({ desired: 'present', observation })).toEqual([]);
    }
  });

  it('plans only from its own observation, and leaves removal to the manifest', async () => {
    const { adapter, observation } = await observe();
    expect(() => adapter.plan({ desired: 'present', observation: { ...observation } })).toThrow(/observation from this adapter/);
    expect(adapter.plan({ desired: 'absent', observation })).toEqual([]);
    expect(cursorRemovalOperations(null)).toEqual([]);
  });
});

describe('parseCursorVersion', () => {
  it('reads the exact version from the first line only', () => {
    expect(parseCursorVersion('1.7.4\nabc\nx64')).toBe('1.7.4');
    expect(parseCursorVersion('2.0.0-nightly.3\r\n')).toBe('2.0.0-nightly.3');
    expect(parseCursorVersion('x64\n1.7.4')).toBeNull();
    expect(parseCursorVersion('Cursor 1.7.4')).toBeNull();
  });
});
