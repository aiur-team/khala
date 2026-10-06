import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { codexHooksFragment, mergeCodexHooks } from '../../codex/hooks-config.mjs';
import { bundle } from '../bundle';
import { runMcpInstall } from './mcp';
import { adapterFor } from '../harness';
import { consentLine, setWake } from '../wake/cli';
import { wakeDrivers } from '../wake/status';
import { copilotPaths, installCopilot } from './copilot';
import { cursorPaths, installCursor } from './cursor';
import { opencodePaths, installOpenCode, opencodePluginPublished } from './opencode';
import { ManagedFiles, formatJson, jsonFormat, readManaged, textFormat } from './managed-file';
import { stateRoot } from '../state';

export const MCP_MARKER = '# Khala MCP server, managed by `khala install codex`';
const USAGE = 'usage: khala install codex [--codex-home <dir>] [--wake|--no-wake] [--uninstall] | khala install cursor [--wake|--no-wake] [--uninstall] | khala install opencode [--uninstall] | khala install copilot [--wake|--no-wake] [--uninstall] | khala install mcp --print [--harness <id>]';

export type InstallDeps = {
  env?: NodeJS.ProcessEnv;
  package?: { name: string; version: string } | undefined;
  /** Registry fetch seam for the OpenCode plugin availability check. */
  fetchRegistry?: typeof fetch;
  /** Installs `spec` globally under `prefix`; returns true on success. */
  npmInstall?: (prefix: string, spec: string) => boolean;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  /** Target the platform whose paths and hook shell to target, and its Node binary. */
  platform?: NodeJS.Platform;
  node?: string;
  home?: string;
};

export async function runCursorInstall(flags: readonly string[], deps: InstallDeps): Promise<number> {
  const env = deps.env ?? process.env;
  const stdout = deps.stdout ?? (line => { process.stdout.write(line + '\n'); });
  const stderr = deps.stderr ?? (line => { process.stderr.write(line + '\n'); });
  let uninstall = false;
  for (const flag of flags) {
    if (flag === '--uninstall') uninstall = true;
    else { stderr(USAGE); return 1; }
  }
  const pkg = 'package' in deps ? deps.package : bundle;
  if (!pkg && !uninstall) {
    stderr('khala: install runs from the published package (npx -y khala-cli install cursor)');
    return 1;
  }
  const platform = deps.platform ?? process.platform;
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  // Cursor reads %USERPROFILE%\.cursor on Windows even when Git Bash exports HOME.
  const home = deps.home ?? (platform === 'win32' ? env.USERPROFILE || os.homedir() : env.HOME || os.homedir());
  const paths = cursorPaths({ platform, path: pathApi, home, env }, pkg?.name);
  const spec = pkg ? env.KHALA_INSTALL_SPEC || `${pkg.name}@${pkg.version}` : '';
  return installCursor({
    paths, platform, node: deps.node ?? process.execPath, uninstall, stdout, stderr, stateDir: installStateDir(env, home),
    install: () => {
      stdout(`installing ${spec} into ${paths.prefix}`);
      if ((deps.npmInstall ?? defaultNpmInstall)(paths.prefix, spec)) return true;
      stderr('khala: npm install failed for ' + spec);
      return false;
    },
  });
}

export async function runCopilotInstall(flags: readonly string[], deps: InstallDeps): Promise<number> {
  const env = deps.env ?? process.env;
  const stdout = deps.stdout ?? (line => { process.stdout.write(line + '\n'); });
  const stderr = deps.stderr ?? (line => { process.stderr.write(line + '\n'); });
  let uninstall = false;
  for (const flag of flags) {
    if (flag === '--uninstall') uninstall = true;
    else { stderr(USAGE); return 1; }
  }
  const pkg = 'package' in deps ? deps.package : bundle;
  if (!pkg && !uninstall) {
    stderr('khala: install runs from the published package (npx -y khala-cli install copilot)');
    return 1;
  }
  const platform = deps.platform ?? process.platform;
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  // Prefer the native Windows profile when Git Bash exports HOME.
  const home = deps.home ?? (platform === 'win32' ? env.USERPROFILE || os.homedir() : env.HOME || os.homedir());
  const paths = copilotPaths({ platform, path: pathApi, home, env }, pkg?.name);
  const spec = pkg ? env.KHALA_INSTALL_SPEC || `${pkg.name}@${pkg.version}` : '';
  return installCopilot({
    paths, node: deps.node ?? process.execPath, uninstall, stdout, stderr, stateDir: installStateDir(env, home),
    install: () => {
      stdout(`installing ${spec} into ${paths.prefix}`);
      if ((deps.npmInstall ?? defaultNpmInstall)(paths.prefix, spec)) return true;
      stderr('khala: npm install failed for ' + spec);
      return false;
    },
  });
}

export async function runOpenCodeInstall(flags: readonly string[], deps: InstallDeps): Promise<number> {
  const env = deps.env ?? process.env;
  const stdout = deps.stdout ?? (line => { process.stdout.write(line + '\n'); });
  const stderr = deps.stderr ?? (line => { process.stderr.write(line + '\n'); });
  if (flags.some(flag => flag !== '--uninstall')) { stderr(USAGE); return 1; }
  const uninstall = flags.includes('--uninstall');
  const pkg = 'package' in deps ? deps.package : bundle;
  if (!pkg && !uninstall) {
    stderr('khala: install runs from the published package (npx -y khala-cli install opencode)');
    return 1;
  }
  const platform = deps.platform ?? process.platform;
  const home = deps.home ?? (platform === 'win32' ? env.USERPROFILE || os.homedir() : env.HOME || os.homedir());
  const paths = opencodePaths({ platform, path: platform === 'win32' ? path.win32 : path.posix, home, env });
  const spec = pkg ? env.KHALA_INSTALL_SPEC || `${pkg.name}@${pkg.version}` : '';
  const override = env.KHALA_OPENCODE_PLUGIN_SPEC;
  const plugin = uninstall ? null : override || (await opencodePluginPublished(pkg!.version, deps.fetchRegistry) ? `khala-opencode@${pkg!.version}` : null);
  return installOpenCode({ paths, platform, uninstall, stdout, stderr, plugin, stateDir: installStateDir(env, home),
    install: () => {
      stdout(`installing ${spec} into ${paths.prefix}`);
      if ((deps.npmInstall ?? defaultNpmInstall)(paths.prefix, spec)) return true;
      stderr('khala: npm install failed for ' + spec);
      return false;
    },
  });
}

/** Khala's state directory for the installer's `home` (tests pass a home without HOME). */
function installStateDir(env: NodeJS.ProcessEnv, home: string): string {
  return stateRoot(env.XDG_STATE_HOME ? env : { ...env, HOME: home });
}

/** POSIX single-quotes a path for a hook command line. */
export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

function defaultNpmInstall(prefix: string, spec: string): boolean {
  const result = spawnSync('npm', ['install', '--global', '--prefix', prefix, '--no-audit', '--no-fund', '--loglevel=error', spec], {
    stdio: ['ignore', 'ignore', 'inherit'], shell: process.platform === 'win32',
  });
  return result.status === 0;
}

/**
 * Rewrites config.toml: removes a block this installer wrote earlier (marker line through the
 * line before the next table header) and, on install, appends a fresh one. An unmanaged
 * `[mcp_servers.khala]` table is left alone and reported.
 */
export function updateCodexToml(text: string, block: string | null): { text: string } | { error: 'codex_mcp_exists' } {
  const lines = text.split('\n');
  const start = lines.indexOf(MCP_MARKER);
  if (start >= 0) {
    let end = start + 2;
    while (end < lines.length && !/^\s*\[/u.test(lines[end] ?? '')) end++;
    while (end > start + 2 && (lines[end - 1] ?? '').trim() === '') end--;
    // Also drop the blank separator line this installer wrote before the block.
    const from = start > 0 && (lines[start - 1] ?? '').trim() === '' ? start - 1 : start;
    lines.splice(from, end - from);
  } else if (lines.some(line => /^\s*\[\s*mcp_servers\s*\.\s*"?khala"?\s*\]/u.test(line))) {
    return { error: 'codex_mcp_exists' };
  }
  let out = lines.join('\n').replace(/\n*$/u, '');
  if (block) out = (out ? out + '\n\n' : '') + block;
  return { text: out ? out + '\n' : '' };
}

export function codexMcpBlock(bin: string, env: NodeJS.ProcessEnv): string {
  const home = env.HOME && path.isAbsolute(env.HOME) ? env.HOME : os.homedir();
  const state = env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : path.join(home, '.local/state');
  // JSON string escapes are valid TOML basic strings.
  return [
    MCP_MARKER,
    '[mcp_servers.khala]',
    `command = ${JSON.stringify(bin)}`,
    'args = ["mcp", "--harness", "codex"]',
    `env = { HOME = ${JSON.stringify(home)}, XDG_STATE_HOME = ${JSON.stringify(state)} }`,
  ].join('\n');
}

/**
 * `khala install codex`: installs this exact package version under
 * `${XDG_DATA_HOME:-~/.local/share}/khala/npm`, then points Codex's MCP table and the three
 * delivery hooks at its stable `bin/khala`. Hooks then start in tens of milliseconds instead
 * of paying npx resolution on every tool call, and the hook command line stays the same
 * across upgrades, so Codex keeps trusting it.
 */
export async function runCodexInstall(flags: readonly string[], deps: InstallDeps): Promise<number> {
  const env = deps.env ?? process.env;
  const stdout = deps.stdout ?? (line => { process.stdout.write(line + '\n'); });
  const stderr = deps.stderr ?? (line => { process.stderr.write(line + '\n'); });
  let codexHome = env.CODEX_HOME && path.isAbsolute(env.CODEX_HOME) ? env.CODEX_HOME : path.join(env.HOME ?? os.homedir(), '.codex');
  let uninstall = false;
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === '--uninstall') uninstall = true;
    else if (flags[i] === '--codex-home' && flags[i + 1]) codexHome = path.resolve(flags[++i] as string);
    else { stderr(USAGE); return 1; }
  }
  const pkg = 'package' in deps ? deps.package : bundle;
  if (!pkg && !uninstall) {
    stderr('khala: install runs from the published package (npx -y <package> install codex); from a checkout follow packages/agent/docs/install-codex.md');
    return 1;
  }
  const dataHome = env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.join(env.HOME ?? os.homedir(), '.local/share');
  const prefix = path.join(dataHome, 'khala', 'npm');
  const bin = path.join(prefix, 'bin', 'khala');
  const command = `${shellQuote(bin)} hook deliver --harness codex`;

  const hooksFile = path.join(codexHome, 'hooks.json');
  const tomlFile = path.join(codexHome, 'config.toml');
  const hooks = await readManaged(hooksFile);
  const toml = await readManaged(tomlFile);
  const fragment = codexHooksFragment(command);
  let merged: { config: unknown; warnings: string[] };
  try { merged = mergeCodexHooks(jsonFormat.parse(hooks.text ?? ''), uninstall ? 'uninstall' : 'install', fragment); }
  catch { stderr('khala: invalid hooks.json in ' + codexHome); return 1; }
  const nextToml = updateCodexToml(toml.text ?? '', uninstall ? null : codexMcpBlock(bin, env));
  if ('error' in nextToml) {
    stderr(`khala: ${tomlFile} already has an unmanaged [mcp_servers.khala] table; remove it and run this again`);
    return 1;
  }

  if (!uninstall && pkg) {
    // KHALA_INSTALL_SPEC (a tarball path) lets acceptance install an unpublished build.
    const spec = env.KHALA_INSTALL_SPEC || `${pkg.name}@${pkg.version}`;
    stdout(`installing ${spec} into ${prefix}`);
    if (!(deps.npmInstall ?? defaultNpmInstall)(prefix, spec)) { stderr('khala: npm install failed for ' + spec); return 1; }
  }
  for (const warning of merged.warnings) stderr(warning);
  const managed = new ManagedFiles(stateRoot(env));
  if (uninstall) {
    await managed.restore(hooks, jsonFormat, value => mergeCodexHooks(value, 'uninstall', fragment).config);
    await managed.restore(toml, textFormat, value => {
      const next = updateCodexToml(String(value), null);
      return 'text' in next ? next.text : value;
    });
  } else {
    // New files are private (0600); existing files keep their mode.
    await managed.write([
      { current: hooks, text: formatJson(merged.config, hooks.text), mode: 0o600 },
      { current: toml, text: nextToml.text, mode: 0o600 },
    ]);
  }
  if (uninstall) {
    stdout(`removed the Khala MCP server and hooks from ${codexHome}; delete ${prefix} to remove the CLI`);
  } else {
    stdout(`configured ${tomlFile} and ${hooksFile}`);
    stdout('restart or resume Codex, then trust the three Khala hooks in "Hooks need review"');
  }
  return 0;
}

export async function runInstall(argv: readonly string[], deps: InstallDeps = {}): Promise<number> {
  const [target = '', ...flags] = argv;
  if (target === 'mcp') return runMcpInstall(flags, deps);
  const adapter = adapterFor(target);
  const run = adapter?.install;
  if (run) {
    const wake = !flags.includes('--no-wake');
    const result = await run(flags.filter(flag => flag !== '--wake' && flag !== '--no-wake'), deps);
    if (result === 0 && !flags.includes('--uninstall')) {
      const drivers = wakeDrivers(target).filter(driver => driver.optIn).map(driver => driver.id);
      if (drivers.length) {
        await setWake(target, drivers, wake, deps.env ?? process.env);
        (deps.stdout ?? console.log)(consentLine(target, drivers, wake));
      }
    }
    return result;
  }
  (deps.stderr ?? (line => { process.stderr.write(line + '\n'); }))(USAGE);
  return 1;
}

export default async function main(argv: readonly string[]): Promise<number> { return runInstall(argv); }
