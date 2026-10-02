// Content-free wake for an idle interactive Codex TUI. A constant `codex queue` notice
// makes the same TUI start a turn, so its `UserPromptSubmit` hook performs the shared
// pull. The notice carries no body, token or peer name; delivery, acknowledgement and
// duplicate control stay with the hook and the batch token. Khala never launches Codex
// or types into a screen, and never signals the user's Codex process.

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

export function codexIdleWakeArgv(sessionId: string): readonly string[] {
  return ['queue', '--thread', sessionId, '--message', CODEX_IDLE_WAKE_NOTICE];
}

// Debounced waker: codex.ts (KM-147).
