import fsp from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decodeSetupResult, type SetupEnvironment, type SetupProbe } from '../types.js';
import { sha256 } from '../filesystem.js';
import { executeSetupPlan, type ExecutablePlan, type SetupRoots } from '../transaction.js';
import { bytes, snapshot, syntheticHome } from '../fixtures/setup-home.js';
import {
  OPENCODE_CONFIG_ENTRY, OPENCODE_SKILL, OPENCODE_STANDING_INSTRUCTION, createOpenCodeAdapter, editOpenCodeConfig,
  openCodeMcpEntry, openCodePaths, parseOpenCodeVersion,
} from './opencode.js';

const SENTINEL_SECRET = 'sk-SENTINEL-opencode-7f3a9c';
const SENTINEL_PORT = '48713';
const SENTINEL_TOKEN = 'khala-descriptor-token-SENTINEL';

// Unusual formatting a parse-and-reserialize would destroy: CRLF, tabs, comments,
// trailing commas, a one-line array, and a sentinel secret in an unrelated MCP entry.
const POPULATED = [
  '// my OpenCode config',
  '{',
  '\t"$schema": "https://opencode.ai/config.json",',
  '\t/* keep this model */ "model":   "deepseek/deepseek-flash",',
  '\t"plugin": ["opencode-wakatime"],',
  '\t"mcp": {',
  '\t\t"github": {"type": "remote", "url": "https://example.test/mcp",',
  `\t\t\t"headers": {"Authorization": "Bearer ${SENTINEL_SECRET}"}},`,
  '\t},',
  '\t"permission": { "bash": "ask", }, // trailing comma kept',
  '}',
  '',
].join('\r\n');

let root: string;
let roots: SetupRoots;
let versionOutput: string;
let installed: boolean;

beforeEach(async () => {
  ({ root, roots } = await syntheticHome());
  versionOutput = '1.17.10\n';
  installed = true;
});
afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

const binary = () => path.join(root, 'bin', 'opencode');
const probe = (): SetupProbe => ({
  resolveExecutable: async name => (installed && name === 'opencode' ? binary() : null),
  runVersion: async (executable, args) => {
    expect([executable, args]).toEqual([binary(), ['--version']]);
    return versionOutput;
  },
  readFile: async target => {
    try {
      return new Uint8Array(await fsp.readFile(target));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  },
  listDirectory: async target => fsp.readdir(target).catch(() => null),
});
const environment = (): SetupEnvironment => ({ ...roots, probe: probe() });
const paths = () => openCodePaths(roots);
const text = async (target: string) => new TextDecoder().decode(await fsp.readFile(target));
const exists = (target: string) => fsp.lstat(target).then(() => true, () => false);

const adapter = createOpenCodeAdapter();
async function observe() {
  const env = environment();
  const detection = await adapter.detect(env);
  return adapter.inspect(env, detection);
}
async function planFor(desired: 'present' | 'absent'): Promise<ExecutablePlan> {
  const observation = await observe();
  const request = { desired, observation } as const;
  const operations = adapter.plan(request);
  return {
    command: desired === 'present' ? 'setup' : 'remove',
    planDigest: sha256(bytes(JSON.stringify({ desired, operations }))),
    operations,
    contents: adapter.contents(request),
    ...(observation.detection.executable !== null && !observation.detection.supported ? { unsupportedHarnesses: ['opencode'] as const } : {}),
  };
}
async function run(desired: 'present' | 'absent') {
  const plan = await planFor(desired);
  return executeSetupPlan({
    roots, searchPath: '/usr/bin:/bin', confirmedDigest: plan.planDigest, replan: async () => plan,
  });
}
const seed = async (target: string, contents: string, mode = 0o644) => {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, contents);
  await fsp.chmod(target, mode);
};
/** Drops comments (outside strings) and trailing commas, as a naive JSONC reader would. */
function stripJsonc(source: string): string {
  let result = '';
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index]!;
    if (char === '"') {
      const end = source.indexOf('"', index + 1);
      result += source.slice(index, end + 1);
      index = end;
    } else if (source.startsWith('//', index)) index = source.indexOf('\n', index) - 1;
    else if (source.startsWith('/*', index)) index = source.indexOf('*/', index) + 1;
    else result += char;
  }
  return result.replace(/,(\s*[}\]])/g, '$1');
}
const states = (observation: Awaited<ReturnType<typeof observe>>) =>
  Object.fromEntries(observation.components.map(component => [component.component, component.state]));

describe('OpenCode detection', () => {
  it('detects the exact tested version and nothing looser', async () => {
    expect(await adapter.detect(environment())).toEqual({ executable: binary(), version: '1.17.10', supported: true });
    versionOutput = '1.17.11\n';
    expect(await adapter.detect(environment())).toEqual({ executable: binary(), version: '1.17.11', supported: false });
    versionOutput = 'opencode 1.17.10 (nightly)';
    expect(await adapter.detect(environment())).toEqual({ executable: binary(), version: null, supported: false });
    installed = false;
    expect(await adapter.detect(environment())).toEqual({ executable: null, version: null, supported: false });
  });

  it('parses only a bare version string', () => {
    expect(parseOpenCodeVersion(' v1.17.10\n')).toBe('1.17.10');
    expect(parseOpenCodeVersion('1.17')).toBeNull();
    expect(parseOpenCodeVersion('1.17.10\nextra')).toBeNull();
  });
});

describe('OpenCode setup', () => {
  it('reports absent OpenCode and creates nothing', async () => {
    installed = false;
    const before = await snapshot(root, { mtimes: true });
    const observation = await observe();
    expect(states(observation)).toEqual({ plugin: 'absent', skill: 'absent', mcp_entry: 'absent' });
    expect(observation.route).toBe('unavailable');
    expect(adapter.plan({ desired: 'present', observation })).toEqual([]);
    expect(await exists(paths().root)).toBe(false);
    expect(await snapshot(root, { mtimes: true })).toEqual(before);
  });

  it('configures the plugin, skill, MCP entry, and standing instruction in a clean home', async () => {
    const plan = await planFor('present');
    expect(plan.operations.map(operation => [operation.type, operation.component, operation.path])).toEqual([
      ['file_create', 'skill', paths().skill],
      ['file_create', 'skill', paths().standingInstruction],
      ['config_entry_set', 'plugin', paths().defaultConfig],
    ]);
    expect(plan.operations[2]).toMatchObject({ entry: OPENCODE_CONFIG_ENTRY, preimage: null });
    expect((await run('present')).kind).toBe('committed');

    const config = JSON.parse(await text(paths().defaultConfig)) as Record<string, unknown>;
    expect(config).toEqual({
      plugin: ['@aiur/khala/opencode'],
      mcp: { khala: { type: 'local', command: [paths().launcher, 'mcp-serve'], enabled: true } },
      instructions: [paths().standingInstruction],
    });
    expect(await text(paths().skill)).toBe(OPENCODE_SKILL);
    expect(await text(paths().standingInstruction)).toBe(OPENCODE_STANDING_INSTRUCTION);
    expect(OPENCODE_STANDING_INSTRUCTION).toContain('khala_send');

    const ready = await observe();
    expect(states(ready)).toEqual({ plugin: 'ready', skill: 'ready', mcp_entry: 'ready' });
    expect(ready.route).toBe('opencode_plugin');
    // Second setup is a no-op: zero operations, no byte or mtime change.
    const before = await snapshot(root, { mtimes: true });
    expect(adapter.plan({ desired: 'present', observation: ready })).toEqual([]);
    expect(await snapshot(root, { mtimes: true })).toEqual(before);
  });

  it('reports per-route support from the recorded evidence keys', async () => {
    const observation = await observe();
    expect(observation.modes).toMatchObject({
      steer: { status: 'proven', route: 'opencode-plugin-steer', testedVersion: '1.17.10' },
      sync: { status: 'proven', route: 'opencode-plugin-sync', testedVersion: '1.17.10' },
      async: { status: 'proven', route: 'opencode-plugin-async', testedVersion: '1.17.10' },
    });
    expect(observation.diagnostics.filter(d => d.code.startsWith('opencode_route_')).map(d => d.code))
      .toEqual(['opencode_route_steer', 'opencode_route_sync', 'opencode_route_async']);
    // Not yet configured: the running session needs a restart, so the CLI is the route for now.
    expect(observation.diagnostics.map(d => d.code)).toContain('opencode_restart_required');
    expect(observation.route).toBe('unknown');
  });

  it('never embeds the runtime port or token; the entry resolves the descriptor at run time', async () => {
    // The live descriptor exists during setup, yet no byte of it reaches config, plan, or output.
    await seed(path.join(roots.xdgStateHome, 'khala', 'runtime.json'), JSON.stringify({ port: SENTINEL_PORT, token: SENTINEL_TOKEN }), 0o600);
    const observation = await observe();
    const plan = await planFor('present');
    await run('present');
    const written = await Promise.all([paths().defaultConfig, paths().skill, paths().standingInstruction].map(text));
    const output = JSON.stringify({ observation, operations: plan.operations });
    for (const surface of [...written, output]) {
      expect(surface).not.toContain(SENTINEL_PORT);
      expect(surface).not.toContain(SENTINEL_TOKEN);
    }
    expect(openCodeMcpEntry(paths().launcher)).toEqual({ type: 'local', command: [paths().launcher, 'mcp-serve'], enabled: true });
  });

  it('is decodable as a setup result harness report', async () => {
    await run('present');
    const observation = await observe();
    expect(() => decodeSetupResult({
      v: 1, command: 'status', ok: true, changed: false, state: 'ready', planDigest: null,
      confirmation: { required: false, confirmed: false }, operations: [], diagnostics: observation.diagnostics,
      harnesses: [{
        harness: 'opencode', executable: { present: true, path: observation.detection.executable },
        version: { detected: observation.detection.version, supported: true }, components: observation.components, route: observation.route,
      }],
    })).not.toThrow();
  });
});

describe('OpenCode byte-exact config edits', () => {
  it('inserts into an unusually formatted config and removal returns every byte', async () => {
    const target = path.join(paths().root, 'opencode.jsonc');
    await seed(target, POPULATED, 0o640);
    const before = await snapshot(root, { exclude: [path.join(roots.xdgStateHome, 'khala')] });

    const plan = await planFor('present');
    expect(plan.operations.find(operation => operation.type === 'config_entry_set')).toMatchObject({
      path: target, preimage: sha256(bytes(POPULATED)),
    });
    // The secret lives only in the file; no plan, observation, or operation carries it.
    expect(JSON.stringify({ plan: plan.operations, observation: await observe() })).not.toContain(SENTINEL_SECRET);
    expect((await run('present')).kind).toBe('committed');

    // Insert-only: the user's bytes, CRLF, tabs, comments, and trailing commas all survive.
    expect(await text(target)).toBe([
      '// my OpenCode config',
      '{',
      '\t"$schema": "https://opencode.ai/config.json",',
      '\t/* keep this model */ "model":   "deepseek/deepseek-flash",',
      '\t"plugin": ["opencode-wakatime", "@aiur/khala/opencode"],',
      '\t"mcp": {',
      '\t\t"github": {"type": "remote", "url": "https://example.test/mcp",',
      `\t\t\t"headers": {"Authorization": "Bearer ${SENTINEL_SECRET}"}},`,
      '\t\t"khala": {',
      '\t\t\t"type": "local",',
      '\t\t\t"command": [',
      `\t\t\t\t${JSON.stringify(paths().launcher)},`,
      '\t\t\t\t"mcp-serve"',
      '\t\t\t],',
      '\t\t\t"enabled": true',
      '\t\t},',
      '\t},',
      '\t"permission": { "bash": "ask", },',
      '\t"instructions": [',
      `\t\t${JSON.stringify(paths().standingInstruction)}`,
      '\t], // trailing comma kept',
      '}',
      '',
    ].join('\r\n'));

    expect((await run('absent')).kind).toBe('committed');
    // Wrong implementation killer: removal must restore the preimage byte-for-byte (and its
    // mode). A parse-and-reserialize removal cannot pass this line; see the next test.
    expect(await text(target)).toBe(POPULATED);
    expect(await snapshot(root, { exclude: [path.join(roots.xdgStateHome, 'khala')] })).toEqual(before);
  });

  it('a parse-and-reserialize removal would not restore the preimage', () => {
    const edited = editOpenCodeConfig(POPULATED, { mcp: openCodeMcpEntry('/l/khala'), instruction: '/i.md' });
    const reparsed = JSON.parse(stripJsonc(edited)) as Record<string, unknown>;
    (reparsed.plugin as string[]).pop();
    delete (reparsed.mcp as Record<string, unknown>).khala;
    delete reparsed.instructions;
    expect(JSON.stringify(reparsed, null, '\t')).not.toBe(POPULATED);
  });

  it('removes a config Khala created by deleting it, leaving no directories behind', async () => {
    await run('present');
    expect((await run('absent')).kind).toBe('committed');
    expect(await exists(paths().root)).toBe(false);
  });

  it.each([
    ['empty one-line object', '{}', '{\n  "plugin": ['],
    ['empty multi-line object', '{\n}\n', '{\n  "plugin": ['],
    ['trailing-comma style', '{\n    "a": 1,\n}\n', '{\n    "a": 1,\n    "plugin": [\n        "@aiur/khala/opencode"\n    ],'],
    ['multi-line array', '{\n  "plugin": [\n    "x"\n  ]\n}', '"plugin": [\n    "x",\n    "@aiur/khala/opencode"\n  ]'],
    ['empty arrays and objects', '{"plugin": [], "mcp": {}, "instructions": []}', '"plugin": ["@aiur/khala/opencode"]'],
  ])('keeps the %s shape', (_name, before, fragment) => {
    const after = editOpenCodeConfig(before, { mcp: openCodeMcpEntry('/l/khala'), instruction: '/i.md' });
    expect(after).toContain(fragment);
    const value = JSON.parse(stripJsonc(after)) as Record<string, unknown>;
    expect(value).toMatchObject({
      plugin: expect.arrayContaining(['@aiur/khala/opencode']) as unknown,
      mcp: { khala: openCodeMcpEntry('/l/khala') },
      instructions: expect.arrayContaining(['/i.md']) as unknown,
    });
  });
});

describe('OpenCode refusals', () => {
  it.each([
    ['the config setup edits', []],
    ['another config file OpenCode also loads', [['opencode.json', '{ "model": "x" }\n']]],
  ] as const)('treats an unowned Khala entry in %s as a conflict', async (_name, others) => {
    await seed(path.join(paths().root, 'config.json'), '{"mcp": {"khala": {"type": "local", "command": ["khala"]}}}');
    for (const [name, contents] of others) await seed(path.join(paths().root, name), contents);
    const observation = await observe();
    expect(states(observation)).toMatchObject({ plugin: 'conflict', mcp_entry: 'conflict' });
    expect(observation.diagnostics.map(d => d.code)).toContain('opencode_unowned_entry');
    expect(adapter.plan({ desired: 'present', observation })).toEqual([]);
  });

  it('treats an unowned skill as a conflict, even when byte-identical', async () => {
    await seed(paths().skill, OPENCODE_SKILL);
    const observation = await observe();
    expect(states(observation).skill).toBe('conflict');
    expect(adapter.plan({ desired: 'present', observation })).toEqual([]);
  });

  it.each([
    ['invalid JSONC', '{"plugin": [}'],
    ['a non-array plugin key', '{"plugin": "opencode-wakatime"}'],
    ['a duplicate key', '{"mcp": {}, "mcp": {}}'],
    ['a non-object top level', '[]'],
  ])('refuses %s as an unsupported schema without writing', async (_name, contents) => {
    await seed(paths().defaultConfig, contents);
    const before = await snapshot(root, { mtimes: true });
    const observation = await observe();
    expect(states(observation)).toMatchObject({ plugin: 'unsupported', mcp_entry: 'unsupported' });
    expect(observation.diagnostics.map(d => d.code)).toContain('opencode_config_unsupported');
    expect(adapter.plan({ desired: 'present', observation })).toEqual([]);
    expect(await snapshot(root, { mtimes: true })).toEqual(before);
  });

  it('refuses setup on an untested version but still removes exactly', async () => {
    await seed(paths().defaultConfig, '{ "model": "x" }\n');
    await run('present');
    versionOutput = '1.18.0';
    const observation = await observe();
    expect(states(observation)).toEqual({ plugin: 'unsupported', skill: 'unsupported', mcp_entry: 'unsupported' });
    expect(observation.route).toBe('unavailable');
    expect(observation.modes).toBeNull();
    expect(adapter.plan({ desired: 'present', observation })).toEqual([]);
    expect((await run('absent')).kind).toBe('committed');
    expect(await text(paths().defaultConfig)).toBe('{ "model": "x" }\n');
    expect(await exists(paths().skill)).toBe(false);
  });

  it('reports drift after a user edit, and removal preserves the edited file', async () => {
    await run('present');
    const edited = (await text(paths().defaultConfig)).replace('{', '{\n  "model": "mine",');
    await fsp.writeFile(paths().defaultConfig, edited);
    const observation = await observe();
    expect(states(observation)).toMatchObject({ plugin: 'drifted', mcp_entry: 'drifted' });
    expect(adapter.plan({ desired: 'present', observation })).toEqual([]);
    expect(await run('absent')).toMatchObject({ kind: 'refused', state: 'drifted' });
    expect(await text(paths().defaultConfig)).toBe(edited);
  });
});
