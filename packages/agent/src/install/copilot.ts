// `khala install copilot`: pure path and JSON merge helpers plus the file I/O around them.
// Paths go through an injected `path` flavour so tests can check Windows layouts on Linux.
import { ManagedFiles, readManaged, formatJson, jsonFormat, type ManagedRead } from './managed-file';
import nodePath from 'node:path';

type PathApi = Pick<typeof nodePath, 'join' | 'isAbsolute'>;
export type CopilotPlatform = { platform: NodeJS.Platform; path: PathApi; home: string; env: NodeJS.ProcessEnv };
export type CopilotPaths = { copilotDir: string; mcpFile: string; hooksFile: string; prefix: string; script: string };

export const COPILOT_HOOK_EVENTS = ['sessionStart', 'userPromptSubmitted', 'postToolUse', 'agentStop'] as const;
const HOOK_SUFFIX = ' hook deliver --harness copilot';

export function copilotPaths({ platform, path, home, env }: CopilotPlatform, packageName = 'khala-cli'): CopilotPaths {
  const copilotDir = env.COPILOT_HOME && path.isAbsolute(env.COPILOT_HOME) ? env.COPILOT_HOME : path.join(home, '.copilot');
  const windows = platform === 'win32';
  const dataHome = windows
    ? (env.LOCALAPPDATA && path.isAbsolute(env.LOCALAPPDATA) ? env.LOCALAPPDATA : path.join(home, 'AppData', 'Local'))
    : (env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.join(home, '.local', 'share'));
  const prefix = path.join(dataHome, 'khala', 'npm');
  const modules = windows ? path.join(prefix, 'node_modules') : path.join(prefix, 'lib', 'node_modules');
  return {
    copilotDir, prefix,
    mcpFile: path.join(copilotDir, 'mcp-config.json'),
    hooksFile: path.join(copilotDir, 'hooks', 'khala.json'),
    script: path.join(modules, ...packageName.split('/'), 'dist', 'khala.mjs'),
  };
}

/** Quote each hook shell independently. */
const bashQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const powershellQuote = (value: string) => "'" + value.replaceAll("'", "''") + "'";
export function copilotHookCommands(node: string, script: string, event: string) {
  const suffix = `${HOOK_SUFFIX} --event ${event}`;
  return { bash: `${bashQuote(node.replaceAll('\\', '/'))} ${bashQuote(script.replaceAll('\\', '/'))}${suffix}`,
    powershell: `& ${powershellQuote(node)} ${powershellQuote(script)}${suffix}` };
}
export function copilotMcpEntry(node: string, script: string) {
  return { type: 'local', command: node, args: [script, 'mcp', '--harness', 'copilot'], tools: ['*'] };
}
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
export function mergeCopilotMcp(config: unknown, entry: object | null): { config: Record<string, unknown> } | { error: 'invalid_config' | 'copilot_mcp_exists' } {
  if (!isObject(config)) return { error: 'invalid_config' };
  const servers = config.mcpServers ?? {};
  if (!isObject(servers)) return { error: 'invalid_config' };
  if (Object.hasOwn(servers, 'khala')) {
    const existing = servers.khala;
    const harnessAt = isObject(existing) && Array.isArray(existing.args) ? existing.args.indexOf('--harness') : -1;
    if (!isObject(existing) || !Array.isArray(existing.args) || !existing.args.includes('mcp')
      || harnessAt < 0 || existing.args[harnessAt + 1] !== 'copilot') return { error: 'copilot_mcp_exists' };
  }
  const next = { ...servers };
  delete next.khala;
  if (entry) next.khala = entry;
  return { config: { ...config, mcpServers: next } };
}

const isCopilotHook = (item: Record<string, unknown>) => [item.bash, item.powershell].some(command =>
  typeof command === 'string' && COPILOT_HOOK_EVENTS.some(event => command.endsWith(`${HOOK_SUFFIX} --event ${event}`)));

export function mergeCopilotHooks(config: unknown, commands: { node: string; script: string } | null): { config: Record<string, unknown> } | { error: 'invalid_config' } {
  if (!isObject(config)) return { error: 'invalid_config' };
  const hooks = config.hooks ?? {};
  if (!isObject(hooks) || Object.values(hooks).some(list => !Array.isArray(list) || list.some(item => !isObject(item)))) return { error: 'invalid_config' };
  const next: Record<string, unknown> = {};
  for (const [event, list] of Object.entries(hooks as Record<string, Record<string, unknown>[]>)) {
    const kept = list.filter(item => !isCopilotHook(item));
    if (kept.length) next[event] = kept;
  }
  if (commands) {
    for (const event of COPILOT_HOOK_EVENTS) next[event] = [...(next[event] as unknown[] | undefined ?? []), { type: 'command', ...copilotHookCommands(commands.node, commands.script, event), timeoutSec: 10 }];
  }
  return { config: { version: 1, ...config, hooks: next } };
}

async function readJsonFile(file: string): Promise<ManagedRead & { value: unknown }> {
  const current = await readManaged(file);
  try { return { ...current, value: jsonFormat.parse(current.text ?? '') }; } catch { return { ...current, value: undefined }; }
}

export type CopilotInstallInput = {
  paths: CopilotPaths; node: string; uninstall: boolean;
  /** Khala state directory holding exact config originals. */
  stateDir: string;
  /** Installs the package into `paths.prefix`; absent on uninstall. */
  install?: () => boolean;
  stdout: (line: string) => void; stderr: (line: string) => void;
};

export async function installCopilot(input: CopilotInstallInput): Promise<number> {
  const { paths, uninstall, stdout, stderr } = input;
  const mcp = await readJsonFile(paths.mcpFile);
  const hooks = await readJsonFile(paths.hooksFile);
  const nextMcp = mergeCopilotMcp(mcp.value, uninstall ? null : copilotMcpEntry(input.node, paths.script));
  if ('error' in nextMcp) {
    stderr(nextMcp.error === 'copilot_mcp_exists'
      ? `khala: ${paths.mcpFile} already has a "khala" server that is not this CLI; remove it and run this again`
      : `khala: invalid JSON in ${paths.mcpFile}`);
    return 1;
  }
  const nextHooks = mergeCopilotHooks(hooks.value, uninstall ? null : { node: input.node, script: paths.script });
  if ('error' in nextHooks) { stderr(`khala: invalid JSON in ${paths.hooksFile}`); return 1; }
  if (!uninstall && input.install && !input.install()) return 1;
  const managed = new ManagedFiles(input.stateDir);
  if (uninstall) {
    await managed.restore(mcp, jsonFormat, value => (mergeCopilotMcp(value, null) as { config: unknown }).config);
    await managed.restore(hooks, jsonFormat, (value, original) => {
      const { config } = mergeCopilotHooks(value, null) as { config: Record<string, unknown> };
      const hadVersion = isObject(original) && Object.hasOwn(original, 'version');
      if (!hadVersion && isObject(config.hooks) && !Object.keys(config.hooks).length) delete config.version;
      return config;
    });
  } else {
    await managed.write([
      { current: mcp, text: formatJson(nextMcp.config, mcp.text) },
      { current: hooks, text: formatJson(nextHooks.config, hooks.text) },
    ]);
  }
  if (uninstall) {
    stdout(`removed the Khala MCP server and hooks from ${paths.copilotDir}; delete ${paths.prefix} to remove the CLI`);
  } else {
    stdout(`configured ${paths.mcpFile} and ${paths.hooksFile}`);
    stdout('restart Copilot CLI, join a Khala channel, then send one prompt to enable terminal wakes; idle wakes spend AI credits');
  }
  return 0;
}
