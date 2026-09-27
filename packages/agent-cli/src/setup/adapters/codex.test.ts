import fsp from 'node:fs/promises';
import path from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { codexHookCommand } from '../../codex/hooks-config.js';
import { ConfinedFilesystem, sha256 } from '../filesystem.js';
import { bytes, snapshot, syntheticHome } from '../fixtures/setup-home.js';
import { executeSetupPlan, type ExecutablePlan, type ExecutionOutcome, type SetupRoots } from '../transaction.js';
import { setupExitCode, type HarnessObservation, type SetupEnvironment, type SetupProbe } from '../types.js';
import {
  CODEX_MCP_ENTRY, codexMcpBlock, codexPaths, createCodexSetupAdapter, definesKhalaMcpServer, parseCodexVersion,
  withMcpBlock, withoutMcpBlock,
} from './codex.js';

const SKILL_V1 = bytes('---\nname: khala\n---\n\n# Khala v1\n');
const SKILL_V2 = bytes('---\nname: khala\n---\n\n# Khala v2\n');
const CODEX = '/opt/codex/bin/codex';
const SENTINEL_PORT = '48731';
const SENTINEL_TOKEN = 'khala-sentinel-token-4d1f0c';

// Unusual but valid TOML, the person's own MCP server, and pre-existing trust for their own hook.
const TRUST_SENTINEL = '[hooks.state."/elsewhere/hooks.json:stop:0:0"]\ntrusted_hash = "sha256:' + 'ab'.repeat(32) + '"  # sentinel\n';
const USER_CONFIG = 'model   =   "o4"   # keep this spacing\n\n[mcp_servers.docs]\ncommand="docs-mcp"\n\n' + TRUST_SENTINEL;
const USER_HOOKS = '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"say done","timeout":5}]}]},\n  "note":   "user"}';

let root: string;
let roots: SetupRoots;
let version: string;
let resolvable: boolean;

beforeEach(async () => {
  ({ root, roots } = await syntheticHome());
  version = 'codex-cli 0.154.0\n';
  resolvable = true;
  // A live runtime descriptor exists; nothing setup writes may ever carry its port or token.
  const descriptor = path.join(roots.xdgStateHome, 'khala', 'runtime.json');
  await fsp.mkdir(path.dirname(descriptor), { recursive: true });
  await fsp.writeFile(descriptor, JSON.stringify({ port: Number(SENTINEL_PORT), token: SENTINEL_TOKEN }), { mode: 0o600 });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fsp.rm(root, { recursive: true, force: true });
});

const probe: SetupProbe = {
  resolveExecutable: async name => (name === 'codex' && resolvable ? CODEX : null),
  runVersion: async (executable, args) => {
    expect([executable, ...args]).toEqual([CODEX, '--version']);
    return version;
  },
  readFile: async target => {
    const stat = await fsp.lstat(target).catch(() => null);
    if (stat === null) return null;
    if (!stat.isFile()) throw new Error(`not a regular file: ${target}`);
    return new Uint8Array(await fsp.readFile(target));
  },
  listDirectory: async target => fsp.readdir(target).catch(() => null),
};
const environment = (): SetupEnvironment => ({ ...roots, probe });
const paths = () => codexPaths(roots);
const hookCommand = () => codexHookCommand(paths().launcher);
const read = (target: string) => fsp.readFile(target, 'utf8');
const exists = (target: string) => fsp.lstat(target).then(() => true, () => false);

async function observe(skill = SKILL_V1) {
  const adapter = createCodexSetupAdapter({ skill });
  const detection = await adapter.detect(environment());
  const observation = await adapter.inspect(environment(), detection);
  return { adapter, observation };
}
const states = (observation: HarnessObservation) => Object.fromEntries(observation.components.map(item => [item.component, item.state]));

async function executablePlan(command: 'setup' | 'remove', skill = SKILL_V1): Promise<ExecutablePlan> {
  const { adapter, observation } = await observe(skill);
  const planned = adapter.executablePlan({ desired: command === 'setup' ? 'present' : 'absent', observation });
  return {
    command,
    planDigest: sha256(bytes(JSON.stringify({ command, operations: planned.operations }))),
    operations: planned.operations,
    contents: planned.contents,
    entryOwnedPaths: planned.entryOwnedPaths,
  };
}

/** Plans, confirms, and executes the way `setup`/`remove` will: the executor replans under its lock. */
async function run(command: 'setup' | 'remove', skill = SKILL_V1): Promise<ExecutionOutcome> {
  const confirmed = await executablePlan(command, skill);
  return executeSetupPlan({
    roots, searchPath: '/usr/bin:/bin', confirmedDigest: confirmed.planDigest, replan: () => executablePlan(command, skill),
  });
}

async function seedUserState() {
  await fsp.mkdir(paths().codexHome, { recursive: true });
  await fsp.writeFile(paths().config, USER_CONFIG, { mode: 0o600 });
  await fsp.writeFile(paths().hooks, USER_HOOKS, { mode: 0o644 });
}

/** What Codex's "Hooks need review" dialog persists when the person trusts every Khala handler. */
async function approveNatively() {
  const hooks = JSON.parse(await read(paths().hooks)) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
  const event = { PreToolUse: 'pre_tool_use', PostToolUse: 'post_tool_use', UserPromptSubmit: 'user_prompt_submit', Stop: 'stop' } as const;
  let tables = '';
  for (const [name, spelled] of Object.entries(event)) {
    for (const [group, entry] of hooks.hooks[name]!.entries()) {
      for (const [handler, candidate] of entry.hooks.entries()) {
        if (candidate.command !== hookCommand()) continue;
        tables += `\n[hooks.state."${paths().hooks}:${spelled}:${group}:${handler}"]\ntrusted_hash = "sha256:${'cd'.repeat(32)}"\n`;
      }
    }
  }
  await fsp.appendFile(paths().config, tables);
  return tables;
}

const everythingButExecutorState = () => snapshot(root, { exclude: [path.join(roots.xdgStateHome, 'khala', 'setup')] });

describe('Codex detection', () => {
  it('keeps absent, supported, and unknown versions distinct', async () => {
    const adapter = createCodexSetupAdapter({ skill: SKILL_V1 });
    expect(await adapter.detect(environment())).toEqual({ executable: CODEX, version: '0.154.0', supported: true });
    version = 'codex-cli 0.156.1\n';
    expect(await adapter.detect(environment())).toEqual({ executable: CODEX, version: '0.156.1', supported: false });
    version = 'something else';
    expect(await adapter.detect(environment())).toEqual({ executable: CODEX, version: 'unknown', supported: false });
    resolvable = false;
    expect(await adapter.detect(environment())).toEqual({ executable: null, version: null, supported: false });
    expect(parseCodexVersion('codex-cli 0.154.0')).toBe('0.154.0');
  });

  it('reports an absent Codex without creating ~/.codex, and plans nothing', async () => {
    resolvable = false;
    const { adapter, observation } = await observe();
    expect(states(observation)).toEqual({ skill: 'absent', hooks: 'absent', mcp_entry: 'absent' });
    expect(observation.route).toBe('unavailable');
    expect(adapter.plan({ desired: 'present', observation })).toEqual([]);
    expect(await exists(paths().codexHome)).toBe(false);
  });

  it('plans no setup for an unknown version', async () => {
    version = 'codex-cli 0.160.0';
    const { adapter, observation } = await observe();
    expect(adapter.plan({ desired: 'present', observation })).toEqual([]);
    expect(observation.diagnostics.map(item => item.code)).toContain('codex_version_unsupported');
  });
});

describe('Codex setup on 0.154.0', () => {
  it('plans exactly skill + hooks + MCP (no plugin) and writes only those three paths in a clean home', async () => {
    const planned = await executablePlan('setup');
    expect(planned.operations.map(item => [item.component, item.type, item.path])).toEqual([
      ['skill', 'file_create', paths().skill],
      ['hooks', 'config_entry_set', paths().hooks],
      ['mcp_entry', 'config_entry_set', paths().config],
    ]);
    const before = await everythingButExecutorState();
    expect((await run('setup')).kind).toBe('committed');
    const after = await everythingButExecutorState();
    const changed = Object.keys(after).filter(key => after[key] !== before[key]).sort();
    // The complete mutation footprint: the three planned files and the directories holding them.
    expect(changed).toEqual([
      paths().codexHome, paths().config, paths().hooks, path.join(paths().codexHome, 'skills'),
      path.dirname(paths().skill), paths().skill,
    ].sort());
    expect(Object.keys(before).filter(key => !(key in after))).toEqual([]);

    expect(await read(paths().config)).toBe(codexMcpBlock(paths().launcher));
    expect(parseToml(await read(paths().config))).toEqual({ mcp_servers: { khala: { command: paths().launcher, args: ['mcp-serve'] } } });
    for (const file of [paths().config, paths().hooks, paths().skill]) {
      const content = await read(file);
      expect(content).not.toContain(SENTINEL_PORT);
      expect(content).not.toContain(SENTINEL_TOKEN);
    }
  });

  it('awaits native hook review, then is ready once Codex records trust, without Khala writing trust', async () => {
    await seedUserState();
    expect((await run('setup')).kind).toBe('committed');
    const pending = (await observe()).observation;
    expect(states(pending)).toEqual({ skill: 'ready', hooks: 'awaiting_hook_review', mcp_entry: 'ready' });
    // Readiness is false: bare status is informational (0) and `status --check` refuses (3).
    expect(setupExitCode('status', 'awaiting_hook_review')).toBe(0);
    expect(setupExitCode('status', 'awaiting_hook_review', { check: true })).toBe(3);
    expect(await read(paths().config)).not.toContain(`hooks.state."${paths().hooks}`);

    const hooksBefore = await read(paths().hooks);
    await approveNatively();
    const approved = await observe();
    expect(states(approved.observation)).toEqual({ skill: 'ready', hooks: 'ready', mcp_entry: 'ready' });
    // Approval changed nothing Khala installed; a second setup is a no-op.
    expect(await read(paths().hooks)).toBe(hooksBefore);
    expect(approved.adapter.plan({ desired: 'present', observation: approved.observation })).toEqual([]);
  });

  it('keeps every trust byte and the hook command/path through setup -> approval -> upgrade -> remove', async () => {
    await seedUserState();
    expect((await run('setup')).kind).toBe('committed');
    const installedHooks = await read(paths().hooks);
    expect(await read(paths().config)).toContain(TRUST_SENTINEL);
    expect(await read(paths().config)).toBe(withMcpBlock(USER_CONFIG, codexMcpBlock(paths().launcher)));
    // The person's hook keeps its trust position; Khala's groups come after it.
    const hooks = JSON.parse(installedHooks) as { hooks: Record<string, { hooks: { command: string }[] }[]>; note: string };
    expect(hooks.note).toBe('user');
    expect(hooks.hooks.Stop!.map(group => group.hooks[0]!.command)).toEqual(['say done', hookCommand()]);
    // The hook runs the staged launcher by absolute path; it never looks `khala` up on PATH.
    expect(hookCommand()).toBe(`'${path.join(roots.xdgDataHome, 'khala', 'bin', 'khala')}' codex-hook`);

    const trust = await approveNatively();

    const upgrade = await executablePlan('setup', SKILL_V2);
    expect(upgrade.operations.map(item => [item.component, item.type])).toEqual([['skill', 'file_replace']]);
    expect((await run('setup', SKILL_V2)).kind).toBe('committed');
    expect(await read(paths().hooks)).toBe(installedHooks);
    expect(await read(paths().config)).toBe(withMcpBlock(USER_CONFIG, codexMcpBlock(paths().launcher)) + trust);
    expect(states((await observe(SKILL_V2)).observation)).toEqual({ skill: 'ready', hooks: 'ready', mcp_entry: 'ready' });

    expect((await run('remove', SKILL_V2)).kind).toBe('committed');
    // Exactly Khala's table is gone: the person's bytes and every trust record survive untouched.
    expect(await read(paths().config)).toBe(USER_CONFIG + trust);
    expect(await read(paths().hooks)).toBe(USER_HOOKS);
    expect(await exists(path.dirname(paths().skill))).toBe(false);
    expect(await exists(path.join(roots.xdgStateHome, 'khala', 'setup', 'manifest.v1.json'))).toBe(false);
  });

  it('reports Codex app delivery as unproven in setup, status and remove, without planning for it', async () => {
    const appDiagnostics = async () => (await observe()).observation.diagnostics
      .filter(item => item.code.startsWith('codex_app_'))
      .map(item => [item.code, item.severity, item.message.split(':')[0]]);
    const expected = [
      ['codex_app_delivery_unproven', 'info', 'Codex desktop app'],
      ['codex_app_delivery_unproven', 'info', 'Codex Cloud task'],
    ];
    expect(await appDiagnostics()).toEqual(expected);
    expect((await run('setup')).kind).toBe('committed');
    expect(await appDiagnostics()).toEqual(expected);
    expect((await run('remove')).kind).toBe('committed');
    expect(await appDiagnostics()).toEqual(expected);
    resolvable = false;
    expect(await appDiagnostics()).toEqual(expected);
  });

  it('removes a clean-home install back to absence', async () => {
    const before = await everythingButExecutorState();
    expect((await run('setup')).kind).toBe('committed');
    expect((await run('remove')).kind).toBe('committed');
    expect(await everythingButExecutorState()).toEqual(before);
  });

  it('restores the byte-exact hooks.json preimage on remove, not a re-serialization of it', async () => {
    await seedUserState();
    expect((await run('setup')).kind).toBe('committed');
    const removal = await executablePlan('remove');
    const hooks = removal.operations.find(item => item.component === 'hooks')!;
    expect(hooks).toMatchObject({ type: 'file_restore', restored: sha256(bytes(USER_HOOKS)) });
    expect((await run('remove')).kind).toBe('committed');
    expect(await read(paths().hooks)).toBe(USER_HOOKS);
    expect(await read(paths().hooks)).not.toContain(hookCommand());
  });

  it('fails and rolls back when a write reports success without the MCP postimage', async () => {
    await seedUserState();
    const before = await everythingButExecutorState();
    const replace = ConfinedFilesystem.prototype.replace;
    // The config.toml write "succeeds" but leaves the old bytes, like a command exiting 0 without its edit.
    vi.spyOn(ConfinedFilesystem.prototype, 'replace').mockImplementation(async function (this: ConfinedFilesystem, target, expected, content, mode) {
      if (target === paths().config) return;
      return replace.call(this, target, expected, content, mode);
    });
    const outcome = await run('setup');
    expect(outcome.kind).toBe('rolled_back');
    vi.restoreAllMocks();
    expect(await everythingButExecutorState()).toEqual(before);
    expect(states((await observe()).observation).mcp_entry).toBe('absent');
  });
});

describe('Codex conflicts and drift', () => {
  it('refuses an unowned Khala MCP entry, hook, or skill, even when identical', async () => {
    await fsp.mkdir(paths().codexHome, { recursive: true });
    await fsp.writeFile(paths().config, codexMcpBlock(paths().launcher));
    let { adapter, observation } = await observe();
    expect(states(observation).mcp_entry).toBe('conflict');
    expect(adapter.plan({ desired: 'present', observation })).toEqual([]);

    await fsp.rm(paths().config);
    await fsp.writeFile(paths().hooks, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: hookCommand() }] }] } }));
    ({ adapter, observation } = await observe());
    expect(states(observation).hooks).toBe('conflict');

    await fsp.rm(paths().hooks);
    await fsp.mkdir(path.dirname(paths().skill), { recursive: true });
    await fsp.writeFile(paths().skill, SKILL_V1);
    ({ adapter, observation } = await observe());
    expect(states(observation).skill).toBe('conflict');
    expect(adapter.plan({ desired: 'present', observation })).toEqual([]);
    expect(adapter.plan({ desired: 'absent', observation })).toEqual([]);
  });

  it('treats an edited Khala table as drift and refuses the whole removal', async () => {
    await seedUserState();
    expect((await run('setup')).kind).toBe('committed');
    const config = await read(paths().config);
    await fsp.writeFile(paths().config, config.replace('args = ["mcp-serve"]', 'args = ["mcp-serve", "--x"]'));
    const { adapter, observation } = await observe();
    expect(states(observation).mcp_entry).toBe('drifted');
    expect(adapter.plan({ desired: 'absent', observation })).toEqual([]);
    expect(adapter.plan({ desired: 'present', observation })).toEqual([]);
  });

  it('is not ready when the MCP table disappeared after setup', async () => {
    expect((await run('setup')).kind).toBe('committed');
    await fsp.writeFile(paths().config, 'model = "o4"\n');
    expect(states((await observe()).observation).mcp_entry).toBe('drifted');
  });
});

describe('Codex MCP table editing', () => {
  it.each(['', 'a = 1', 'a = 1\n', 'a = 1\n\n', 'a = 1\r\n'])('removal inverts insertion for %j', config => {
    const block = codexMcpBlock('/x/khala');
    expect(withoutMcpBlock(withMcpBlock(config, block), block)).toBe(config);
    expect(withoutMcpBlock(withMcpBlock(config, block) + '\n[hooks.state."k"]\ntrusted_hash = "x"\n', block))
      .toBe(config + '\n[hooks.state."k"]\ntrusted_hash = "x"\n');
  });

  it('recognises every spelling of an existing mcp_servers.khala', () => {
    for (const config of [
      '[mcp_servers.khala]\n', '[ mcp_servers . "khala" ]\n', "[mcp_servers.'khala'.env]\n", 'mcp_servers.khala.command = "x"\n',
      '[mcp_servers]\nkhala = { command = "x" }\n', 'mcp_servers = { }\n',
    ]) expect(definesKhalaMcpServer(config), config).toBe(true);
    for (const config of ['[mcp_servers.khalax]\n', '[mcp_servers]\ndocs = {}\n[other]\nkhala = 1\n', '# [mcp_servers.khala]\n']) {
      expect(definesKhalaMcpServer(config), config).toBe(false);
    }
    expect(CODEX_MCP_ENTRY).toBe('mcp_servers.khala');
  });
});
