// `khala install cursor`: pure path and JSON merge helpers plus the file I/O around them.
// Paths go through an injected `path` flavour so tests can check Windows layouts on Linux.
import * as fs from 'node:fs/promises';
import nodePath from 'node:path';
import { CURSOR_WORKSPACE_ENV } from '../cursor';

type PathApi = Pick<typeof nodePath, 'join' | 'isAbsolute'>;
export type CursorPlatform = { platform: NodeJS.Platform; path: PathApi; home: string; env: NodeJS.ProcessEnv };
export type CursorPaths = { cursorDir: string; mcpFile: string; hooksFile: string; prefix: string; script: string };

export const CURSOR_HOOK_EVENTS = ['beforeSubmitPrompt', 'postToolUse', 'stop'] as const;
const HOOK_SUFFIX = ' hook deliver --harness cursor';

/**
 * Where Cursor reads its user config (`~/.cursor`, `%USERPROFILE%\.cursor` on Windows) and
 * where this package is installed. npm's global layout differs: `<prefix>/lib/node_modules`
 * on POSIX, `<prefix>\node_modules` on Windows.
 */
export function cursorPaths({ platform, path, home, env }: CursorPlatform, packageName = 'khala-cli'): CursorPaths {
  const cursorDir = path.join(home, '.cursor');
  const windows = platform === 'win32';
  const dataHome = windows
    ? (env.LOCALAPPDATA && path.isAbsolute(env.LOCALAPPDATA) ? env.LOCALAPPDATA : path.join(home, 'AppData', 'Local'))
    : (env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.join(home, '.local', 'share'));
  const prefix = path.join(dataHome, 'khala', 'npm');
  const modules = windows ? path.join(prefix, 'node_modules') : path.join(prefix, 'lib', 'node_modules');
  return {
    cursorDir, prefix,
    mcpFile: path.join(cursorDir, 'mcp.json'),
    hooksFile: path.join(cursorDir, 'hooks.json'),
    script: path.join(modules, ...packageName.split('/'), 'dist', 'khala.mjs'),
  };
}

/** POSIX single quotes. */
const posixQuote = (value: string): string => /^[A-Za-z0-9_./:-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * The hook command line. Cursor runs hooks through a shell: PowerShell on Windows (bash when
 * Git Bash's MSYSTEM leaks in), sh on macOS/Linux. On Windows the command therefore starts
 * with bare `node` (a quoted program path is a string, not a call, in PowerShell) and the
 * script path uses forward slashes inside double quotes, which PowerShell, cmd and bash all
 * read the same way. Elsewhere both paths are absolute so a GUI-launched Cursor without the
 * user's shell PATH still finds Node.
 */
export function cursorHookCommand(platform: NodeJS.Platform, node: string, script: string): string {
  if (platform === 'win32') return `node "${script.replaceAll('\\', '/')}"${HOOK_SUFFIX}`;
  return `${posixQuote(node)} ${posixQuote(script)}${HOOK_SUFFIX}`;
}

export function cursorMcpEntry(node: string, script: string) {
  return {
    type: 'stdio',
    command: node,
    args: [script, 'mcp', '--harness', 'cursor'],
    env: { [CURSOR_WORKSPACE_ENV]: '${workspaceFolder}' },
  };
}

/** The `npx` form, for the install deeplink and hand-written configs (MCP only, no hooks). */
export function cursorNpxEntry(spec: string) {
  return { command: 'npx', args: ['-y', spec, 'mcp', '--harness', 'cursor'], env: { [CURSOR_WORKSPACE_ENV]: '${workspaceFolder}' } };
}

export function cursorDeeplink(spec: string): string {
  const config = Buffer.from(JSON.stringify(cursorNpxEntry(spec)), 'utf8').toString('base64');
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=khala&config=${encodeURIComponent(config)}`;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A `khala` server that runs this CLI for Cursor, however it was written (installer, deeplink, by hand). */
function isKhalaCursorServer(entry: unknown): boolean {
  if (!isObject(entry) || !Array.isArray(entry.args)) return false;
  const args = entry.args as unknown[];
  const at = args.indexOf('--harness');
  return args.includes('mcp') && at !== -1 && args[at + 1] === 'cursor';
}

/** Sets (install) or removes (uninstall) `mcpServers.khala`, leaving every other server alone. */
export function mergeCursorMcp(config: unknown, entry: object | null): { config: Record<string, unknown> } | { error: 'invalid_config' | 'cursor_mcp_exists' } {
  if (!isObject(config)) return { error: 'invalid_config' };
  const servers = config.mcpServers ?? {};
  if (!isObject(servers)) return { error: 'invalid_config' };
  if (Object.hasOwn(servers, 'khala') && !isKhalaCursorServer(servers.khala)) return { error: 'cursor_mcp_exists' };
  const next: Record<string, unknown> = { ...servers };
  delete next.khala;
  if (entry) next.khala = entry;
  return { config: { ...config, mcpServers: next } };
}

/**
 * Replaces (install) or removes (uninstall) this CLI's three handlers in a parsed Cursor
 * hooks.json. A handler is ours when its command ends in `hook deliver --harness cursor`,
 * so a reinstall from another Node or prefix replaces the old line instead of adding one.
 */
export function mergeCursorHooks(config: unknown, command: string | null): { config: Record<string, unknown> } | { error: 'invalid_config' } {
  if (!isObject(config)) return { error: 'invalid_config' };
  const hooks = config.hooks ?? {};
  if (!isObject(hooks) || Object.values(hooks).some(list => !Array.isArray(list) || list.some(item => !isObject(item)))) return { error: 'invalid_config' };
  const ours = (item: Record<string, unknown>) => typeof item.command === 'string' && item.command.endsWith(HOOK_SUFFIX);
  const next: Record<string, unknown> = {};
  for (const [event, list] of Object.entries(hooks as Record<string, Record<string, unknown>[]>)) {
    const kept = list.filter(item => !ours(item));
    if (kept.length) next[event] = kept;
  }
  if (command) {
    for (const event of CURSOR_HOOK_EVENTS) next[event] = [...(next[event] as unknown[] | undefined ?? []), { command, timeout: 10 }];
  }
  return { config: { version: 1, ...config, hooks: next } };
}

async function readJsonFile(file: string): Promise<{ text: string | null; value: unknown }> {
  let text: string;
  try { text = await fs.readFile(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { text: null, value: {} }; throw error; }
  if (!text.trim()) return { text, value: {} };
  try { return { text, value: JSON.parse(text.replace(/^﻿/u, '')) }; } catch { return { text, value: undefined }; }
}

export type CursorInstallInput = {
  paths: CursorPaths; platform: NodeJS.Platform; node: string; uninstall: boolean;
  /** Installs the package into `paths.prefix`; absent on uninstall. */
  install?: () => boolean;
  stdout: (line: string) => void; stderr: (line: string) => void;
};

export async function installCursor(input: CursorInstallInput): Promise<number> {
  const { paths, uninstall, stdout, stderr } = input;
  const mcp = await readJsonFile(paths.mcpFile);
  const hooks = await readJsonFile(paths.hooksFile);
  const command = cursorHookCommand(input.platform, input.node, paths.script);
  const nextMcp = mergeCursorMcp(mcp.value, uninstall ? null : cursorMcpEntry(input.node, paths.script));
  if ('error' in nextMcp) {
    stderr(nextMcp.error === 'cursor_mcp_exists'
      ? `khala: ${paths.mcpFile} already has a "khala" server that is not this CLI; remove it and run this again`
      : `khala: invalid JSON in ${paths.mcpFile}`);
    return 1;
  }
  const nextHooks = mergeCursorHooks(hooks.value, uninstall ? null : command);
  if ('error' in nextHooks) { stderr(`khala: invalid JSON in ${paths.hooksFile}`); return 1; }
  if (!uninstall && input.install && !input.install()) return 1;
  await fs.mkdir(paths.cursorDir, { recursive: true });
  for (const [file, before, after] of [[paths.mcpFile, mcp.text, nextMcp.config], [paths.hooksFile, hooks.text, nextHooks.config]] as const) {
    if (uninstall && before === null) continue;
    // The first install keeps the user's original file; later runs never overwrite it.
    if (!uninstall && before !== null) {
      try { await fs.writeFile(file + '.khala-bak', before, { flag: 'wx' }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    const text = JSON.stringify(after, null, 2) + '\n';
    if (text !== before) await fs.writeFile(file, text);
  }
  if (uninstall) {
    stdout(`removed the Khala MCP server and hooks from ${paths.cursorDir}; delete ${paths.prefix} to remove the CLI`);
  } else {
    stdout(`configured ${paths.mcpFile} and ${paths.hooksFile}`);
    stdout('restart Cursor (or toggle "khala" off and on in Settings > MCP), then check that khala shows its five tools');
  }
  return 0;
}
