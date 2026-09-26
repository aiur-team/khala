import { ACCESS_REQUEST_OUTCOMES } from '@khala/contracts/messaging/discovery';
import { CliError } from '../errors.js';
import { write } from '../runtime.js';
import type { CliCommand } from '../types.js';

const SETTLED_REFUSALS: ReadonlySet<string> = new Set(['denied', 'expired', 'revoked', 'repair_required', 'unavailable']);

/**
 * `khala --internal-descriptor <path> join <channel-url>`. Asks the channel-access
 * journal for a human grant and reports its state; approval arrives only through
 * the owner's channel-requests inbox, which rewrites the descriptor. Non-blocking.
 */
export const joinCommand: CliCommand = {
  name: 'join',
  async run(args, deps) {
    if (args.length !== 1 || typeof args[0] !== 'string' || args[0].length === 0) throw new CliError('invalid_link');
    if (deps.client.requestAccess === undefined) throw new CliError('invalid_arguments');
    const result = await deps.client.requestAccess(args[0], deps.signal);
    if (result.kind === 'refused') throw new CliError(result.code);
    if (result.kind !== 'status' || !(ACCESS_REQUEST_OUTCOMES as readonly string[]).includes(result.outcome)) {
      throw new CliError('transport_unavailable');
    }
    const ok = !SETTLED_REFUSALS.has(result.outcome);
    await write(deps.stdout, JSON.stringify({ ok, kind: 'access', outcome: result.outcome }) + '\n');
    return ok ? 0 : 3;
  },
};
