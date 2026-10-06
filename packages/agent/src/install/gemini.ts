import * as fs from 'node:fs/promises';
import type { CursorPlatform } from './cursor';
import { cursorPaths } from './cursor';
import { nodeScriptCommand } from './command';

export const GEMINI_HOOK_EVENTS = ['SessionStart', 'BeforeAgent', 'AfterTool', 'AfterAgent'] as const;
const HOOK_SUFFIX = ' hook deliver --harness gemini';
export function geminiPaths(input: CursorPlatform, packageName = 'khala-cli') {
  // All harness installers share the stable global npm package layout.
  const { prefix, script } = cursorPaths(input, packageName);
  const geminiDir = input.path.join(input.home, '.gemini');
  return { geminiDir, settingsFile: input.path.join(geminiDir, 'settings.json'), prefix, script };
}
export function geminiHookCommand(platform: NodeJS.Platform, node: string, script: string): string {
  return nodeScriptCommand(platform, node, script) + HOOK_SUFFIX;
}
export function geminiMcpEntry(node: string, script: string, trustTools = false) {
  return { command: node, args: [script, 'mcp', '--harness', 'gemini'], ...(trustTools ? { trust: true } : {}) };
}
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Replaces our nested hook handlers and MCP entry while preserving all sibling settings. */
export function mergeGeminiSettings(config: unknown, entry: object | null, command: string | null):
  { config: Record<string, unknown> } | { error: 'invalid_config' | 'gemini_mcp_exists' } {
  if (!isObject(config)) return { error: 'invalid_config' };
  const servers = config.mcpServers ?? {};
  const hooks = config.hooks ?? {};
  if (!isObject(servers) || !isObject(hooks)) return { error: 'invalid_config' };
  if (Object.hasOwn(servers, 'khala')) {
    const current = servers.khala;
    if (!isObject(current) || !Array.isArray(current.args) || !current.args.includes('mcp')
      || current.args.indexOf('--harness') === -1 || current.args[current.args.indexOf('--harness') + 1] !== 'gemini') return { error: 'gemini_mcp_exists' };
  }
  const nextServers = { ...servers };
  delete nextServers.khala;
  if (entry) nextServers.khala = entry;
  const nextHooks: Record<string, unknown> = {};
  for (const [event, groups] of Object.entries(hooks)) {
    // Gemini also stores the global hooks.enabled switch in this object.
    if (event === 'enabled' && typeof groups === 'boolean') { nextHooks[event] = groups; continue; }
    if (!Array.isArray(groups)) return { error: 'invalid_config' };
    const kept = [];
    for (const group of groups) {
      if (!isObject(group) || !Array.isArray(group.hooks) || group.hooks.some(handler => !isObject(handler))) return { error: 'invalid_config' };
      const handlers = group.hooks.filter(handler => !(typeof handler.command === 'string' && handler.command.endsWith(HOOK_SUFFIX)));
      if (handlers.length || group.hooks.length === 0) kept.push({ ...group, hooks: handlers });
    }
    if (kept.length || groups.length === 0) nextHooks[event] = kept;
  }
  if (command) for (const event of GEMINI_HOOK_EVENTS) {
    nextHooks[event] = [...(nextHooks[event] as unknown[] | undefined ?? []),
      { matcher: '*', hooks: [{ type: 'command', name: 'khala', command, timeout: 10_000 }] }];
  }
  return { config: { ...config, mcpServers: nextServers, hooks: nextHooks } };
}

export async function installGemini(input: {
  paths: ReturnType<typeof geminiPaths>; platform: NodeJS.Platform; node: string; uninstall: boolean; trustTools: boolean;
  install?: () => boolean; stdout: (line: string) => void; stderr: (line: string) => void;
}): Promise<number> {
  const { paths, uninstall, stdout, stderr } = input;
  let before: string | null = null;
  try { before = await fs.readFile(paths.settingsFile, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  let config: unknown = {};
  if (before?.trim()) { try { config = JSON.parse(before.replace(/^\uFEFF/u, '')); } catch { config = undefined; } }
  const merged = mergeGeminiSettings(config, uninstall ? null : geminiMcpEntry(input.node, paths.script, input.trustTools),
    uninstall ? null : geminiHookCommand(input.platform, input.node, paths.script));
  if ('error' in merged) {
    stderr(merged.error === 'gemini_mcp_exists'
      ? `khala: ${paths.settingsFile} already has a foreign "khala" MCP server; remove it and run this again`
      : `khala: invalid JSON or hooks in ${paths.settingsFile}`);
    return 1;
  }
  if (uninstall) {
    // The backup supplies only container provenance, never settings to restore:
    // users may have added siblings since installation. Without it, preserve
    // existing containers rather than guessing whether Khala introduced them.
    let original = config;
    try {
      const backup: unknown = JSON.parse((await fs.readFile(paths.settingsFile + '.khala-bak', 'utf8')).replace(/^\uFEFF/u, ''));
      if (isObject(backup)) original = backup;
    } catch (error) {
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (isObject(original)) for (const key of ['mcpServers', 'hooks']) {
      const container = merged.config[key];
      if (!Object.hasOwn(original, key) && isObject(container) && Object.keys(container).length === 0) delete merged.config[key];
    }
  }
  if (!uninstall && input.install && !input.install()) return 1;
  if (!(uninstall && before === null)) {
    await fs.mkdir(paths.geminiDir, { recursive: true });
    if (!uninstall && before !== null) {
      try { await fs.writeFile(paths.settingsFile + '.khala-bak', before, { flag: 'wx' }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    const text = JSON.stringify(merged.config, null, 2) + '\n';
    if (text !== before) await fs.writeFile(paths.settingsFile, text);
  }
  if (uninstall) stdout(`removed the Khala MCP server and hooks from ${paths.settingsFile}; delete ${paths.prefix} to remove the CLI`);
  else {
    stdout(`configured ${paths.settingsFile}; restart Gemini CLI to load Khala`);
    if (input.trustTools) stdout('trust: true auto-approves all Khala tools, including khala_send and khala_join');
    else stdout('Gemini will ask before each Khala tool call; use --trust-tools to auto-approve');
  }
  return 0;
}
