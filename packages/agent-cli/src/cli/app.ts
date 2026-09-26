import { INTERNAL_CLIENT_COMMANDS, extractInternalDescriptor } from './descriptor-option.js';
import { CliError, cliErrorCode } from './errors.js';
import { commandRegistry, type CommandRegistry } from './registry.js';
import { write } from './runtime.js';
import type { CliDependencies } from './types.js';

export type { CliDependencies } from './types.js';
export { readStdin } from './runtime.js';

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
    if (selected.descriptorPath === null) return await command.run(args, deps);
    if (!INTERNAL_CLIENT_COMMANDS.has(command.name)) throw new CliError('invalid_arguments');
    if (!deps.internalClient) throw new CliError('internal_unavailable');
    const client = await deps.internalClient(selected.descriptorPath);
    return await command.run(args, { ...deps, client });
  } catch (error) {
    await write(deps.stderr, JSON.stringify({ ok: false, error: cliErrorCode(error) }) + '\n');
    return 2;
  }
}
