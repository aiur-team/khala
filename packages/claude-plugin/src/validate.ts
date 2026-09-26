import fs from 'node:fs';
import path from 'node:path';
import { FROZEN_HOOK_EVENTS, FROZEN_MCP_SERVER, FROZEN_PLUGIN_NAME, FROZEN_WATCHER_SCRIPT } from './contract';

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
  return errors;
}
