import { deliveringInbox } from '../composition/delivering-inbox.js';
import { INTERNAL_CLIENT_COMMANDS, extractInternalDescriptor } from './descriptor-option.js';
import { CliError, cliErrorCode } from './errors.js';
import { commandRegistry, type CommandRegistry } from './registry.js';
import { write } from './runtime.js';
import type { CliDependencies } from './types.js';

export type { CliDependencies } from './types.js';
export { readStdin } from './runtime.js';

/** Commands that read the inbox; only these pull releases into it. `status` only inspects. */
const DELIVERING_COMMANDS: ReadonlySet<string> = new Set(['read', 'listen', 'mcp-serve']);

export async function runCli(
  argv: readonly string[],
  deps: CliDependencies,
  commands: CommandRegistry = commandRegistry,
): Promise<number> {
  try {
    const selected = extractInternalDescriptor(argv);
    const [name, ...args] = selected.argv;
    const command = commands.resolve(name);
    if (command === undefined) throw new CliError('invalid_arguments');
    const { descriptorPath } = selected;
    if (descriptorPath === null) return await command.run(args, deps);
    if (!INTERNAL_CLIENT_COMMANDS.has(command.name)) throw new CliError('invalid_arguments');
    if (!deps.internalClient) throw new CliError('internal_unavailable');
    const client = await deps.internalClient(descriptorPath);
    if (!deps.internalDelivery || !DELIVERING_COMMANDS.has(command.name)) return await command.run(args, { ...deps, client, sessionGrants: undefined });
    // Releases reach the inbox only while a command that reads it is running.
    const delivering = deliveringInbox(deps.inbox, await deps.internalDelivery(descriptorPath),
      deps.signal ? { signal: deps.signal } : {});
    try {
      return await command.run(args, { ...deps, client, inbox: delivering.inbox, sessionGrants: undefined });
    } finally {
      await delivering.stop();
    }
  } catch (error) {
    await write(deps.stderr, JSON.stringify({ ok: false, error: cliErrorCode(error) }) + '\n');
    return 2;
  }
}
