import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ensureStateDir, stateRoot } from '../state';
import { ManagedFiles, formatJson, jsonFormat, readManaged } from './managed-file';
import { qwenControllerFile, qwenHome } from '../wake/qwen-socket';

export const QWEN_WATCH_PERMISSION = 'Bash(khala watch --harness qwen --session *)';
const suffix = ' hook deliver --harness qwen';
export const QWEN_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop'] as const;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const ours = (server: unknown) => object(server) && Array.isArray(server.args)
  && server.args.includes('mcp') && server.args.indexOf('--harness') !== -1
  && server.args[server.args.indexOf('--harness') + 1] === 'qwen';

/** Validate before any install side effect; preserve unrelated MCP entries and hook groups. */
export function mergeQwenSettings(config: unknown, entry: object | null, command: string | null, backgroundWake = false, watchCommand = 'khala watch --harness qwen', watchPermission = `Bash(${watchCommand} --session *)`, previousPermission?: string):
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
  const next: Record<string, unknown> = { ...config };
  delete next.mcpServers; delete next.hooks;
  if (Object.keys(servers).length) next.mcpServers = servers;
  if (Object.keys(hooks).length) next.hooks = hooks;
  if (backgroundWake) {
    if (config.permissions !== undefined && !object(config.permissions)) return { error: 'invalid_config' };
    const permissions = { ...(config.permissions as Record<string, unknown> ?? {}) };
    if (permissions.allow !== undefined && (!Array.isArray(permissions.allow) || permissions.allow.some(rule => typeof rule !== 'string'))) return { error: 'invalid_config' };
    const allow = (permissions.allow as string[] ?? []).filter(rule => rule !== QWEN_WATCH_PERMISSION);
    const permission = watchPermission;
    const scoped = allow.filter(rule => rule !== permission && rule !== previousPermission);
    if (command) scoped.push(permission);
    permissions.allow = scoped;
    Object.assign(next, { permissions });
  }
  return { config: next };
}

export async function installQwen(input: {
  env: NodeJS.ProcessEnv; backgroundWake?: boolean; watchCommand?: string; watchPermission?: string; entry: object; command: string; uninstall: boolean;
  install?: () => boolean; mint?: () => { id: string; token: string } | undefined;
  list?: () => string[] | undefined; remove?: (id: string) => boolean;
  stdout: (line: string) => void; stderr: (line: string) => void;
}): Promise<number> {
  const file = path.join(qwenHome(input.env), 'settings.json');
  const current = await readManaged(file);
  const before = current.text;
  const managed = new ManagedFiles(stateRoot(input.env));
  let config;
  try { config = before?.trim() ? JSON.parse(before.replace(/^\uFEFF/u, '')) : {}; }
  catch { input.stderr('khala: invalid Qwen settings.json'); return 1; }
  const watchFile = path.join(path.dirname(qwenControllerFile(input.env)), 'watch-command.json');
  let previousPermission: string | undefined;
  try {
    const previous = JSON.parse(await fs.readFile(watchFile, 'utf8'));
    // Remove only the exact rule recorded by our earlier install.
    if (typeof previous.command === 'string') previousPermission = typeof previous.permission === 'string'
      ? previous.permission : `Bash(${previous.command} --session *)`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      input.stderr('khala: invalid saved Qwen watcher command'); return 1;
    }
  }
  const merged = mergeQwenSettings(config, input.uninstall ? null : input.entry, input.uninstall ? null : input.command, input.backgroundWake, input.watchCommand, input.watchPermission, previousPermission);
  if ('error' in merged) { input.stderr(`khala: ${merged.error}`); return 1; }
  const credentialFile = qwenControllerFile(input.env);
  const registryFile = path.join(qwenHome(input.env), 'peer-controllers.json');
  let minted: { id: string; token: string } | undefined;
  try {
    // XDG_STATE_HOME may be shared; only Khala-owned directories must be private.
    if (!input.uninstall && (input.mint || input.backgroundWake)) {
      await ensureStateDir(path.dirname(credentialFile));
    }
    if (!input.uninstall && input.install && !input.install()) { input.stderr('khala: npm install failed'); return 1; }
    if (!input.uninstall && input.mint) {
      // Qwen's CLI creates the registry (and potentially QWEN_HOME) during mint.
      // Record both originals first, including directory ownership, across reinstalls.
      await managed.record(file);
      await managed.record(registryFile);
      let existing;
      try {
        const stat = await fs.lstat(credentialFile);
        if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error('unsafe credential');
        existing = JSON.parse(await fs.readFile(credentialFile, 'utf8'));
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const ids = input.list?.();
      if (input.list && !ids) throw new Error('controller listing failed');
      const reusable = typeof existing?.id === 'string' && /^qpc_[0-9a-f]{64}$/u.test(existing?.token ?? '')
        && (!input.list || ids!.includes(existing.id));
      const credential = reusable ? existing : (minted = input.mint());
      if (!credential || typeof credential.id !== 'string' || !/^qpc_[0-9a-f]{64}$/u.test(credential.token)) throw new Error('mint failed');
      const temporary = credentialFile + '.tmp-' + randomUUID();
      try {
        await fs.writeFile(temporary, JSON.stringify(credential) + '\n', { mode: 0o600, flag: 'wx' });
        await fs.rename(temporary, credentialFile);
      } finally { await fs.rm(temporary, { force: true }); }
      await fs.chmod(credentialFile, 0o600);
    }
    if (input.uninstall) {
      let credential;
      try { credential = JSON.parse(await fs.readFile(credentialFile, 'utf8')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      const activeIds = input.list?.();
      if (typeof credential?.id === 'string' && (!activeIds || activeIds.includes(credential.id)) && input.remove && !input.remove(credential.id)) {
        input.stderr('khala: could not revoke Qwen controller; credential retained for retry'); return 1;
      }
      // Qwen owns registry edits. Restore exact original bytes when equivalent;
      // remove only a recorded, newly created empty registry with the known schema.
      // Unknown fields and subsequent user changes stay byte-for-byte as Qwen left them.
      if (await managed.original(registryFile) !== undefined) {
        await managed.restore(await readManaged(registryFile), {
          ...jsonFormat, prune: value => value,
          serialize: (_value, like) => like ?? '',
          empty: value => object(value) && value.schemaVersion === 1
            && Array.isArray(value.controllers) && value.controllers.length === 0
            && Object.keys(value).every(key => key === 'schemaVersion' || key === 'controllers'),
        }, value => value);
      }
      await managed.restore(current, jsonFormat, (value, original) => {
        const removed = mergeQwenSettings(value, null, null, input.backgroundWake, input.watchCommand, input.watchPermission, previousPermission);
        if ('error' in removed) throw new Error(removed.error);
        // Empty containers that predate Khala belong to the user.
        for (const key of ['mcpServers', 'hooks']) {
          if (object(original) && object(original[key]) && !Object.keys(original[key]).length
            && !Object.hasOwn(removed.config, key)) removed.config[key] = original[key];
        }
        return removed.config;
      });
    } else {
      await managed.write([{ current, text: formatJson(merged.config, before), mode: 0o600 }]);
    }
    if (input.backgroundWake) {
      if (input.uninstall) await fs.rm(watchFile, { force: true });
      else if (input.watchCommand) {
        await fs.mkdir(path.dirname(watchFile), { recursive: true, mode: 0o700 });
        await fs.writeFile(watchFile, JSON.stringify({ command: input.watchCommand, permission: input.watchPermission ?? `Bash(${input.watchCommand} --session *)` }) + '\n', { mode: 0o600 });
      }
    }
    if (input.uninstall) {
      await fs.rm(credentialFile, { force: true });
    }
  } catch {
    if (minted) {
      if (input.remove?.(minted.id)) await fs.rm(credentialFile, { force: true });
      else {
        await fs.writeFile(credentialFile, JSON.stringify(minted) + '\n', { mode: 0o600 });
        input.stderr('khala: controller rollback failed; retry install qwen --uninstall to revoke the retained credential');
      }
    }
    input.stderr('khala: Qwen installation failed; check private state directories and controller availability'); return 1;
  }
  input.stdout(input.uninstall ? 'removed Khala Qwen MCP server, hooks, and local controller credential' : 'configured Qwen; restart or resume Qwen to load Khala');
  return 0;
}
