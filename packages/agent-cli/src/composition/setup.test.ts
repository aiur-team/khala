// End to end through the composed setup service: the real harness adapters, the packaged
// payload, the real probe and the transactional executor, on a synthetic home.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setupEnvironment, setupExecute } from '../cli/main.js';
import { codexHookCommand } from '../codex/hooks-config.js';
import { OPENCODE_TESTED_VERSIONS } from '../opencode/index.js';
import { CLAUDE_SUPPORTED_VERSIONS, readClaudePluginAssets } from '../setup/adapters/claude.js';
import { CODEX_SUPPORTED_VERSIONS } from '../setup/adapters/codex.js';
import { bytes, snapshot, syntheticHome } from '../setup/fixtures/setup-home.js';
import { createSetupService, setupResultExitCode, type SetupService } from '../setup/plan.js';
import { packagedPayloadSource, type PackagedPayload } from '../setup/payload.js';
import type { SetupRoots } from '../setup/transaction.js';
import { decodeSetupResult, type SetupResult } from '../setup/types.js';
import { createSetupAdapters } from './setup.js';

const packages = fileURLToPath(new URL('../../../', import.meta.url));
const noConfirm = { dryRun: false, confirm: null } as const;

let root: string;
let roots: SetupRoots;
let env: Record<string, string>;

async function write(target: string, text: string, mode = 0o644) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, text, { mode });
}

beforeEach(async () => {
  ({ root, roots } = await syntheticHome());
  // A fresh machine often has no `~/.local/share`; setup creates it and removal takes it away.
  await fsp.rm(roots.xdgDataHome, { recursive: true });
  const bin = path.join(root, 'bin');
  const executable = (name: string, output: string) => write(path.join(bin, name), `#!/bin/sh\necho '${output}'\n`, 0o755);
  await executable('claude', `${CLAUDE_SUPPORTED_VERSIONS[0]} (Claude Code)`);
  await executable('codex', `codex-cli ${CODEX_SUPPORTED_VERSIONS[0]}`);
  await executable('opencode', OPENCODE_TESTED_VERSIONS[0]!);
  // Claude Desktop is installed too; it is report-only and must refuse nothing.
  await write(path.join(roots.home, 'Applications', 'Claude.app', 'Contents', 'Info.plist'),
    '<plist><dict><key>CFBundleShortVersionString</key><string>1.2.3</string></dict></plist>\n');
  // The person's own configuration, which removal must restore byte for byte.
  await write(path.join(roots.home, '.claude', 'settings.json'), '{\n  "theme": "dark"\n}\n', 0o600);
  await write(path.join(roots.home, '.codex', 'config.toml'), 'model   =   "o4"   # keep this spacing\n', 0o600);
  await write(path.join(roots.xdgConfigHome, 'opencode', 'opencode.json'), '{ "theme": "tokyonight" }\n');
  env = { HOME: roots.home, PATH: bin };
});
afterEach(async () => { await fsp.rm(root, { recursive: true, force: true }); });

async function payload(): Promise<PackagedPayload> {
  return {
    version: '0.1.0',
    runtime: bytes('// khala runtime\n'),
    openCodePlugin: bytes('// khala opencode plugin\n'),
    claudePlugin: await readClaudePluginAssets(path.join(packages, 'claude-plugin')),
    codexSkill: new Uint8Array(await fsp.readFile(path.join(packages, 'agent-skill', 'SKILL.md'))),
  };
}

async function service(): Promise<SetupService> {
  const packaged = await payload();
  return createSetupService({
    environment: () => setupEnvironment(env),
    adapters: createSetupAdapters(packaged, process.execPath),
    execute: setupExecute(env),
    payload: packagedPayloadSource(packaged, process.execPath),
  });
}

/** What Codex's "Hooks need review" dialog persists when the person trusts every Khala handler. */
async function approveCodexHooks(codexHome: string): Promise<string> {
  const hooksPath = path.join(codexHome, 'hooks.json');
  const hooks = JSON.parse(await fsp.readFile(hooksPath, 'utf8')) as { hooks: Record<string, { hooks: { command: string }[] }[]> };
  const events = { PreToolUse: 'pre_tool_use', PostToolUse: 'post_tool_use', UserPromptSubmit: 'user_prompt_submit', Stop: 'stop' };
  let tables = '';
  for (const [name, spelled] of Object.entries(events)) {
    for (const [group, entry] of (hooks.hooks[name] ?? []).entries()) {
      for (const [handler, candidate] of entry.hooks.entries()) {
        if (candidate.command === codexHookCommand(path.join(roots.xdgDataHome, 'khala', 'bin', 'khala'))) {
          tables += `\n[hooks.state."${hooksPath}:${spelled}:${group}:${handler}"]\ntrusted_hash = "sha256:${'cd'.repeat(32)}"\n`;
        }
      }
    }
  }
  await fsp.appendFile(path.join(codexHome, 'config.toml'), tables);
  return tables;
}

const outsideExecutorState = () => snapshot(root, { exclude: [path.join(roots.xdgStateHome, 'khala')] });
const ready = (result: SetupResult) => Object.fromEntries(result.harnesses.filter(report => report.executable.present).map(report =>
  [report.harness,report.components.every(component => component.state === 'ready')]));
const decodes = (result: SetupResult) => expect(decodeSetupResult(JSON.parse(JSON.stringify(result)))).toEqual(result);

describe('composed setup on a fake home', () => {
  it('dry-runs, applies a confirmed plan, reports every harness configured, and removes byte-exact', async () => {
    const setup = await service();
    const khala = path.join(roots.xdgDataHome, 'khala');
    const launcher = path.join(khala, 'bin', 'khala');
    const runtime = path.join(khala, 'versions', '0.1.0', 'khala.js');
    const plugin = path.join(khala, 'bin', 'opencode.js');
    const codexConfig = path.join(roots.home, '.codex', 'config.toml');
    const configBefore = await fsp.readFile(codexConfig, 'utf8');
    const before = await outsideExecutorState();

    const dry = await setup.lifecycle('setup', { dryRun: true, confirm: null });
    decodes(dry);
    expect(dry.state).toBe('confirmation_required');
    expect(dry.confirmation).toMatchObject({ required: true, harnesses: ['claude', 'codex', 'opencode'] });
    expect(dry.harnesses.map(report => report.harness)).toEqual(['claude', 'codex', 'opencode', 'cursor', 'claude-app']);
    expect(dry.harnesses[3]!.executable).toEqual({ present: false, path: null });
    expect(dry.diagnostics.map(diagnostic => diagnostic.code)).toContain('claude_app_delivery_unproven');
    expect(dry.operations.map(operation => operation.path)).toEqual(expect.arrayContaining([launcher, runtime, plugin]));
    expect(await outsideExecutorState()).toEqual(before);

    const applied = await setup.lifecycle('setup', { dryRun: false, confirm: dry.planDigest });
    decodes(applied);
    expect(applied).toMatchObject({ changed: true, confirmation: { required: false, confirmed: true } });
    expect(applied.operations.map(operation => operation.status)).toEqual(dry.operations.map(() => 'applied'));
    // Codex runs Khala's hooks only after the person trusts them in its own dialog.
    expect(applied.state).toBe('awaiting_hook_review');
    expect(setupResultExitCode(applied)).toBe(0);
    expect(fs.statSync(launcher).mode & 0o777).toBe(0o500);
    expect(fs.readFileSync(launcher, 'utf8')).toBe(`#!/bin/sh\nexec '${process.execPath}' '${runtime}' "$@"\n`);
    expect(fs.readFileSync(runtime, 'utf8')).toBe('// khala runtime\n');
    expect(fs.readFileSync(plugin, 'utf8')).toBe('// khala opencode plugin\n');

    const trust = await approveCodexHooks(path.join(roots.home, '.codex'));
    const status = await setup.configuration();
    decodes(status);
    expect(ready(status)).toEqual({ claude: true, codex: true, opencode: true, 'claude-app': false });
    // Configuration alone proves no Claude or Codex delivery route, so readiness is not claimed.
    expect(status).toMatchObject({ ok: true, state: 'configured_effect_unknown' });
    expect(status.harnesses.find(report => report.harness === 'opencode')?.route).toBe('opencode_plugin');
    expect(await setup.lifecycle('setup', noConfirm)).toMatchObject({ changed: false, operations: [], planDigest: null });

    const removal = await setup.lifecycle('remove', noConfirm);
    expect(removal.state).toBe('confirmation_required');
    const removed = await setup.lifecycle('remove', { dryRun: false, confirm: removal.planDigest });
    decodes(removed);
    expect(removed).toMatchObject({ changed: true, confirmation: { confirmed: true } });
    const after = await outsideExecutorState();
    // Every byte is back, except the trust records the person added, which Khala never touches.
    expect(after).toEqual({ ...before, [codexConfig]: after[codexConfig] });
    expect(await fsp.readFile(codexConfig, 'utf8')).toBe(configBefore + trust);
  });

  it('configures Codex under CODEX_HOME, outside HOME', async () => {
    const codexHome = path.join(root, 'codex-home');
    await fsp.mkdir(codexHome);
    env = { ...env, CODEX_HOME: codexHome };
    const setup = await service();
    const dry = await setup.lifecycle('setup', noConfirm);
    const applied = await setup.lifecycle('setup', { dryRun: false, confirm: dry.planDigest });
    expect(applied.changed).toBe(true);
    expect(fs.existsSync(path.join(codexHome, 'skills', 'khala', 'SKILL.md'))).toBe(true);
    expect(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8')).toContain('[mcp_servers.khala]');
    // The person's `~/.codex` is left exactly as it was.
    expect(fs.readdirSync(path.join(roots.home, '.codex'))).toEqual(['config.toml']);
  });
});
