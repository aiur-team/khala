import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { codexHooksFragment, mergeCodexHooks } from '../../codex/hooks-config.mjs';
import { bundle } from '../bundle';
import { runMcpInstall } from './mcp';
import { adapterFor } from '../harness';
import { cursorPaths, installCursor } from './cursor';
import { opencodePaths, installOpenCode, opencodePluginPublished } from './opencode';

export const MCP_MARKER = '# Khala MCP server, managed by `khala install codex`';
const USAGE = 'usage: khala install codex [--codex-home <dir>] [--uninstall] | khala install cursor [--uninstall] | khala install opencode [--uninstall] | khala install mcp --print [--harness <id>]';

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
    paths, platform, node: deps.node ?? process.execPath, uninstall, stdout, stderr,
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
  return installOpenCode({ paths, platform, uninstall, stdout, stderr, plugin,
    install: () => {
      stdout(`installing ${spec} into ${paths.prefix}`);
      if ((deps.npmInstall ?? defaultNpmInstall)(paths.prefix, spec)) return true;
      stderr('khala: npm install failed for ' + spec);
      return false;
    },
  });
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

async function readOr(file: string, fallback: string): Promise<{ text: string; mode: number }> {
  try { return { text: await fs.readFile(file, 'utf8'), mode: (await fs.stat(file)).mode & 0o777 }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { text: fallback, mode: 0o600 }; throw error; }
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
  const hooks = await readOr(hooksFile, '{"hooks":{}}\n');
  const toml = await readOr(tomlFile, '');
  let parsed: unknown;
  try { parsed = JSON.parse(hooks.text); } catch { stderr('khala: invalid hooks.json in ' + codexHome); return 1; }
  let merged: { config: unknown; warnings: string[] };
  try { merged = mergeCodexHooks(parsed, uninstall ? 'uninstall' : 'install', codexHooksFragment(command)); }
  catch { stderr('khala: invalid hooks.json in ' + codexHome); return 1; }
  const nextToml = updateCodexToml(toml.text, uninstall ? null : codexMcpBlock(bin, env));
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
  await fs.mkdir(codexHome, { recursive: true });
  if (!uninstall) {
    try { await fs.writeFile(hooksFile + '.khala-bak', hooks.text, { flag: 'wx', mode: hooks.mode }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  for (const warning of merged.warnings) stderr(warning);
  await fs.writeFile(hooksFile, JSON.stringify(merged.config, null, 2) + '\n', { mode: hooks.mode });
  await fs.writeFile(tomlFile, nextToml.text, { mode: toml.mode });
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
  if (run) return run(flags, deps);
  (deps.stderr ?? (line => { process.stderr.write(line + '\n'); }))(USAGE);
  return 1;
}

export default async function main(argv: readonly string[]): Promise<number> { return runInstall(argv); }
