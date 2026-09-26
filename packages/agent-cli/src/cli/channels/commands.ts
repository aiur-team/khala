import type { BindingId } from '@khala/contracts/delivery/index';
import { CliError } from '../errors.js';
import { write } from '../runtime.js';
import type { CliCommand, CliDependencies } from '../types.js';
import { createChannel, createChannelStatus } from './create/commands.js';
import {
  ChannelAccessService, accessExitCode, defaultOperationId, parseAccessTarget, validOperationArgument,
} from './access.js';
import {
  ChannelListingService, listingExitCode, validChannelArgument, validCursorArgument, validOriginArgument,
} from './service.js';

/**
 * `khala channels list [--origin <trusted-origin>] [--cursor <cursor>]`,
 * `khala channels request-access <channel-url-or-listing-ref> [--operation <id>] [--origin <trusted-origin>]`, and
 * `khala channels access-status --operation <id> [--origin <trusted-origin>]`.
 */
export const channelsCommand: CliCommand = {
  name: 'channels',
  async run(args, deps) {
    const [subcommand, ...rest] = args;
    if (subcommand === 'request-access') return requestAccess(rest, deps);
    if (subcommand === 'create') return createChannel(rest, deps);
    if (subcommand === 'create-status') return createChannelStatus(rest, deps);
    if (subcommand === 'access-status') return accessStatus(rest, deps);
    if (subcommand !== 'list') throw new CliError('invalid_arguments');
    const flags = parseFlags(rest, ['--origin', '--cursor']);
    const origin = flags.get('--origin') ?? null;
    const cursor = flags.get('--cursor') ?? null;
    if (origin !== null && !validOriginArgument(origin)) throw new CliError('invalid_arguments');
    if (cursor !== null && !validCursorArgument(cursor)) throw new CliError('invalid_arguments');
    const output = await new ChannelListingService(deps.client).listChannels({ origin, cursor }, deps.signal);
    await write(deps.stdout, JSON.stringify(output) + '\n');
    return listingExitCode(output);
  },
};

/** `khala agents list --channel <held-channel>` */
export const agentsCommand: CliCommand = {
  name: 'agents',
  async run(args, deps) {
    const [subcommand, ...rest] = args;
    if (subcommand !== 'list') throw new CliError('invalid_arguments');
    const channel = parseFlags(rest, ['--channel']).get('--channel');
    if (!validChannelArgument(channel)) throw new CliError('invalid_arguments');
    const output = await new ChannelListingService(deps.client).listAgents(channel as BindingId, deps.signal);
    await write(deps.stdout, JSON.stringify(output) + '\n');
    return listingExitCode(output);
  },
};

async function requestAccess(args: readonly string[], deps: CliDependencies): Promise<number> {
  const [rawTarget, ...rest] = args;
  const target = parseAccessTarget(rawTarget);
  if (target === null) throw new CliError('invalid_arguments');
  const flags = parseFlags(rest, ['--operation', '--origin']);
  const operationId = flags.get('--operation') ?? defaultOperationId(target);
  const origin = flags.get('--origin') ?? null;
  if (!validOperationArgument(operationId) || (origin !== null && !validOriginArgument(origin))) {
    throw new CliError('invalid_arguments');
  }
  const output = await new ChannelAccessService(deps.client).request({ target, operationId, origin }, deps.signal);
  await write(deps.stdout, JSON.stringify(output) + '\n');
  return accessExitCode(output);
}

async function accessStatus(args: readonly string[], deps: CliDependencies): Promise<number> {
  const flags = parseFlags(args, ['--operation', '--origin']);
  const operationId = flags.get('--operation');
  const origin = flags.get('--origin') ?? null;
  if (!validOperationArgument(operationId) || (origin !== null && !validOriginArgument(origin))) {
    throw new CliError('invalid_arguments');
  }
  const output = await new ChannelAccessService(deps.client).status({ operationId, origin }, deps.signal);
  await write(deps.stdout, JSON.stringify(output) + '\n');
  return accessExitCode(output);
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
