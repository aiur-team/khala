import * as fs from 'node:fs/promises';
import nodePath from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { renderMuseSkill, MUSE_SKILL_MARKER } from './muse-skill';
import { museWatchCommand } from '../wake/muse-monitor';
import { cursorPaths, type CursorPlatform } from './cursor';

export type MusePaths = { settingsFile: string; prefix: string; script: string; bin: string; stateHome: string; dataHome: string; customEnv: NodeJS.ProcessEnv };
const SUFFIX = ' hook deliver --harness muse';
export const MUSE_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop'] as const;
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export function musePaths(input: CursorPlatform, packageName = 'khala-cli'): MusePaths {
  const { prefix, script } = cursorPaths(input, packageName);
  const configHome = input.env.XDG_CONFIG_HOME && input.path.isAbsolute(input.env.XDG_CONFIG_HOME)
    ? input.env.XDG_CONFIG_HOME : input.path.join(input.home, '.config');
  const stateHome = input.env.XDG_STATE_HOME && input.path.isAbsolute(input.env.XDG_STATE_HOME)
    ? input.env.XDG_STATE_HOME : input.path.join(input.home, '.local', 'state');
  const dataHome = input.env.XDG_DATA_HOME && input.path.isAbsolute(input.env.XDG_DATA_HOME)
    ? input.env.XDG_DATA_HOME : input.path.join(input.home, '.local', 'share');
  const customEnv: NodeJS.ProcessEnv = {};
  if (input.env.XDG_STATE_HOME) customEnv.XDG_STATE_HOME = stateHome;
  if (input.env.XDG_DATA_HOME) customEnv.XDG_DATA_HOME = dataHome;
  const bin = input.platform === 'win32' ? input.path.join(prefix, 'khala.cmd') : input.path.join(prefix, 'bin', 'khala');
  return { stateHome, dataHome, customEnv, bin, settingsFile: input.path.join(configHome, 'muse', 'settings.json'), prefix, script };
}
const quote = (value: string) => /^[A-Za-z0-9_./:-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
export function museHookCommand(platform: NodeJS.Platform, bin: string, roots?: Pick<MusePaths, 'stateHome' | 'dataHome'>): string {
  const pathQuote = platform === 'win32' ? (value: string) => `"${value.replaceAll('\\', '/')}"` : quote;
  const flags = roots ? ` --state-home ${pathQuote(roots.stateHome)} --data-home ${pathQuote(roots.dataHome)}` : '';
  return `${platform === 'win32' ? 'cmd /c ' : ''}${pathQuote(bin)}${SUFFIX}${flags}`;
}
export function museMcpEntry(platform: NodeJS.Platform, bin: string, env: NodeJS.ProcessEnv = {}) {
  return { transport: 'stdio', command: platform === 'win32' ? 'cmd' : bin,
    args: [...(platform === 'win32' ? ['/c', bin] : []), 'mcp', '--harness', 'muse'], env };
}
const ours = (entry: unknown) => object(entry) && Array.isArray(entry.args)
  && entry.args.includes('mcp') && entry.args[entry.args.indexOf('--harness') + 1] === 'muse';

/** Both accepted MCP spellings are preserved; never write a competing second table. */
export function mergeMuseSettings(config: unknown, entry: object | null, command: string | null, original?: Record<string, unknown>):
  { config: Record<string, unknown> } | { error: 'invalid_config' | 'muse_mcp_exists' } {
  if (!object(config) || (config.schema_version !== undefined && config.schema_version !== 1)) return { error: 'invalid_config' };
  const keys = ['mcp_servers', 'mcpServers'].filter(key => Object.hasOwn(config, key));
  for (const key of keys) {
    const servers = config[key];
    if (!object(servers)) return { error: 'invalid_config' };
    if (entry && Object.hasOwn(servers, 'khala') && !ours(servers.khala)) return { error: 'muse_mcp_exists' };
  }
  const hooks = Object.hasOwn(config, 'hooks') ? config.hooks : {};
  if (!object(hooks)) return { error: 'invalid_config' };
  const nextHooks: Record<string, unknown[]> = {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) return { error: 'invalid_config' };
    const kept = [];
    for (const group of groups) {
      if (!object(group) || !Array.isArray(group.hooks) || group.hooks.some(item => !object(item))) return { error: 'invalid_config' };
      const handlers = group.hooks.filter(item => !(typeof item.command === 'string' && (item.command.endsWith(SUFFIX) || item.command.includes(SUFFIX + ' --state-home '))));
      if (handlers.length || handlers.length === group.hooks.length) kept.push({ ...group, hooks: handlers });
    }
    const wasEmpty = object(original?.hooks) && Array.isArray(original.hooks[event]) && original.hooks[event].length === 0;
    if (kept.length || (groups.length === 0 && command !== null) || wasEmpty) nextHooks[event] = kept;
  }
  if (command) for (const event of MUSE_HOOK_EVENTS) {
    nextHooks[event] = [...nextHooks[event] ?? [], { hooks: [{ type: 'command', command, timeout: 10 }] }];
  }
  const next: Record<string, unknown> = { ...config };
  if (Object.keys(nextHooks).length || object(original?.hooks)) next.hooks = nextHooks;
  else delete next.hooks;
  const target = keys.includes('mcp_servers') ? 'mcp_servers' : keys[0] ?? 'mcp_servers';
  for (const key of new Set([...keys, target])) {
    const servers = { ...(config[key] as Record<string, unknown> | undefined) };
    if (ours(servers.khala)) delete servers.khala;
    if (key === target && entry) servers.khala = entry;
    if (Object.keys(servers).length || entry !== null || object(original?.[key])) next[key] = servers;
    else delete next[key];
  }
  return { config: next };
}

export async function installMuse(input: {
  paths: MusePaths; platform: NodeJS.Platform; node: string; uninstall: boolean;
  install?: () => boolean; stdout: (line: string) => void; stderr: (line: string) => void;
}): Promise<number> {
  const { paths, uninstall, stdout, stderr } = input;
  let before: string | null = null;
  let config: unknown = { schema_version: 1 };
  try { before = await fs.readFile(paths.settingsFile, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (before !== null) {
    try { config = JSON.parse(before.replace(/^\uFEFF/u, '')); } catch { config = undefined; }
  }
  const backupFile = paths.settingsFile + '.khala-bak';
  const metadataFile = paths.settingsFile + '.khala-meta';
  let skillsParentCreated = false;
  if (uninstall) {
    try { skillsParentCreated = JSON.parse(await fs.readFile(metadataFile, 'utf8')).skillsParentCreated === true; }
    catch (error) { if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  let backup: string | null = null;
  let original: Record<string, unknown> | undefined;
  if (uninstall) {
    try { backup = await fs.readFile(backupFile, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (backup !== null) {
      // An empty backup records that installation created settings; existing empty files are refused.
      try {
        const parsed: unknown = backup === '' ? {} : JSON.parse(backup.replace(/^\uFEFF/u, ''));
        if (object(parsed)) original = parsed;
      } catch { /* An unreadable backup must never replace the user's current settings. */ }
    }
  }
  const merged = mergeMuseSettings(config, uninstall ? null : museMcpEntry(input.platform, paths.bin, paths.customEnv),
    uninstall ? null : museHookCommand(input.platform, paths.bin, paths), original);
  if ('config' in merged && uninstall && backup === '' && merged.config.schema_version === 1) delete merged.config.schema_version;
  if ('error' in merged) {
    stderr(merged.error === 'muse_mcp_exists'
      ? `khala: ${paths.settingsFile} already has a "khala" server that is not this CLI; remove it and run this again`
      : `khala: invalid Muse settings in ${paths.settingsFile}; repair the file and run this again (nothing written)`);
    return 1;
  }
  const skillFile = nodePath.join(nodePath.dirname(paths.settingsFile), 'skills', 'khala', 'SKILL.md');
  let skill: string | null = null;
  try { skill = await fs.readFile(skillFile, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (!uninstall && skill !== null && !skill.includes(MUSE_SKILL_MARKER)) {
    stderr(`khala: ${skillFile} already exists and is not managed by this CLI; move it and run this again (nothing written)`);
    return 1;
  }
  if (uninstall && before === null && skill === null) {
    await fs.rm(backupFile, { force: true });
    await fs.rm(metadataFile, { force: true });
    return 0;
  }
  if (!uninstall && input.install && !input.install()) return 1;
  await fs.mkdir(nodePath.dirname(paths.settingsFile), { recursive: true });
  if (!uninstall) {
    const skillsParent = nodePath.dirname(nodePath.dirname(skillFile));
    try { await fs.stat(skillsParent); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; skillsParentCreated = true; }
    try { await fs.writeFile(metadataFile, JSON.stringify({ skillsParentCreated }), { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    try { await fs.writeFile(backupFile, before ?? '', { flag: 'wx', mode: 0o600 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  if (uninstall) {
    if (skill?.includes(MUSE_SKILL_MARKER)) {
      await fs.unlink(skillFile);
      try { await fs.rmdir(nodePath.dirname(skillFile)); }
      catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
      if (skillsParentCreated) {
        try { await fs.rmdir(nodePath.dirname(nodePath.dirname(skillFile))); }
        catch (error) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
      }
    }
  } else {
    await fs.mkdir(nodePath.dirname(skillFile), { recursive: true });
    const nextSkill = renderMuseSkill(museWatchCommand(undefined, paths.bin));
    if (skill !== nextSkill) await fs.writeFile(skillFile, nextSkill, { mode: 0o600 });
  }
  const style = uninstall && backup !== null && backup !== '' ? backup : before;
  const indent = style?.match(/\n([ \t]+)"/u)?.[1];
  const newline = style === null || style?.endsWith('\n') ? '\n' : '';
  const text = uninstall && backup !== null && backup !== '' && original && isDeepStrictEqual(merged.config, original)
    ? backup : (style?.startsWith('\uFEFF') ? '\uFEFF' : '') + JSON.stringify(merged.config, null, indent ?? (style === null ? 2 : undefined)) + newline;
  if (uninstall && backup === '' && Object.keys(merged.config).length === 0) {
    await fs.rm(paths.settingsFile, { force: true });
  } else if (text !== before && (!uninstall || before !== null)) {
    await fs.writeFile(paths.settingsFile, text, { mode: 0o600 });
  }
  if (uninstall) {
    await fs.rm(backupFile, { force: true });
    await fs.rm(metadataFile, { force: true });
  }
  stdout(uninstall ? `removed Khala from ${paths.settingsFile}; delete ${paths.prefix} to remove the CLI`
    : `configured ${paths.settingsFile}; restart or resume Muse, then ask it to join your Khala channel`);
  return 0;
}
