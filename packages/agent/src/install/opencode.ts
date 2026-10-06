import * as fs from 'node:fs/promises';
import { cursorPaths, type CursorPlatform } from './cursor';
import { ManagedFiles, formatJson, jsonFormat } from './managed-file';

export type OpenCodePaths = { configDir: string; configFile: string; prefix: string; bin: string };

/** OpenCode uses XDG config paths on every OS, including native Windows. */
export function opencodePaths(input: CursorPlatform): OpenCodePaths {
  const { path, home, env, platform } = input;
  const configHome = env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME)
    ? env.XDG_CONFIG_HOME : path.join(home, '.config');
  const configDir = path.join(configHome, 'opencode');
  const { prefix } = cursorPaths(input);
  return { configDir, configFile: path.join(configDir, 'opencode.json'), prefix,
    bin: platform === 'win32' ? path.join(prefix, 'khala.cmd') : path.join(prefix, 'bin', 'khala') };
}

/** MCP-only fallback when the matching plugin has not been published. */
export function opencodeMcpEntry(platform: NodeJS.Platform, bin: string) {
  return { type: 'local', command: [...(platform === 'win32' ? ['cmd', '/c'] : []), bin, 'mcp', '--harness', 'opencode'],
    environment: {}, enabled: true };
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isPlugin = (spec: string) => spec === 'khala-opencode' || spec.startsWith('khala-opencode@')
  || /^file:.*[/\\]khala-opencode-[^/\\]+\.tgz$/u.test(spec);
const isMcp = (entry: unknown) => {
  if (!isObject(entry) || !Array.isArray(entry.command)) return false;
  const at = entry.command.indexOf('--harness');
  return entry.command.includes('mcp') && at >= 0 && entry.command[at + 1] === 'opencode';
};

/** Replaces our pin and removes our MCP entry, preserving sibling settings. */
export function mergeOpenCodeConfig(config: unknown, plugin: string | null, previousOverride?: string):
  { config: Record<string, unknown> } | { error: 'invalid_config' } {
  if (!isObject(config) || config.plugin !== undefined && (!Array.isArray(config.plugin) || config.plugin.some(p => typeof p !== 'string'))
    || config.mcp !== undefined && !isObject(config.mcp)) return { error: 'invalid_config' };
  const plugins = ((config.plugin ?? []) as string[]).filter(spec => !isPlugin(spec) && spec !== previousOverride && spec !== plugin);
  if (plugin) plugins.push(plugin);
  const next: Record<string, unknown> = { ...config };
  if (plugins.length) next.plugin = plugins;
  else delete next.plugin;
  if (isObject(config.mcp) && isMcp(config.mcp.khala)) {
    const mcp = { ...config.mcp };
    delete mcp.khala;
    if (Object.keys(mcp).length) next.mcp = mcp;
    else delete next.mcp;
  }
  return { config: next };
}

export async function installOpenCode(input: {
  paths: OpenCodePaths; plugin: string | null; platform: NodeJS.Platform; uninstall: boolean; install?: () => boolean;
  /** Khala's state directory, where the original config file is recorded. */
  stateDir: string;
  stdout: (line: string) => void; stderr: (line: string) => void;
}): Promise<number> {
  const { paths, uninstall, stdout, stderr } = input;
  let configFile = paths.configFile.replace(/\.json$/u, '.jsonc');
  let text: string | null = null;
  try { text = await fs.readFile(configFile, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    configFile = paths.configFile;
    try { text = await fs.readFile(configFile, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  if (configFile !== paths.configFile) {
    let jsonExists = false;
    try { await fs.stat(paths.configFile); jsonExists = true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (jsonExists) {
      stderr(`khala: both ${paths.configFile} and ${configFile} exist; ${uninstall ? 'remove' : 'merge'} the Khala config manually, or combine your settings into one config and remove the other before retrying`);
      return 1;
    }
  }
  let config: unknown;
  // Strict JSON accepts OpenCode's generated schema-only JSONC while refusing
  // comments and other syntax we cannot preserve when serializing the merge.
  try { config = text?.trim() ? JSON.parse(text.replace(/^\uFEFF/u, '')) : {}; }
  catch {
    stderr(configFile.endsWith('.jsonc')
      ? `khala: opencode.jsonc exists in ${paths.configDir} and is not plain JSON; ${uninstall ? 'remove' : 'merge'} the Khala config manually or convert it to opencode.json before retrying`
      : `khala: invalid JSON in ${configFile}`);
    return 1;
  }
  // Remember an arbitrary test override so reinstall/uninstall can remove it without
  // guessing ownership from a local tarball's filename.
  const marker = paths.configFile + '.khala-plugin';
  let previousOverride: string | undefined;
  try { previousOverride = (await fs.readFile(marker, 'utf8')).trim(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const merged = mergeOpenCodeConfig(config, uninstall ? null : input.plugin, previousOverride ?? input.plugin ?? undefined);
  if ('error' in merged) { stderr(`khala: invalid config in ${configFile}`); return 1; }
  if (!uninstall && input.plugin === null) {
    if (isObject(config) && isObject(config.mcp) && Object.hasOwn(config.mcp, 'khala') && !isMcp(config.mcp.khala)) {
      stderr(`khala: refusing to overwrite existing mcp.khala in ${configFile}; remove or rename it before retrying`);
      return 1;
    }
    merged.config.mcp = { ...(merged.config.mcp as Record<string, unknown> | undefined), khala: opencodeMcpEntry(input.platform, paths.bin) };
  }
  if (!uninstall && input.install && !input.install()) return 1;
  const managed = new ManagedFiles(input.stateDir);
  const current = { file: configFile, text };
  if (uninstall) {
    // The marker goes first so a config directory Khala created is empty when restored.
    await fs.rm(marker, { force: true });
    await managed.restore(current, jsonFormat, value => (mergeOpenCodeConfig(value, null, previousOverride) as { config: unknown }).config);
    if (text === null) return 0;
  } else {
    await managed.write([{ current, text: formatJson(merged.config, text) }]);
    if (input.plugin === null) await fs.rm(marker, { force: true });
    else await fs.writeFile(marker, input.plugin + '\n');
  }
  stdout(uninstall ? `removed the Khala plugin and MCP entry from ${configFile}; delete ${paths.prefix} to remove the CLI`
    : input.plugin ? `configured ${configFile}; restart OpenCode to load the Khala plugin`
      : 'OpenCode installed in MCP-only mode (Async, no wake); re-run khala install opencode after updating');
  return 0;
}

/** Probe only the exact CLI version; registry failures safely select MCP-only mode. */
export async function opencodePluginPublished(version: string, fetchRegistry: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetchRegistry(`https://registry.npmjs.org/khala-opencode/${encodeURIComponent(version)}`, { signal: AbortSignal.timeout(3000) });
    return response.ok;
  } catch { return false; }
}
