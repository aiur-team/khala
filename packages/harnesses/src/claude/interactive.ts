// Capability claims for delivery into the user's own interactive Claude Code CLI through
// the Khala plugin's hooks and MCP entry. Khala never starts, hosts or signals Claude here.

import {
  type DeliveryLimits, type HarnessCapabilities, type ModeSupport, decodeHarnessCapabilities, unknownModeSupportMap,
} from '@khala/contracts/delivery/index';
import { CLAUDE_HARNESS, claudeCapabilities } from './capabilities';

export const CLAUDE_INTERACTIVE_ROUTE = 'claude-interactive-hooks';
export const CLAUDE_INTERACTIVE_ADAPTER_VERSION = 'claude-session-adapter-1';
export const CLAUDE_INTERACTIVE_EVIDENCE_REF = 'experiments/internal-mode/read-receipts/claude/evidence.json';
/** Changes whenever the route's evidence changes, so an owner's experimental grant lapses with it. */
export const CLAUDE_INTERACTIVE_EVIDENCE_REVISION = 'interactive-claude-2026-09-25';

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
 * Declares the interactive route for one inspected Claude Code version. An exact
 * version/route pair in `proven` is `tested`. Any other inspected version on this route
 * is `experimental` (decisions 34 and 37): it delivers with batch-token acknowledgement,
 * but its modes are labelled experimental and take effect only under the owner's
 * experimental-route grant. Another route claims nothing.
 */
export function interactiveClaudeCapabilities(
  version: string,
  route: string,
  limits: DeliveryLimits,
  proven: readonly ClaudeProvenRoute[] = CLAUDE_INTERACTIVE_PROVEN,
): HarnessCapabilities {
  if (route !== CLAUDE_INTERACTIVE_ROUTE) {
    return closed(version, limits, `Claude Code ${version} on route ${route} is not a Khala delivery route. ${IDLE}`);
  }
  const tested = proven.some(pair => pair.version === version && pair.route === route);
  const reason = tested
    // Receipt proof says nothing about mode delivery, which the hook proofs decide.
    ? `Mode delivery is proven separately; until then this mode is experimental. ${IDLE}`
    : `Claude Code ${version} on route ${route} has no retained read-receipt proof, so this route is experimental. ${IDLE}`;
  const experimental = (mode: string): ModeSupport => ({
    status: 'experimental',
    route: `${route}-${mode}`,
    testedVersion: version,
    evidenceRef: CLAUDE_INTERACTIVE_EVIDENCE_REF,
    evidenceRevision: CLAUDE_INTERACTIVE_EVIDENCE_REVISION,
    reason,
  });
  return {
    v: 3,
    harness: CLAUDE_HARNESS,
    version,
    adapterVersion: CLAUDE_INTERACTIVE_ADAPTER_VERSION,
    support: tested ? 'tested' : 'experimental',
    existingSession: 'native_hooks',
    immediateNotification: 'unknown',
    busy: 'unknown',
    receiptEvidence: [],
    reconcileByReleaseId: 'unsupported',
    limits,
    evidenceRef: CLAUDE_INTERACTIVE_EVIDENCE_REF,
    modes: { steer: experimental('steer'), sync: experimental('sync'), async: experimental('async') },
    acknowledgement: 'batch_token_next_call',
  };
}

/** The shape `claude --version` reports once parsed, such as `2.1.283`. */
const INSPECTED_VERSION = /^\d+\.\d+\.\d+$/u;

/**
 * The route claim for the locally installed Claude Code, read as setup reads it. A
 * version that could not be inspected, or that the contract cannot carry, stays unproven.
 */
export function installedClaudeCapabilities(version: string | null, limits: DeliveryLimits): HarnessCapabilities {
  if (version === null || !INSPECTED_VERSION.test(version)) return claudeCapabilities(null, limits);
  const claimed = decodeHarnessCapabilities(interactiveClaudeCapabilities(version, CLAUDE_INTERACTIVE_ROUTE, limits));
  return claimed.ok ? claimed.value : claudeCapabilities(null, limits);
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
