// Readiness states, reconnect backoff and the local lifecycle generation guard.
// Readiness is all these states expose: never pending text, counts or senders.

export type BlockedCode = 'missing_keys' | 'storage_failed' | 'authority_lost' | 'replay_gap' | 'unsupported';

export type SubscriptionState =
  | Readonly<{ kind: 'starting' | 'catching_up' | 'live'; streamId: string }>
  | Readonly<{ kind: 'blocked'; code: BlockedCode }>
  | Readonly<{ kind: 'offline'; retryAt: string | null }>;

/**
 * Blocked codes that no retry can clear. The stream stays blocked until the
 * owner recovers it and starts a new subscription; it is never labelled live.
 */
export const TERMINAL_BLOCKS: ReadonlySet<BlockedCode> = new Set(['authority_lost', 'replay_gap', 'unsupported']);

/** Reliability settings for reconnect and blocked retries, not user automation budgets. */
export type RetryPolicy = Readonly<{ baseMs: number; maxMs: number }>;

export const DEFAULT_RETRY: RetryPolicy = { baseMs: 1_000, maxMs: 60_000 };

/**
 * Full-jitter exponential backoff: a uniform delay in `[0, min(maxMs, baseMs * 2^attempt)]`.
 * `random` returns a value in `[0, 1)`. Attempt 0 is the first retry.
 */
export function backoffDelay(policy: RetryPolicy, attempt: number, random: () => number): number {
  const ceiling = Math.min(policy.maxMs, policy.baseMs * 2 ** Math.min(attempt, 30));
  return Math.floor(Math.min(Math.max(random(), 0), 1) * ceiling);
}

/**
 * Local connection generation. Every connection attempt and every stop takes a
 * new generation; a callback or awaited result carrying an older one is ignored,
 * so a stale connection cannot move state owned by its replacement.
 */
export class Generation {
  #current = 0;

  get current(): number {
    return this.#current;
  }

  next(): number {
    this.#current += 1;
    return this.#current;
  }

  isCurrent(generation: number): boolean {
    return generation === this.#current;
  }
}
