import type { CursorPlatform } from './cursor';
import { cursorPaths } from './cursor';
import { nodeScriptCommand } from './command';
import { ManagedFiles, formatJson, jsonFormat, readManaged, type ManagedFormat } from './managed-file';

const HOOK_EVENTS = ['PreInvocation', 'Stop'] as const;
const HOOK_SUFFIX = ' hook deliver --harness antigravity --event ';
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
/** JSONC is accepted by agy; strings containing comment characters remain strings. */
export const antigravityFormat: ManagedFormat = {
  ...jsonFormat,
  parse(text) {
    const plain = text.replace(/^\uFEFF/u, '')
      .replace(/"(?:\\.|[^"\\])*"|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//gu, match => match.startsWith('"') ? match : ' ')
      .replace(/"(?:\\.|[^"\\])*"|,(?=\s*[}\]])/gu, match => match === ',' ? '' : match);
    return plain.trim() ? JSON.parse(plain) : {};
  },
};
export function antigravityPaths(input: CursorPlatform, packageName = 'khala-cli') {
  const { prefix, script } = cursorPaths(input, packageName);
  const configDir = input.path.join(input.home, '.gemini', 'config');
  return { prefix, script, mcpFile: input.path.join(configDir, 'mcp_config.json'), hooksFile: input.path.join(configDir, 'hooks.json') };
}
export function antigravityHooks(platform: NodeJS.Platform, node: string, script: string) {
  const command = nodeScriptCommand(platform, node, script) + HOOK_SUFFIX;
  return Object.fromEntries(HOOK_EVENTS.map(event =>
    [event, [{ type: 'command', command: command + event, timeout: 10 }]]));
}
function ownedEntry(value: unknown): boolean {
  return isObject(value) && Array.isArray(value.args) && value.args.includes('mcp') && value.args.includes('--harness')
    && value.args[value.args.indexOf('--harness') + 1] === 'antigravity';
}
function ownedHook(value: unknown): boolean {
  return isObject(value) && HOOK_EVENTS.every(event => Array.isArray(value[event])
    && (value[event] as unknown[]).every(handler => isObject(handler) && typeof handler.command === 'string'
      && handler.command.endsWith(HOOK_SUFFIX + event)))
    && Object.keys(value).every(key => HOOK_EVENTS.some(event => event === key));
}
export function mergeAntigravity(config: unknown, kind: 'mcp' | 'hooks', value: object | null): Record<string, unknown> {
  if (!isObject(config)) throw new Error('invalid_config');
  const container = kind === 'mcp' ? config.mcpServers ?? {} : config;
  if (!isObject(container)) throw new Error('invalid_config');
  if (Object.hasOwn(container, 'khala') && !(kind === 'mcp' ? ownedEntry(container.khala) : ownedHook(container.khala)))
    throw new Error('antigravity_foreign_khala');
  const next = { ...container };
  delete next.khala;
  if (value) next.khala = value;
  // Do not invent a missing MCP container during uninstall without provenance.
  return kind === 'mcp' ? { ...config, ...(Object.hasOwn(config, 'mcpServers') || value ? { mcpServers: next } : {}) } : next;
}
export async function installAntigravity(input: {
  paths: ReturnType<typeof antigravityPaths>; platform: NodeJS.Platform; node: string; uninstall: boolean; stateDir: string;
  install?: () => boolean; stdout: (line: string) => void; stderr: (line: string) => void;
}): Promise<number> {
  const { paths, uninstall, stdout, stderr } = input;
  const entries = [];
  for (const [file, kind, value] of [
    [paths.mcpFile, 'mcp', { command: input.node, args: [paths.script, 'mcp', '--harness', 'antigravity'] }],
    [paths.hooksFile, 'hooks', antigravityHooks(input.platform, input.node, paths.script)],
  ] as const) {
    const current = await readManaged(file);
    try {
      const config = mergeAntigravity(antigravityFormat.parse(current.text ?? ''), kind, uninstall ? null : value);
      entries.push({ current, kind, text: formatJson(config, current.text), mode: 0o600 });
    } catch {
      stderr(`khala: invalid config or a foreign khala entry in ${file}; resolve it before retrying`);
      return 1;
    }
  }
  if (!uninstall && input.install && !input.install()) return 1;
  const managed = new ManagedFiles(input.stateDir);
  if (uninstall) for (const entry of entries)
    await managed.restore(entry.current, antigravityFormat, value => mergeAntigravity(value, entry.kind, null));
  else await managed.write(entries);
  stdout(uninstall ? `removed the Khala MCP server and hooks; delete ${paths.prefix} to remove the CLI`
    : `configured ${paths.mcpFile} and ${paths.hooksFile}; restart Antigravity CLI to load Khala`);
  if (!uninstall) {
    stdout('These config files are shared with Antigravity desktop and IDE; their Khala hooks and MCP entry are installed too.');
    stdout('Native idle wake and Sync continuation start billed model turns. After joining and at each session start, run npx -y khala-cli wake register --harness antigravity through the agent shell.');
  }
  return 0;
}
