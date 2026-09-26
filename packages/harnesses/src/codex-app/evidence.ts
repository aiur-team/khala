// Proven Codex app cells, each keyed by the full app/shape/version/account/policy tuple.
// The table is a transcript of `experiments/interactive-cli/codex-app/evidence/cells.json`:
// a cell enters it only when that record marks the same cell `proven` for the same tuple.

import type { AppHarnessIdentity, ListeningMode } from '@khala/contracts/delivery/index';

export const CODEX_APP = 'codex';
export const CODEX_APP_ADAPTER_VERSION = 'codex-app-1';
export const CODEX_APP_PROOF_RECORD = 'experiments/interactive-cli/codex-app/evidence/cells.json';

/** The two Codex app shapes the proof record covers. Any other shape is unknown. */
export const CODEX_APP_SHAPES = ['local_chat', 'cloud_task'] as const;
export type CodexAppShape = (typeof CODEX_APP_SHAPES)[number];

/** The only boundary each mode may use; `steer` never blocks a tool before it runs. */
export const CODEX_APP_BOUNDARIES = {
  steer: 'PostToolUse',
  sync: 'Stop',
  async: 'khala_read',
} as const satisfies Readonly<Record<ListeningMode, string>>;

export type CodexAppProvenCell = Readonly<{
  identity: AppHarnessIdentity & Readonly<{ app: typeof CODEX_APP; shape: CodexAppShape }>;
  mode: ListeningMode;
  /** The raw trial file the proof record's `evidenceRef` names. */
  evidenceRef: string;
  /** Changes whenever the proof is re-run, so consent derived from an older proof lapses. */
  evidenceRevision: string;
}>;

/**
 * Every cell in the 2026-09-25 proof record is Blocked: no native desktop app exists on
 * the proof host, and the account has no existing cloud task. Nothing is proven.
 */
export const CODEX_APP_PROVEN_CELLS: readonly CodexAppProvenCell[] = [];

/** The proof record's Blocked reason per shape, shown while a cell stays `unknown`. */
export const CODEX_APP_BLOCKED_REASONS: Readonly<Record<CodexAppShape, string>> = {
  local_chat: 'Blocked: no native Codex desktop app was available to prove this route in a user-started session.',
  cloud_task: 'Blocked: no existing, user-created Codex Cloud task was available to prove this route.',
};
