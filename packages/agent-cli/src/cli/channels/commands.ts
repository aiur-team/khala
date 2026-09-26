import type { BindingId } from '@khala/contracts/delivery/index';
import { CliError } from '../errors.js';
import { write } from '../runtime.js';
import type { CliCommand } from '../types.js';
import {
  ChannelListingService, listingExitCode, validChannelArgument, validCursorArgument, validOriginArgument,
} from './service.js';

/** `khala channels list [--origin <trusted-origin>] [--cursor <cursor>]` */
export const channelsCommand: CliCommand = {
  name: 'channels',
  async run(args, deps) {
    const [subcommand, ...rest] = args;
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
