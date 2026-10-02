import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function main() {
  const [action, flag, home, ...extra] = process.argv.slice(2);
  if (!['install', 'uninstall'].includes(action) || extra.length
    || (flag !== undefined && (flag !== '--codex-home' || !home))) {
    throw new Error('usage: install-hooks.mjs install|uninstall [--codex-home <dir>]');
  }
  const directory = home ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const file = path.join(directory, 'hooks.json');
  let original = '{"hooks":{}}\n';
  let mode = 0o600;
  try {
    original = await fs.readFile(file, 'utf8');
    mode = (await fs.stat(file)).mode & 0o777;
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const config = JSON.parse(original);
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('invalid_hooks_config');
  config.hooks ??= {};
  if (typeof config.hooks !== 'object' || Array.isArray(config.hooks)) throw new Error('invalid_hooks_config');
  for (const groups of Object.values(config.hooks)) {
    if (!Array.isArray(groups) || groups.some(group => !group || !Array.isArray(group.hooks))) {
      throw new Error('invalid_hooks_config');
    }
  }
  const fragment = JSON.parse(await fs.readFile(new URL('../hooks/hooks.codex.json', import.meta.url), 'utf8'));
  const commands = new Set(Object.values(fragment.hooks).flatMap(groups => groups.flatMap(group => group.hooks.map(hook => hook.command))));
  if (action === 'install') {
    await fs.mkdir(directory, { recursive: true });
    try { await fs.writeFile(file + '.khala-bak', original, { flag: 'wx', mode }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    for (const [event, groups] of Object.entries(fragment.hooks)) {
      const existing = config.hooks[event] ??= [];
      for (const group of groups) {
        if (!existing.some(item => item.hooks.some(hook => hook.command === group.hooks[0].command))) existing.push(group);
      }
    }
    for (const groups of Object.values(config.hooks)) {
      for (const group of groups) {
        for (const hook of group.hooks) {
          if (typeof hook.command === 'string' && hook.command.endsWith(' codex-hook')) {
            console.error('warning: remove old Khala handler: ' + hook.command);
          }
        }
      }
    }
  } else {
    for (const [event, groups] of Object.entries(config.hooks)) {
      const remaining = groups.flatMap(group => {
        const hooks = group.hooks.filter(hook => !commands.has(hook.command));
        if (hooks.length === group.hooks.length) return [group];
        return hooks.length ? [{ ...group, hooks }] : [];
      });
      if (remaining.length === groups.length && remaining.every((group, index) => group === groups[index])) continue;
      if (remaining.length) config.hooks[event] = remaining;
      else delete config.hooks[event];
    }
  }
  await fs.writeFile(file, JSON.stringify(config, null, 2) + '\n', { mode });
  console.log(action === 'install' ? 'installed; restart or resume Codex and trust the Khala hooks' : 'uninstalled');
}
main().catch(() => { console.error('hooks_install_failed'); process.exitCode = 1; });
