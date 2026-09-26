// Content-free wake for an idle interactive Codex TUI. A constant `codex queue` notice
// makes the same TUI start a turn, so its `UserPromptSubmit` hook performs the shared
// pull. The notice carries no body, token or peer name; delivery, acknowledgement and
// duplicate control stay with the hook and the batch token. Khala never launches Codex
// or types into a screen, and never signals the user's Codex process.

import type { ListeningMode, SessionBinding } from '@khala/contracts/delivery/index';
import { sameSessionBinding } from '@khala/contracts/delivery/index';
import { CODEX_INTERACTIVE_VERSIONS, type CodexIdleWakeState } from './interactive';

/** The only message text a wake ever queues. */
export const CODEX_IDLE_WAKE_NOTICE = 'Khala: channel messages are waiting. Continue.';

export type CodexIdleWakeOutcome =
  | Readonly<{ status: 'queued' }>
  | Readonly<{ status: 'exited'; code: number }>
  | Readonly<{ status: 'not_started' }>
  | Readonly<{ status: 'lost'; cause: 'disconnected' | 'timeout' }>;

/**
 * Composition owns process execution: no shell, no message-bearing environment, child
 * stderr kept out of logs, and the child terminated when `signal` aborts. The wake only
 * stops that `codex queue` child; it never signals the Codex TUI.
 */
export interface CodexIdleWakePort {
  run(argv: readonly string[], signal: AbortSignal): Promise<CodexIdleWakeOutcome>;
}

export type CodexIdleWakeResult =
  | 'queued'
  /** Wake unavailable: idle agents receive messages only at their next turn (decision 34). */
  | 'unsupported_version' | 'queue_failed'
  | 'not_idle_mode' | 'not_idle' | 'revoked';

export type CodexIdleWakeDeps = Readonly<{
  port: CodexIdleWakePort;
  /** True only while the binding is still the live, unrevoked binding (Stop revokes it). */
  isCurrent: (binding: SessionBinding) => Promise<boolean>;
  /** True only while the session is between turns; a busy session takes the batch at its next hook. */
  isIdle: (binding: SessionBinding) => Promise<boolean>;
  /** How often a wake in flight re-checks revocation, in ms. */
  revocationPollMs?: number;
}>;

export type CodexIdleWake = Readonly<{
  /**
   * Whether the wake claim may be made for this binding: `unavailable` until a wake has succeeded and
   * again after its last wake failed (decisions 34/37), so capabilities fall back to the next-turn-only claim (decision 34). Feed it to
   * `interactiveCodexCapabilities(..., idleWake)`.
   */
  state: (binding: SessionBinding) => CodexIdleWakeState;
  /** Wake one idle session for a pending batch; concurrent wakes for a binding coalesce. */
  wake: (binding: SessionBinding, mode: ListeningMode, version: string) => Promise<CodexIdleWakeResult>;
}>;

export function codexIdleWakeArgv(sessionId: string): readonly string[] {
  return ['queue', '--thread', sessionId, '--message', CODEX_IDLE_WAKE_NOTICE];
}

export function createCodexIdleWake(deps: CodexIdleWakeDeps): CodexIdleWake {
  const pollMs = deps.revocationPollMs ?? 250;
  const inFlight = new Map<string, Readonly<{ binding: SessionBinding; result: Promise<CodexIdleWakeResult> }>>();

  const proven = new Set<string>();
  const key = (binding: SessionBinding) => `${binding.bindingId}:${binding.generation}`;
  const current = (binding: SessionBinding) => deps.isCurrent(binding).catch(() => false);

  async function run(binding: SessionBinding): Promise<CodexIdleWakeResult> {
    if (!await current(binding)) return 'revoked';
    if (!await deps.isIdle(binding).catch(() => false)) return 'not_idle';
    const abort = new AbortController();
    const watch = setInterval(() => {
      void current(binding).then(live => { if (!live) abort.abort(); });
    }, pollMs);
    try {
      const revoked = new Promise<'revoked'>(resolve => abort.signal.addEventListener('abort', () => resolve('revoked')));
      const outcome = await Promise.race([
        deps.port.run(codexIdleWakeArgv(binding.sessionId), abort.signal)
          .catch((): CodexIdleWakeOutcome => ({ status: 'lost', cause: 'disconnected' })),
        revoked,
      ]);
      if (outcome === 'revoked' || abort.signal.aborted) return 'revoked';
      return outcome.status === 'queued' ? 'queued' : 'queue_failed';
    } finally {
      clearInterval(watch);
    }
  }

  return {
    state: binding => (proven.has(key(binding)) ? 'available' : 'unavailable'),
    wake(binding, mode, version) {
      // `async` is never woken; an unproven version keeps the next-turn-only claim.
      if (mode === 'async') return Promise.resolve('not_idle_mode');
      if (!CODEX_INTERACTIVE_VERSIONS.includes(version)) return Promise.resolve('unsupported_version');
      const existing = inFlight.get(binding.bindingId);
      if (existing && sameSessionBinding(existing.binding, binding)) return existing.result;
      const result = run(binding).then(outcome => {
        if (outcome === 'queued') proven.add(key(binding));
        else if (outcome === 'queue_failed') proven.delete(key(binding));
        return outcome;
      }).finally(() => {
        if (inFlight.get(binding.bindingId)?.result === result) inFlight.delete(binding.bindingId);
      });
      inFlight.set(binding.bindingId, { binding, result });
      return result;
    },
  };
}

/**
 * Adapts the wake to the dispatcher's `IdleWake` port. The dispatcher supplies the mode from its
 * ledger's controls; the version comes from setup's inspection, and an unknown one wakes nothing.
 */
export function codexDispatchIdleWake(
  wake: CodexIdleWake,
  versionOf: (binding: SessionBinding) => Promise<string | null>,
): Readonly<{ wake: (binding: SessionBinding, mode: 'steer' | 'sync') => Promise<void> }> {
  return {
    async wake(binding, mode) {
      if (binding.harness !== 'codex') return;
      const version = await versionOf(binding);
      if (version !== null) await wake.wake(binding, mode, version);
    },
  };
}
