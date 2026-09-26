// Content-free wake for an idle interactive Codex TUI. A constant `codex queue` notice
// makes the same TUI start a turn, so its `UserPromptSubmit` hook performs the shared
// pull. The notice carries no body, token or peer name; delivery, acknowledgement and
// duplicate control stay with the hook and the batch token. Khala never launches Codex
// or types into a screen, and never signals the user's Codex process.

import type { ListeningMode, SessionBinding } from '@khala/contracts/delivery/index';
import { sameSessionBinding } from '@khala/contracts/delivery/index';
import { CODEX_INTERACTIVE_VERSIONS } from './interactive';

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
  | 'not_idle_mode' | 'revoked';

export type CodexIdleWakeDeps = Readonly<{
  port: CodexIdleWakePort;
  /** True only while the binding is still the live, unrevoked binding (Stop revokes it). */
  isCurrent: (binding: SessionBinding) => Promise<boolean>;
  /** How often a wake in flight re-checks revocation, in ms. */
  revocationPollMs?: number;
}>;

export type CodexIdleWake = Readonly<{
  /** Wake one idle session for a pending batch; concurrent wakes for a binding coalesce. */
  wake: (binding: SessionBinding, mode: ListeningMode, version: string) => Promise<CodexIdleWakeResult>;
}>;

export function codexIdleWakeArgv(sessionId: string): readonly string[] {
  return ['queue', '--thread', sessionId, '--message', CODEX_IDLE_WAKE_NOTICE];
}

export function createCodexIdleWake(deps: CodexIdleWakeDeps): CodexIdleWake {
  const pollMs = deps.revocationPollMs ?? 250;
  const inFlight = new Map<string, Readonly<{ binding: SessionBinding; result: Promise<CodexIdleWakeResult> }>>();

  const current = (binding: SessionBinding) => deps.isCurrent(binding).catch(() => false);

  async function run(binding: SessionBinding): Promise<CodexIdleWakeResult> {
    if (!await current(binding)) return 'revoked';
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
    wake(binding, mode, version) {
      // `async` is never woken; an unproven version keeps the next-turn-only claim.
      if (mode === 'async') return Promise.resolve('not_idle_mode');
      if (!CODEX_INTERACTIVE_VERSIONS.includes(version)) return Promise.resolve('unsupported_version');
      const existing = inFlight.get(binding.bindingId);
      if (existing && sameSessionBinding(existing.binding, binding)) return existing.result;
      const result = run(binding).finally(() => {
        if (inFlight.get(binding.bindingId)?.result === result) inFlight.delete(binding.bindingId);
      });
      inFlight.set(binding.bindingId, { binding, result });
      return result;
    },
  };
}
