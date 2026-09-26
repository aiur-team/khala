import fs from 'node:fs';
import path from 'node:path';
import {
  CLAUDE_MCP_ENV, FROZEN_HOOK_EVENTS, FROZEN_MCP_SERVER, FROZEN_PLUGIN_NAME, FROZEN_SKILL_NAME, FROZEN_WATCHER_SCRIPT, SKILL_FILE,
} from './contract';

type Json = Record<string, unknown>;

const readJson = (root: string, relative: string): Json =>
  JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8')) as Json;

type Hook = { command?: unknown; asyncRewake?: unknown };

const hookEntries = (entries: unknown): Hook[] =>
  (Array.isArray(entries) ? entries : []).flatMap(entry => (entry as { hooks?: Hook[] }).hooks ?? []);

/** Every way the plugin directory departs from the frozen contract; empty means it conforms. */
export function validatePlugin(root: string): string[] {
  const errors: string[] = [];
  const plugin = readJson(root, '.claude-plugin/plugin.json');
  if (plugin.name !== FROZEN_PLUGIN_NAME) errors.push(`plugin name must be ${FROZEN_PLUGIN_NAME}`);

  const hooks = (readJson(root, 'hooks/hooks.json').hooks ?? {}) as Json;
  for (const event of Object.keys(hooks)) {
    if (!Object.hasOwn(FROZEN_HOOK_EVENTS, event)) errors.push(`hook event ${event} is not in the frozen list`);
  }
  for (const [event, scripts] of Object.entries(FROZEN_HOOK_EVENTS)) {
    const registered = hookEntries(hooks[event]);
    for (const script of scripts) {
      const hook = registered.find(entry => String(entry.command ?? '').includes(script));
      if (!hook) errors.push(`hook event ${event} must run ${script}`);
      else if ((script === FROZEN_WATCHER_SCRIPT) !== (hook.asyncRewake === true)) {
        errors.push(`${script} must ${script === FROZEN_WATCHER_SCRIPT ? '' : 'not '}set asyncRewake`);
      }
      if (!fs.existsSync(path.join(root, script))) errors.push(`missing hook script ${script}`);
    }
  }

  const servers = (readJson(root, '.mcp.json').mcpServers ?? {}) as Record<string, Json>;
  const names = Object.keys(servers);
  if (names.length !== 1 || names[0] !== FROZEN_MCP_SERVER.name) {
    errors.push(`the only MCP entry must be ${FROZEN_MCP_SERVER.name}`);
  }
  const server = servers[FROZEN_MCP_SERVER.name];
  if (server && (server.command !== FROZEN_MCP_SERVER.command
    || JSON.stringify(server.args) !== JSON.stringify(FROZEN_MCP_SERVER.args))) {
    errors.push(`MCP entry ${FROZEN_MCP_SERVER.name} must run ${FROZEN_MCP_SERVER.command} ${FROZEN_MCP_SERVER.args.join(' ')}`);
  }
  if (server && JSON.stringify(server.env) !== JSON.stringify(CLAUDE_MCP_ENV)) {
    errors.push(`MCP entry ${FROZEN_MCP_SERVER.name} must set only ${Object.keys(CLAUDE_MCP_ENV).join(', ')}`);
  }

  const skillPath = path.join(root, SKILL_FILE);
  if (!fs.existsSync(skillPath)) {
    errors.push(`missing bundled skill ${SKILL_FILE}`);
  } else if (/^name:\s*(\S+)\s*$/m.exec(fs.readFileSync(skillPath, 'utf8').split(/^---$/m)[1] ?? '')?.[1] !== FROZEN_SKILL_NAME) {
    errors.push(`bundled skill must be named ${FROZEN_SKILL_NAME}`);
  }
  return errors;
}
