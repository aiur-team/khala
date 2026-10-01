// Capability claims for delivery into the user's own interactive Codex TUI through the
// native hooks that setup installs. Khala never starts, hosts or signals Codex here.

import {
  type DeliveryLimits, type HarnessCapabilities, type ModeSupport, unknownModeSupportMap,
} from '@khala/contracts/delivery/index';
import { CODEX_HARNESS } from './capabilities';
import { type CodexReceiptProof, NO_CODEX_RECEIPT_PROOF } from './receipt-conformance';

export const CODEX_INTERACTIVE_ADAPTER_VERSION = 'native-hooks-1';
export const CODEX_INTERACTIVE_EVIDENCE_REF = 'docs/product/internal-mode/interactive-codex.md#mode-matrix';
export const CODEX_INTERACTIVE_0157_EVIDENCE_REF = 'docs/evidence/codex-0157-native-cli.md#sync-hook';
export const CODEX_BOUNDARY_ONLY_EVIDENCE_REF = 'docs/evidence/codex-0159-3-boundaries.md';
/** Changes whenever the proof is re-run, so consent derived from an older proof lapses. */
export const CODEX_INTERACTIVE_EVIDENCE_REVISION = 'interactive-codex-2026-09-25';
export const CODEX_INTERACTIVE_0157_EVIDENCE_REVISION = 'interactive-codex-0157-2026-09-27';

/** Exact versions whose TUI passed every mode cell under normal trust settings. */
export const CODEX_INTERACTIVE_VERSIONS: readonly string[] = ['0.154.0', '0.156.1'];
/** The newer Sol-capable CLI is promoted only for a separately observed sync hook. */
export const CODEX_NATIVE_SYNC_VERSION = '0.157.1';
export const CODEX_BOUNDARY_ONLY_VERSION = '0.159.3';

/** A new native version must receive a new consent revision, without invalidating old sessions. */
export function codexInteractiveEvidenceRevision(version: string): string {
  return version === '0.157.1' ? CODEX_INTERACTIVE_0157_EVIDENCE_REVISION : CODEX_INTERACTIVE_EVIDENCE_REVISION;
}

const IDLE = 'Idle agents receive messages only at their next turn.';
const IDLE_WOKEN = 'An idle agent is woken by a content-free queue notice, and the hook then pulls the batch.';

/** Whether the constant `codex queue` idle wake works here; a failure keeps the next-turn claim. */
export type CodexIdleWakeState = 'available' | 'unavailable';

/** The user's hook-review state for the installed Khala handlers, as setup reports it. */
export type CodexInteractiveHookReview =
  | Readonly<{ state: 'trusted' }>
  | Readonly<{ state: 'awaiting_hook_review' | 'unknown'; reason: string }>;

/**
 * Declares the hook route for one Codex version. Nothing is claimed unless the
 * version has route-specific proof and the user has trusted every Khala hook; an
 * installation that is untrusted or unverified reports `unknown` with its reason.
 */
export function interactiveCodexCapabilities(
  version: string,
  limits: DeliveryLimits,
  review: CodexInteractiveHookReview,
  receiptProof: CodexReceiptProof = NO_CODEX_RECEIPT_PROOF,
  idleWake: CodexIdleWakeState = 'unavailable',
  runtime: Readonly<{ platform: string; arch: string }> = process,
): HarnessCapabilities {
  const fullModeProof = CODEX_INTERACTIVE_VERSIONS.includes(version);
  const syncOnlyProof = version === CODEX_NATIVE_SYNC_VERSION;
  const idle = (fullModeProof || syncOnlyProof) && idleWake === 'available' ? IDLE_WOKEN : IDLE;
  if (syncOnlyProof && (runtime.platform !== 'linux' || runtime.arch !== 'x64')) {
    return closed(version, limits, 'Codex 0.157.1 native sync proof covers Linux x64 only.');
  }
  if (!fullModeProof && !syncOnlyProof) {
    if (version === CODEX_BOUNDARY_ONLY_VERSION) {
      return closed(version, limits, 'Codex 0.159.3 exposed model-visible PreToolUse and Stop output in a '
        + 'disposable saved session, but no executed later Khala call returned a batch token for the '
        + 'exact binding and generation. Boundary output and an attempted call are not a receipt; '
        + 'Steer, Sync, Async and acknowledgement remain unsupported.');
    }
    return closed(version, limits, `Codex ${version} has no interactive hook proof; proven versions are `
      + `${[...CODEX_INTERACTIVE_VERSIONS, CODEX_NATIVE_SYNC_VERSION].join(', ')}. ${IDLE}`);
  }
  if (review.state !== 'trusted') {
    const prefix = review.state === 'awaiting_hook_review' ? 'Awaiting hook review' : 'Hook trust unknown';
    return closed(version, limits, `${prefix}: ${review.reason} ${IDLE}`);
  }
  const proven = (route: string, reason: string): ModeSupport => ({
    status: 'proven',
    route,
    testedVersion: version,
    evidenceRef: syncOnlyProof ? CODEX_INTERACTIVE_0157_EVIDENCE_REF : CODEX_INTERACTIVE_EVIDENCE_REF,
    evidenceRevision: codexInteractiveEvidenceRevision(version),
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
    immediateNotification: idleWake === 'available' ? 'native_cli_queue' : 'unknown',
    // Busy handling differs by mode and is stated per mode below.
    busy: 'unknown',
    receiptEvidence: [],
    reconcileByReleaseId: 'unsupported',
    limits,
    evidenceRef: syncOnlyProof ? CODEX_INTERACTIVE_0157_EVIDENCE_REF : CODEX_INTERACTIVE_EVIDENCE_REF,
    modes: {
      steer: syncOnlyProof ? {
        status: 'unknown', route: 'codex-hooks-next-tool-boundary', testedVersion: version,
        evidenceRef: CODEX_INTERACTIVE_0157_EVIDENCE_REF,
        evidenceRevision: CODEX_INTERACTIVE_0157_EVIDENCE_REVISION,
        reason: 'Codex 0.157.1 steer tool-boundary behavior has no native proof.',
      } : proven('codex-hooks-next-tool-boundary', 'steer means the next tool boundary: PreToolUse blocks the '
        + 'next tool, PostToolUse adds a batch that arrived during a tool, and Stop continues once. '
        + `Hard abort is disabled. ${idle}`),
      sync: proven('codex-hooks-stop-or-prompt', 'Delivered after the turn at Stop, or with the next prompt; '
        + `tool boundaries stay silent. ${idle}`),
      async: acknowledged && fullModeProof
        ? proven('codex-khala-read', 'Delivered only when the agent calls khala_read; hooks inject nothing.')
        : {
          status: 'unknown',
          route: 'codex-khala-read',
          testedVersion: version,
          evidenceRef: syncOnlyProof ? CODEX_INTERACTIVE_0157_EVIDENCE_REF : CODEX_INTERACTIVE_EVIDENCE_REF,
          evidenceRevision: codexInteractiveEvidenceRevision(version),
          reason: syncOnlyProof ? `Codex 0.157.1 async has no native proof. ${idle}`
            : `Awaiting a receipt proof: async is not offered until the batch token is proven to come back. ${idle}`,
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
    evidenceRef: version === CODEX_NATIVE_SYNC_VERSION ? CODEX_INTERACTIVE_0157_EVIDENCE_REF
      : version === CODEX_BOUNDARY_ONLY_VERSION ? CODEX_BOUNDARY_ONLY_EVIDENCE_REF : CODEX_INTERACTIVE_EVIDENCE_REF,
    modes: unknownModeSupportMap('codex-interactive-hooks', reason, version),
    acknowledgement: 'unknown',
  };
}
