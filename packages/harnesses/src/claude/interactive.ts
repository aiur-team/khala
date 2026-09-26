// Capability claims for delivery into the user's own interactive Claude Code CLI through
// the Khala plugin's hooks and MCP entry. Khala never starts, hosts or signals Claude here.

import {
  type DeliveryLimits, type HarnessCapabilities, unknownModeSupportMap,
} from '@khala/contracts/delivery/index';
import { CLAUDE_HARNESS } from './capabilities';

export const CLAUDE_INTERACTIVE_ROUTE = 'claude-interactive-hooks';
export const CLAUDE_INTERACTIVE_ADAPTER_VERSION = 'claude-session-adapter-1';
export const CLAUDE_INTERACTIVE_EVIDENCE_REF = 'experiments/internal-mode/read-receipts/claude/evidence.json';

/** One exact Claude Code version and delivery route that passed the receipt conformance run. */
export type ClaudeProvenRoute = Readonly<{ version: string; route: typeof CLAUDE_INTERACTIVE_ROUTE }>;

/**
 * Pairs whose ordinary user-started CLI retained a passing live run (see the evidence
 * file's `provenPairs`). Empty until that run exists: an installed version is never
 * promoted by semver, by a hook firing, or by a passing offline test.
 */
export const CLAUDE_INTERACTIVE_PROVEN: readonly ClaudeProvenRoute[] = [];

const IDLE = 'Idle agents receive messages only at their next turn.';

/**
 * Declares the interactive route for one Claude Code version. `batch_token_next_call`
 * is claimed only for an exact version/route pair in `proven`; everything else stays
 * `unknown` with the reason, and no mode is claimed.
 */
export function interactiveClaudeCapabilities(
  version: string,
  route: string,
  limits: DeliveryLimits,
  proven: readonly ClaudeProvenRoute[] = CLAUDE_INTERACTIVE_PROVEN,
): HarnessCapabilities {
  if (!proven.some(pair => pair.version === version && pair.route === route)) {
    return closed(version, limits, `Claude Code ${version} on route ${route} has no retained read-receipt proof. ${IDLE}`);
  }
  return {
    v: 3,
    harness: CLAUDE_HARNESS,
    version,
    adapterVersion: CLAUDE_INTERACTIVE_ADAPTER_VERSION,
    support: 'tested',
    existingSession: 'native_hooks',
    immediateNotification: 'unknown',
    busy: 'unknown',
    receiptEvidence: [],
    reconcileByReleaseId: 'unsupported',
    limits,
    evidenceRef: CLAUDE_INTERACTIVE_EVIDENCE_REF,
    // Mode support is decided by the hook proofs, not by this receipt proof.
    modes: unknownModeSupportMap(route, `Mode delivery is proven separately. ${IDLE}`, version),
    acknowledgement: 'batch_token_next_call',
  };
}

function closed(version: string, limits: DeliveryLimits, reason: string): HarnessCapabilities {
  return {
    v: 3,
    harness: CLAUDE_HARNESS,
    version,
    adapterVersion: CLAUDE_INTERACTIVE_ADAPTER_VERSION,
    support: 'unsupported',
    existingSession: 'unknown',
    immediateNotification: 'unknown',
    busy: 'unknown',
    receiptEvidence: [],
    reconcileByReleaseId: 'unknown',
    limits,
    evidenceRef: CLAUDE_INTERACTIVE_EVIDENCE_REF,
    modes: unknownModeSupportMap(CLAUDE_INTERACTIVE_ROUTE, reason, version),
    acknowledgement: 'unknown',
  };
}
