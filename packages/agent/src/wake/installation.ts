import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse } from 'smol-toml';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
async function text(file: string): Promise<string | undefined> {
  try { return await readFile(file, 'utf8'); } catch { return undefined; }
}

/** Read installation evidence without creating harness config or running its CLI. */
export async function nativeWakeInstallation(harness: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const home = env.HOME ?? os.homedir();
  if (harness === 'codex') {
    const dir = env.CODEX_HOME && path.isAbsolute(env.CODEX_HOME) ? env.CODEX_HOME : path.join(home, '.codex');
    try {
      const config = parse(await text(path.join(dir, 'config.toml')) ?? '');
      const servers = config.mcp_servers;
      const entry = object(servers) ? servers.khala : undefined;
      if (object(entry) && entry.enabled !== false && typeof entry.command === 'string'
        && Array.isArray(entry.args) && entry.args.includes('mcp')
        && entry.args.indexOf('--harness') >= 0 && entry.args[entry.args.indexOf('--harness') + 1] === 'codex') return;
    } catch { /* Malformed config cannot establish installation. */ }
    try {
      const config: unknown = JSON.parse(await text(path.join(dir, 'hooks.json')) ?? '{}');
      if (object(config) && object(config.hooks) && Object.values(config.hooks).some(groups => Array.isArray(groups)
        && groups.some(group => object(group) && Array.isArray(group.hooks) && group.hooks.some(hook => object(hook)
          && typeof hook.command === 'string' && /\bkhala(?:[.]cmd)?["']?\s+hook\s+deliver\s+--harness\s+codex\b/u.test(hook.command))))) return;
    } catch { /* Malformed hooks cannot establish installation. */ }
  } else if (harness === 'opencode') {
    const dir = path.join(env.XDG_CONFIG_HOME && path.isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : path.join(home, '.config'), 'opencode');
    const marker = (await text(path.join(dir, 'opencode.json.khala-plugin')))?.trim();
    for (const file of ['opencode.jsonc', 'opencode.json']) {
      try {
        const config: unknown = JSON.parse((await text(path.join(dir, file)) ?? '{}').replace(/^\uFEFF/u, ''));
        if (!object(config)) continue;
        if (Array.isArray(config.plugin) && config.plugin.some(spec => typeof spec === 'string'
          && (spec === 'khala-opencode' || spec.startsWith('khala-opencode@') || spec === marker
            || /^file:.*[/\\]khala-opencode-[^/\\]+\.tgz$/u.test(spec)))) return;
        if (object(config.mcp) && object(config.mcp.khala) && config.mcp.khala.enabled !== false)
          return 'OpenCode has only the Khala MCP entry; native wake requires the Khala plugin.';
      } catch { /* Invalid config cannot establish plugin installation. */ }
    }
  } else return;
  return `Khala is not installed for ${harness}; run khala install ${harness}.`;
}
