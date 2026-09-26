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
    const [name, ...args] = argv;
    const command = commands.resolve(name);
    if (command === undefined) throw new CliError('invalid_arguments');
    return await command.run(args, deps);
  } catch (error) {
    await write(deps.stderr, JSON.stringify({ ok: false, error: cliErrorCode(error) }) + '\n');
    return 2;
  }
}
