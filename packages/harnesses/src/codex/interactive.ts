// Capability claims for delivery into the user's own interactive Codex TUI through the
// native hooks that setup installs. Khala never starts, hosts or signals Codex here.

import {
  type DeliveryLimits, type HarnessCapabilities, type ModeSupport, unknownModeSupportMap,
} from '@khala/contracts/delivery/index';
import { CODEX_HARNESS } from './capabilities';
import { type CodexReceiptProof, NO_CODEX_RECEIPT_PROOF } from './receipt-conformance';

export const CODEX_INTERACTIVE_ADAPTER_VERSION = 'native-hooks-1';
export const CODEX_INTERACTIVE_EVIDENCE_REF = 'docs/product/internal-mode/interactive-codex.md#mode-matrix';
/** Changes whenever the proof is re-run, so consent derived from an older proof lapses. */
export const CODEX_INTERACTIVE_EVIDENCE_REVISION = 'interactive-codex-2026-09-25';

/** Exact versions whose TUI passed every mode cell under normal trust settings. */
export const CODEX_INTERACTIVE_VERSIONS: readonly string[] = ['0.154.0', '0.156.1'];

const IDLE = 'Idle agents receive messages only at their next turn.';

/** The user's hook-review state for the installed Khala handlers, as setup reports it. */
export type CodexInteractiveHookReview =
  | Readonly<{ state: 'trusted' }>
  | Readonly<{ state: 'awaiting_hook_review' | 'unknown'; reason: string }>;

/**
 * Declares the hook route for one Codex version. Nothing is claimed unless the
 * version is in the proven matrix and the user has trusted every Khala hook; an
 * installation that is untrusted or unverified reports `unknown` with its reason.
 */
export function interactiveCodexCapabilities(
  version: string,
  limits: DeliveryLimits,
  review: CodexInteractiveHookReview,
  receiptProof: CodexReceiptProof = NO_CODEX_RECEIPT_PROOF,
): HarnessCapabilities {
  if (!CODEX_INTERACTIVE_VERSIONS.includes(version)) {
    return closed(version, limits, `Codex ${version} has no interactive hook proof; proven versions are `
      + `${CODEX_INTERACTIVE_VERSIONS.join(' and ')}. ${IDLE}`);
  }
  if (review.state !== 'trusted') {
    const prefix = review.state === 'awaiting_hook_review' ? 'Awaiting hook review' : 'Hook trust unknown';
    return closed(version, limits, `${prefix}: ${review.reason} ${IDLE}`);
  }
  const proven = (route: string, reason: string): ModeSupport => ({
    status: 'proven',
    route,
    testedVersion: version,
    evidenceRef: CODEX_INTERACTIVE_EVIDENCE_REF,
    evidenceRevision: CODEX_INTERACTIVE_EVIDENCE_REVISION,
    reason,
  });
  // `async` delivers only through khala_read and is unusable without a returned token, so it is
  // proven only for the exact route and version whose receipt a conformance run proved.
  const acknowledged = receiptProof.proven && receiptProof.route === 'hook' && receiptProof.version === version;
  return {
    v: 3,
    harness: CODEX_HARNESS,
    version,
    adapterVersion: CODEX_INTERACTIVE_ADAPTER_VERSION,
    support: 'tested',
    existingSession: 'native_hooks',
    // The content-free idle wake is proven separately (`codex-idle-wake`).
    immediateNotification: 'unknown',
    // Busy handling differs by mode and is stated per mode below.
    busy: 'unknown',
    receiptEvidence: [],
    reconcileByReleaseId: 'unsupported',
    limits,
    evidenceRef: CODEX_INTERACTIVE_EVIDENCE_REF,
    modes: {
      steer: proven('codex-hooks-next-tool-boundary', 'steer means the next tool boundary: PreToolUse blocks the '
        + 'next tool, PostToolUse adds a batch that arrived during a tool, and Stop continues once. '
        + `Hard abort is disabled. ${IDLE}`),
      sync: proven('codex-hooks-stop-or-prompt', 'Delivered after the turn at Stop, or with the next prompt; '
        + `tool boundaries stay silent. ${IDLE}`),
      async: acknowledged
        ? proven('codex-khala-read', 'Delivered only when the agent calls khala_read; hooks inject nothing.')
        : {
          status: 'unknown',
          route: 'codex-khala-read',
          testedVersion: version,
          evidenceRef: CODEX_INTERACTIVE_EVIDENCE_REF,
          evidenceRevision: CODEX_INTERACTIVE_EVIDENCE_REVISION,
          reason: `Awaiting a receipt proof: async is not offered until the batch token is proven to come back. ${IDLE}`,
        },
    },
    // Only the exact hook route and version a conformance run proved; delivery alone is not
    // acknowledgement, and a missing later call stays neutral.
    acknowledgement: acknowledged ? 'batch_token_next_call' : 'unknown',
  };
}

function closed(version: string, limits: DeliveryLimits, reason: string): HarnessCapabilities {
  return {
    v: 3,
    harness: CODEX_HARNESS,
    version,
    adapterVersion: CODEX_INTERACTIVE_ADAPTER_VERSION,
    support: 'unsupported',
    existingSession: 'unknown',
    immediateNotification: 'unknown',
    busy: 'unknown',
    receiptEvidence: [],
    reconcileByReleaseId: 'unknown',
    limits,
    evidenceRef: CODEX_INTERACTIVE_EVIDENCE_REF,
    modes: unknownModeSupportMap('codex-interactive-hooks', reason, version),
    acknowledgement: 'unknown',
  };
}
