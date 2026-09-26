import type { SessionBinding } from '@khala/contracts/delivery/index';
import { CliError } from './errors.js';
import { publicBinding, write } from './runtime.js';
import { plainObject } from './validation.js';
import { PAIR_REFUSAL_CODES, type AgentClientPort, type CliCommand, type PairRefusalCode } from './types.js';

/** Longest human entry accepted before normalization: the code plus generous spacing. */
export const MAX_PAIRING_CODE_INPUT = 32;
const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]{10}$/;

export type PairErrorCode = PairRefusalCode | 'invalid_code' | 'pairing_unavailable' | 'unavailable';

/**
 * The exact object printed by `khala pair` and returned by `khala_pair`. It never
 * carries the code, a claim receipt, a grant, or a channel identity before
 * admission, and never includes thrown error text.
 */
export type PairOutput =
  | Readonly<{ ok: true; v: 1; binding: SessionBinding; reused: boolean }>
  | Readonly<{ ok: false; v: 1; error: 'approval_pending'; reason: 'approval_timeout' | 'cancelled'; retryable: true }>
  | Readonly<{ ok: false; v: 1; error: PairErrorCode }>;

/**
 * Canonicalizes a human-entered pairing code: case, spaces and the separator are
 * forgiven, and Crockford's look-alikes (I, L to 1; O to 0) are folded. Anything
 * else is refused; `null` means not a code.
 */
export function normalizePairingCode(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PAIRING_CODE_INPUT) return null;
  const compact = value.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  if (!CROCKFORD.test(compact)) return null;
  return `${compact.slice(0, 5)}-${compact.slice(5)}`;
}

/** One pairing operation shared by the CLI command and the MCP tool. */
export class PairingService {
  constructor(private readonly client: Pick<AgentClientPort, 'pair'>) {}

  async pair(code: unknown, signal?: AbortSignal): Promise<PairOutput> {
    const canonical = normalizePairingCode(code);
    if (canonical === null) return { ok: false, v: 1, error: 'invalid_code' };
    if (this.client.pair === undefined) return { ok: false, v: 1, error: 'pairing_unavailable' };
    let result: unknown;
    try {
      result = await this.client.pair(canonical, signal);
    } catch {
      return { ok: false, v: 1, error: 'unavailable' };
    }
    return publicPairOutput(result);
  }
}

export function pairExitCode(output: PairOutput): number {
  if (output.ok) return 0;
  return output.error === 'approval_pending' || output.error === 'unavailable' ? 4 : 3;
}

/** Projects a client result onto the closed public output; anything unexpected is `unavailable`. */
function publicPairOutput(value: unknown): PairOutput {
  if (!plainObject(value)) return { ok: false, v: 1, error: 'unavailable' };
  if (value.kind === 'refused' && typeof value.code === 'string' && (PAIR_REFUSAL_CODES as readonly string[]).includes(value.code)) {
    return { ok: false, v: 1, error: value.code as PairRefusalCode };
  }
  if (value.kind === 'pending' && (value.reason === 'approval_timeout' || value.reason === 'cancelled')) {
    return { ok: false, v: 1, error: 'approval_pending', reason: value.reason, retryable: true };
  }
  if (value.kind === 'connected' && typeof value.reused === 'boolean') {
    try {
      return { ok: true, v: 1, binding: publicBinding(value.binding), reused: value.reused };
    } catch {
      return { ok: false, v: 1, error: 'unavailable' };
    }
  }
  return { ok: false, v: 1, error: 'unavailable' };
}

/** `khala pair <code>`: claim a pairing code shown on the hosted channel and wait for the owner. */
export const pairCommand: CliCommand = {
  name: 'pair',
  async run(args, deps) {
    if (args.length !== 1) throw new CliError('invalid_arguments');
    const output = await new PairingService(deps.client).pair(args[0], deps.signal);
    await write(deps.stdout, JSON.stringify(output) + '\n');
    return pairExitCode(output);
  },
};
