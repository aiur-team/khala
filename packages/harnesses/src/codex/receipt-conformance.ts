// Conformance gate for the Codex acknowledgement claim. `batch_token_next_call` is
// advertised only for an exact user-started interactive CLI route whose recorded run
// observed every step of the acknowledgement path. Hosted app-server results, queue
// acceptance, `item/started`, context insertion and the batch response prove none of it.

/** Routes by which the user's own CLI can consume the shared batch. */
export const CODEX_RECEIPT_ROUTES = ['hook', 'khala_read', 'mcp_piggyback', 'native_inbox'] as const;
export type CodexReceiptRoute = (typeof CODEX_RECEIPT_ROUTES)[number];

/** Who ran the Codex process that consumed the batch. Only `user_cli` can prove the claim. */
export type CodexReceiptSubject = 'user_cli' | 'hosted_app_server';

/**
 * What one conformance run observed. Every field is a non-secret boolean or label;
 * token bytes never appear in evidence.
 */
export type CodexReceiptObservation = Readonly<{
  subject: CodexReceiptSubject;
  route: CodexReceiptRoute;
  version: string;
  /** The batch was read through the shared channel-access journal/inbox, not a competing consumer. */
  sharedInbox: boolean;
  /** The one shared-batch delivery returned a batch token to the agent. */
  batchDelivered: boolean;
  /** The next Khala call was authenticated to the same binding and generation. */
  authenticatedBinding: boolean;
  /** The next Khala call carried the issued token; false if it was lost, overwritten or omitted. */
  tokenReturned: boolean;
  /** A receipt was recorded and correlated to that batch through the shared evidence reference. */
  receiptCorrelated: boolean;
  /** CLI and MCP consumers contending for the token either serialized or failed closed, never lost it. */
  contentionSafe: boolean;
}>;

export type CodexReceiptGap =
  | 'no_observation' | 'not_user_cli' | 'version_mismatch' | 'route_mismatch' | 'no_shared_inbox'
  | 'no_batch_delivery' | 'binding_unauthenticated' | 'token_not_returned' | 'receipt_not_correlated'
  | 'contention_unsafe';

export type CodexReceiptProof =
  | Readonly<{ proven: true; route: CodexReceiptRoute; version: string }>
  | Readonly<{ proven: false; gaps: readonly CodexReceiptGap[] }>;

/** The default: nothing observed, so nothing is claimed. */
export const NO_CODEX_RECEIPT_PROOF: CodexReceiptProof = { proven: false, gaps: ['no_observation'] };

/**
 * Judges one observation for the exact version and route being advertised. Missing
 * evidence is never proof, and a later call that never happened stays neutral.
 */
export function assessCodexReceiptConformance(
  observation: CodexReceiptObservation | null,
  expected: Readonly<{ version: string; route: CodexReceiptRoute }>,
): CodexReceiptProof {
  if (observation === null) return NO_CODEX_RECEIPT_PROOF;
  const gaps: CodexReceiptGap[] = [];
  if (observation.subject !== 'user_cli') gaps.push('not_user_cli');
  if (observation.version !== expected.version) gaps.push('version_mismatch');
  if (observation.route !== expected.route) gaps.push('route_mismatch');
  if (observation.sharedInbox !== true) gaps.push('no_shared_inbox');
  if (observation.batchDelivered !== true) gaps.push('no_batch_delivery');
  if (observation.authenticatedBinding !== true) gaps.push('binding_unauthenticated');
  if (observation.tokenReturned !== true) gaps.push('token_not_returned');
  if (observation.receiptCorrelated !== true) gaps.push('receipt_not_correlated');
  if (observation.contentionSafe !== true) gaps.push('contention_unsafe');
  return gaps.length === 0
    ? { proven: true, route: expected.route, version: expected.version }
    : { proven: false, gaps };
}
