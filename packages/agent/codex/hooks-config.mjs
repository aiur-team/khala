// Pure Codex hooks.json merge, shared by codex/install-hooks.mjs (checkout, plain Node)
// and `khala install codex` (published bundle). No I/O here.
import fragment from '../hooks/hooks.codex.json' with { type: 'json' };

/** The Khala hook groups, with `command` substituted for the PATH-based default. */
export function codexHooksFragment(command = 'khala hook deliver --harness codex') {
  const hooks = {};
  for (const [event, groups] of Object.entries(fragment.hooks)) {
    hooks[event] = groups.map(group => ({ ...group, hooks: group.hooks.map(hook => ({ ...hook, command })) }));
  }
  return { hooks };
}

/**
 * Adds (install) or removes (uninstall) the fragment's handlers in a parsed hooks.json,
 * preserving every other handler. Returns warnings for old Khala handlers. Throws
 * `invalid_hooks_config` on a malformed config.
 */
export function mergeCodexHooks(config, action, hooksFragment = codexHooksFragment()) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('invalid_hooks_config');
  config.hooks ??= {};
  if (typeof config.hooks !== 'object' || Array.isArray(config.hooks)) throw new Error('invalid_hooks_config');
  for (const groups of Object.values(config.hooks)) {
    if (!Array.isArray(groups) || groups.some(group => !group || !Array.isArray(group.hooks))) {
      throw new Error('invalid_hooks_config');
    }
  }
  const commands = new Set(Object.values(hooksFragment.hooks).flatMap(groups => groups.flatMap(group => group.hooks.map(hook => hook.command))));
  const warnings = [];
  if (action === 'install') {
    for (const [event, groups] of Object.entries(hooksFragment.hooks)) {
      const existing = config.hooks[event] ??= [];
      for (const group of groups) {
        if (!existing.some(item => item.hooks.some(hook => hook.command === group.hooks[0].command))) existing.push(group);
      }
    }
    for (const groups of Object.values(config.hooks)) {
      for (const group of groups) {
        for (const hook of group.hooks) {
          if (typeof hook.command === 'string' && hook.command.endsWith(' codex-hook')) {
            warnings.push('warning: remove old Khala handler: ' + hook.command);
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
  return { config, warnings };
}
