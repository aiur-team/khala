import * as fs from 'node:fs/promises';
import path from 'node:path';
import { ensureStateDir, writeJsonAtomic } from '../state';
import { qwenControllerFile, qwenHome } from '../wake/qwen-socket';

export const QWEN_WATCH_PERMISSION = 'Bash(khala watch --harness qwen --session *)';
const suffix = ' hook deliver --harness qwen';
export const QWEN_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop'] as const;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const ours = (server: unknown) => object(server) && Array.isArray(server.args)
  && server.args.includes('mcp') && server.args.indexOf('--harness') !== -1
  && server.args[server.args.indexOf('--harness') + 1] === 'qwen';

/** Validate before any install side effect; preserve unrelated MCP entries and hook groups. */
export function mergeQwenSettings(config: unknown, entry: object | null, command: string | null, backgroundWake = false):
  { config: Record<string, unknown> } | { error: 'invalid_config' | 'qwen_mcp_exists' } {
  if (!object(config) || config.mcpServers !== undefined && !object(config.mcpServers)
    || config.hooks !== undefined && !object(config.hooks)) return { error: 'invalid_config' };
  const servers = { ...(config.mcpServers as Record<string, unknown> ?? {}) };
  if (Object.hasOwn(servers, 'khala') && !ours(servers.khala)) return { error: 'qwen_mcp_exists' };
  const hooks: Record<string, unknown[]> = {};
  for (const [event, groups] of Object.entries(config.hooks as Record<string, unknown> ?? {})) {
    if (!Array.isArray(groups)) return { error: 'invalid_config' };
    const kept = [];
    for (const group of groups) {
      if (!object(group) || !Array.isArray(group.hooks) || group.hooks.some(h => !object(h))) return { error: 'invalid_config' };
      const handlers = group.hooks.filter(h => !(typeof h.command === 'string' && h.command.endsWith(suffix)));
      if (handlers.length) kept.push({ ...group, hooks: handlers });
    }
    if (kept.length) hooks[event] = kept;
  }
  delete servers.khala;
  if (entry) servers.khala = entry;
  if (command) for (const event of QWEN_HOOK_EVENTS) {
    hooks[event] = [...(hooks[event] ?? []), { ...(event === 'PostToolUse' ? { matcher: '.*' } : {}),
      hooks: [{ type: 'command', command, timeout: 10 }] }];
  }
  const next = { ...config, mcpServers: servers, hooks };
  if (backgroundWake) {
    if (config.permissions !== undefined && !object(config.permissions)) return { error: 'invalid_config' };
    const permissions = { ...(config.permissions as Record<string, unknown> ?? {}) };
    if (permissions.allow !== undefined && (!Array.isArray(permissions.allow) || permissions.allow.some(rule => typeof rule !== 'string'))) return { error: 'invalid_config' };
    const allow = (permissions.allow as string[] ?? []).filter(rule => rule !== QWEN_WATCH_PERMISSION);
    if (command) allow.push(QWEN_WATCH_PERMISSION);
    permissions.allow = allow;
    Object.assign(next, { permissions });
  }
  return { config: next };
}

export async function installQwen(input: {
  env: NodeJS.ProcessEnv; backgroundWake?: boolean; entry: object; command: string; uninstall: boolean;
  install?: () => boolean; mint?: () => { id: string; token: string } | undefined;
  stdout: (line: string) => void; stderr: (line: string) => void;
}): Promise<number> {
  const file = path.join(qwenHome(input.env), 'settings.json');
  let before: string | undefined;
  try { before = await fs.readFile(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  let config;
  try { config = before?.trim() ? JSON.parse(before.replace(/^\uFEFF/u, '')) : {}; }
  catch { input.stderr('khala: invalid Qwen settings.json'); return 1; }
  const merged = mergeQwenSettings(config, input.uninstall ? null : input.entry, input.uninstall ? null : input.command, input.backgroundWake);
  if ('error' in merged) { input.stderr(`khala: ${merged.error}`); return 1; }
  if (!input.uninstall && input.install && !input.install()) { input.stderr('khala: npm install failed'); return 1; }
  if (!input.uninstall && input.mint) {
    const credentialFile = qwenControllerFile(input.env);
    let existing;
    try { existing = JSON.parse(await fs.readFile(credentialFile, 'utf8')); } catch { /* mint below */ }
    const credential = /^qpc_[0-9a-f]{64}$/u.test(existing?.token ?? '') ? existing : input.mint();
    if (!credential || typeof credential.id !== 'string' || !/^qpc_[0-9a-f]{64}$/u.test(credential.token)) {
      input.stderr('khala: could not mint Qwen controller credential'); return 1;
    }
    await ensureStateDir(path.dirname(credentialFile));
    await writeJsonAtomic(credentialFile, credential);
    await fs.chmod(credentialFile, 0o600);
  }
  if (!input.uninstall || before !== undefined) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    if (!input.uninstall && before !== undefined) {
      try { await fs.writeFile(file + '.khala-bak', before, { flag: 'wx', mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    }
    await fs.writeFile(file, JSON.stringify(merged.config, null, 2) + '\n', { mode: 0o600 });
  }
  if (input.uninstall) await fs.rm(qwenControllerFile(input.env), { force: true });
  input.stdout(input.uninstall ? 'removed Khala Qwen MCP server, hooks, and local controller credential' : 'configured Qwen; restart or resume Qwen to load Khala');
  return 0;
}
