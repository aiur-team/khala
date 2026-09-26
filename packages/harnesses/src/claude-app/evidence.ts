// Exact-tuple proof rows for the Claude app shapes, and the admission rule that
// decides whether a row may carry a mode. A row that fails admission is ignored,
// so the mode stays `unknown`; nothing here is inferred from a neighbouring tuple.

import {
  type AppHarnessIdentity, type AppHookBoundary, type ListeningMode, sameAppHarnessIdentity,
} from '@khala/contracts/delivery/index';

/** Claude app shapes this adapter reports. Each shape gets its own record. */
export const CLAUDE_APP_SHAPES = ['desktop_extension', 'remote_connector', 'browser'] as const;
export type ClaudeAppShape = (typeof CLAUDE_APP_SHAPES)[number];

/**
 * How the proof observed the batch reaching the model. Only a model-context
 * injection at a real boundary can carry `steer` or `sync`, and only a `khala_read`
 * result can carry `async`. An MCP notification, a tool-list change, a second
 * Claude session, or polling is recorded as what it is and never promotes a mode.
 */
export const CLAUDE_APP_DELIVERIES = [
  'model_context_injection', 'khala_read_result', 'mcp_notification', 'tool_list_changed', 'second_session', 'polling',
] as const;
export type ClaudeAppDelivery = (typeof CLAUDE_APP_DELIVERIES)[number];

export type ClaudeAppEvidence = Readonly<{
  identity: AppHarnessIdentity;
  mode: ListeningMode;
  boundary: AppHookBoundary;
  delivery: ClaudeAppDelivery;
  route: string;
  evidenceRef: string;
  evidenceRevision: string;
  run: ClaudeAppProofRun;
}>;

/**
 * The `claude-app-channel-proof` (#295) run facts that make a row admissible.
 * Positions are indexes into that run's `events.jsonl`, so ordering is checked
 * here rather than trusted.
 */
export type ClaudeAppProofRun = Readonly<{
  /** The app's MCP `clientInfo.name` values, declared in `run.json` before the run. */
  expectedClientNames: readonly string[];
  /** Every distinct `clientInfo.name` that connected during the run. */
  clientNames: readonly string[];
  /** The conversations the operator started for the proof, declared before the run. */
  targetConversations: readonly string[];
  firstDeliveryAt: number;
  echo: Readonly<{ conversation: string; at: number }>;
  acknowledgedAt: number;
}>;

export const CLAUDE_APP_PROOF_REF = 'docs/product/internal-mode/interactive-desktop-apps.md#mode-matrix';

/**
 * Graded rows from `claude-app-channel-proof` (#244). Empty: that proof has no app
 * run yet, so every Claude app tuple is `unknown` and no route can be selected.
 */
export const CLAUDE_APP_EVIDENCE: readonly ClaudeAppEvidence[] = Object.freeze([]);

const MODE_BOUNDARIES: Readonly<Record<ListeningMode, readonly AppHookBoundary[]>> = {
  steer: ['postToolUse', 'PostToolUse'],
  sync: ['stop', 'Stop'],
  async: ['khala_read'],
};

const MODE_DELIVERY: Readonly<Record<ListeningMode, ClaudeAppDelivery>> = {
  steer: 'model_context_injection',
  sync: 'model_context_injection',
  async: 'khala_read_result',
};

/** A tuple with any uninspected field cannot match evidence, even evidence recorded for `unknown`. */
export function identityComplete(identity: AppHarnessIdentity): boolean {
  return [identity.appVersion, identity.accountTier, identity.administratorPolicyScope]
    .every(field => field !== 'unknown');
}

/** The row that may carry `mode` for exactly this tuple, or `null`. */
export function admittedEvidence(
  identity: AppHarnessIdentity,
  mode: ListeningMode,
  rows: readonly ClaudeAppEvidence[],
): ClaudeAppEvidence | null {
  if (identity.app !== 'claude' || !identityComplete(identity)) return null;
  return rows.find(row => row.mode === mode
    && sameAppHarnessIdentity(row.identity, identity)
    && MODE_BOUNDARIES[mode].includes(row.boundary)
    && row.delivery === MODE_DELIVERY[mode]
    && proofRunAdmissible(row.run)) ?? null;
}

// Known non-app MCP clients: never Claude app evidence, even when a run declares them.
const NON_APP_CLIENTS = /^(claude[- ]?code|mcp-remote)$/i;

const namedClient = (name: string): boolean => name.trim() !== '' && !NON_APP_CLIENTS.test(name.trim());

/**
 * The #295 proof-kit rules: exactly one client, declared and not a known
 * non-app client, and a model echo in a declared target conversation after the
 * first delivery and before the acknowledgement.
 */
export function proofRunAdmissible(run: ClaudeAppProofRun): boolean {
  const { expectedClientNames: expected, clientNames: clients, targetConversations: targets, echo } = run;
  const [client] = clients;
  return expected.length > 0 && expected.every(namedClient)
    && clients.length === 1 && client !== undefined && namedClient(client) && expected.includes(client)
    && targets.length > 0 && targets.every(target => target.trim() !== '')
    && targets.includes(echo.conversation)
    && [run.firstDeliveryAt, echo.at, run.acknowledgedAt].every(Number.isSafeInteger)
    && run.firstDeliveryAt < echo.at && echo.at < run.acknowledgedAt;
}
