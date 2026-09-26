import { connectCommand } from './commands/connect.js';
import { listenCommand } from './commands/listen.js';
import { mcpServeCommand } from './commands/mcp-serve.js';
import { modeCommand } from './commands/mode.js';
import { readCommand } from './commands/read.js';
import { sendCommand } from './commands/send.js';
import { statusCommand } from './commands/status.js';
import type { CliCommand } from './types.js';

const COMMAND_NAME = /^[a-z][a-z0-9-]*$/;

export class CommandRegistryError extends Error {
  constructor(readonly reason: 'invalid_name' | 'duplicate_command', readonly commandName: string) {
    super(`${reason}: ${commandName}`);
    this.name = 'CommandRegistryError';
  }
}

export type CommandRegistry = Readonly<{
  /** Returns the registered command, or `undefined` for any name that is not registered. */
  resolve(name: string | undefined): CliCommand | undefined;
  names(): readonly string[];
}>;

/** Fails loudly on a malformed or duplicate name; a registry never drops or overrides an entry. */
export function createCommandRegistry(commands: readonly CliCommand[]): CommandRegistry {
  const byName = new Map<string, CliCommand>();
  for (const command of commands) {
    if (!COMMAND_NAME.test(command.name)) throw new CommandRegistryError('invalid_name', command.name);
    if (byName.has(command.name)) throw new CommandRegistryError('duplicate_command', command.name);
    byName.set(command.name, command);
  }
  const names = Object.freeze([...byName.keys()]);
  return Object.freeze({
    resolve: (name: string | undefined) => (name === undefined ? undefined : byName.get(name)),
    names: () => names,
  });
}

/** Built-in commands. A new command is one file under `commands/` plus one line here. */
export const CLI_COMMANDS: readonly CliCommand[] = Object.freeze([
  connectCommand,
  listenCommand,
  modeCommand,
  readCommand,
  sendCommand,
  statusCommand,
  mcpServeCommand,
]);

export const commandRegistry: CommandRegistry = createCommandRegistry(CLI_COMMANDS);
