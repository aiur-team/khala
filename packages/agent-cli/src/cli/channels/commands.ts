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
    if (subcommand === 'open') return openProvisional(rest, deps);
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

/** Starts once for the verified calling session; no session identity is accepted from argv. */
async function openProvisional(args: readonly string[], deps: CliDependencies): Promise<number> {
  if (args.length !== 0) throw new CliError('invalid_arguments');
  if (!deps.provisionalOpen) {
    await write(deps.stdout, JSON.stringify({ ok: false, kind: 'blocked', step: 'native_session',
      code: 'native_session_unavailable' }) + '\n');
    return 4;
  }
  let result: Awaited<ReturnType<NonNullable<CliDependencies['provisionalOpen']>>>;
  try { result = await deps.provisionalOpen(); }
  catch { result = { kind: 'blocked', step: 'hosted_route', code: 'unavailable' }; }
  if (result.kind === 'provisional') {
    const parsed = URL.canParse(result.claimUrl) ? new URL(result.claimUrl) : null;
    if (parsed?.protocol !== 'https:' || parsed.origin !== deps.provisionalOrigin
      || parsed.username || parsed.password || !Number.isFinite(Date.parse(result.expiresAt))) {
      await write(deps.stdout, JSON.stringify({ ok: false, kind: 'blocked', step: 'hosted_route',
        code: 'invalid_response' }) + '\n');
      return 4;
    }
    await write(deps.stdout, JSON.stringify({ ok: true, kind: 'provisional',
      claimUrl: result.claimUrl, expiresAt: result.expiresAt }) + '\n');
    return 0;
  }
  if (result.kind === 'claimed') {
    await write(deps.stdout, JSON.stringify({ ok: true, kind: 'claimed' }) + '\n');
    return 0;
  }
  const step = ['native_session', 'hosted_route', 'credentials'].includes(result.step)
    ? result.step : 'hosted_route';
  const code = /^[a-z][a-z0-9_]{0,63}$/.test(result.code) ? result.code : 'unavailable';
  await write(deps.stdout, JSON.stringify({ ok: false, kind: 'blocked', step, code }) + '\n');
  return 4;
}

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
  const named = flags.get('--operation');
  const operationId = named ?? defaultOperationId(target);
  const origin = flags.get('--origin') ?? null;
  if (!validOperationArgument(operationId) || (origin !== null && !validOriginArgument(origin))) {
    throw new CliError('invalid_arguments');
  }
  const access = new ChannelAccessService(deps.client);
  // Without `--operation`, asking again after the owner's Stop files the revoked operation's successor.
  const output = named === undefined
    ? await access.requestAgain({ target, operationId, origin }, deps.signal)
    : await access.request({ target, operationId, origin }, deps.signal);
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
