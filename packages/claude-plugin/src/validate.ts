import fs from 'node:fs';
import path from 'node:path';
import { FROZEN_HOOK_EVENTS, FROZEN_MCP_SERVER, FROZEN_PLUGIN_NAME } from './contract';

type Json = Record<string, unknown>;

const readJson = (root: string, relative: string): Json =>
  JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8')) as Json;

const hookCommands = (entries: unknown): string[] =>
  (Array.isArray(entries) ? entries : []).flatMap(entry =>
    ((entry as { hooks?: unknown[] }).hooks ?? []).map(hook => String((hook as { command?: unknown }).command ?? '')));

/** Every way the plugin directory departs from the frozen contract; empty means it conforms. */
export function validatePlugin(root: string): string[] {
  const errors: string[] = [];
  const plugin = readJson(root, '.claude-plugin/plugin.json');
  if (plugin.name !== FROZEN_PLUGIN_NAME) errors.push(`plugin name must be ${FROZEN_PLUGIN_NAME}`);

  const hooks = (readJson(root, 'hooks/hooks.json').hooks ?? {}) as Json;
  for (const event of Object.keys(hooks)) {
    if (!Object.hasOwn(FROZEN_HOOK_EVENTS, event)) errors.push(`hook event ${event} is not in the frozen list`);
  }
  for (const [event, script] of Object.entries(FROZEN_HOOK_EVENTS)) {
    const commands = hookCommands(hooks[event]);
    if (!commands.some(command => command.includes(script))) errors.push(`hook event ${event} must run ${script}`);
    if (!fs.existsSync(path.join(root, script))) errors.push(`missing hook script ${script}`);
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
