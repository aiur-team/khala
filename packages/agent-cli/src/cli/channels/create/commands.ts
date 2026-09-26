import { CliError } from '../../errors.js';
import { write } from '../../runtime.js';
import type { CliDependencies } from '../../types.js';
import { validOperationArgument } from '../access.js';
import { validOriginArgument } from '../service.js';
import { ChannelCreateService, createExitCode, parseCreateTitle } from './service.js';

/** `khala channels create --title <title> --operation <id> [--origin <trusted-origin>]` */
export async function createChannel(args: readonly string[], deps: CliDependencies): Promise<number> {
  const flags = parseFlags(args, ['--title', '--operation', '--origin']);
  const title = parseCreateTitle(flags.get('--title'));
  const operationId = flags.get('--operation');
  const origin = flags.get('--origin') ?? null;
  if (title === null || !validOperationArgument(operationId) || (origin !== null && !validOriginArgument(origin))) {
    throw new CliError('invalid_arguments');
  }
  const output = await new ChannelCreateService(deps.client).request({ title, operationId, origin }, deps.signal);
  await write(deps.stdout, JSON.stringify(output) + '\n');
  return createExitCode(output);
}

/** `khala channels create-status --operation <id> [--origin <trusted-origin>]` */
export async function createChannelStatus(args: readonly string[], deps: CliDependencies): Promise<number> {
  const flags = parseFlags(args, ['--operation', '--origin']);
  const operationId = flags.get('--operation');
  const origin = flags.get('--origin') ?? null;
  if (!validOperationArgument(operationId) || (origin !== null && !validOriginArgument(origin))) {
    throw new CliError('invalid_arguments');
  }
  const output = await new ChannelCreateService(deps.client).status({ operationId, origin }, deps.signal);
  await write(deps.stdout, JSON.stringify(output) + '\n');
  return createExitCode(output);
}

function parseFlags(args: readonly string[], allowed: readonly string[]): ReadonlyMap<string, string> {
  if (args.length % 2 !== 0) throw new CliError('invalid_arguments');
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index]!;
    if (!allowed.includes(name) || flags.has(name)) throw new CliError('invalid_arguments');
    flags.set(name, args[index + 1]!);
  }
  return flags;
}
