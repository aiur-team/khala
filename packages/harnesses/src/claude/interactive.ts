// Capability claims for delivery into the user's own interactive Claude Code CLI through
// the Khala plugin's hooks and MCP entry. Khala never starts, hosts or signals Claude here.

import {
  type DeliveryLimits, type HarnessCapabilities, type ListeningMode, type ModeSupport,
  decodeHarnessCapabilities, unknownModeSupportMap,
} from '@khala/contracts/delivery/index';
import { CLAUDE_HARNESS, claudeCapabilities } from './capabilities';

export const CLAUDE_INTERACTIVE_ROUTE = 'claude-interactive-hooks';
export const CLAUDE_INTERACTIVE_ADAPTER_VERSION = 'claude-session-adapter-1';
export const CLAUDE_INTERACTIVE_EVIDENCE_REF = 'experiments/internal-mode/read-receipts/claude/evidence.json';
/** Changes whenever the route's evidence changes, so an owner's experimental grant lapses with it. */
export const CLAUDE_INTERACTIVE_EVIDENCE_REVISION = 'interactive-claude-2026-09-27';
export const CLAUDE_INTERACTIVE_MODE_EVIDENCE_REF = 'experiments/internal-mode/listening-modes/claude/evidence.json';
export const CLAUDE_INTERACTIVE_MODE_EVIDENCE_REVISION = 'interactive-claude-modes-2026-09-27';

/** One exact Claude Code version and delivery route that passed the receipt conformance run. */
export type ClaudeProvenRoute = Readonly<{ version: string; route: typeof CLAUDE_INTERACTIVE_ROUTE }>;

/**
 * Exact pairs with a retained normal-trust interactive CLI receipt run (see the
 * evidence file's `provenPairs`). Decision 43 permits the Executor to launch the
 * fixture. A version is never promoted by semver, a hook firing, or offline tests.
 */
export const CLAUDE_INTERACTIVE_PROVEN: readonly ClaudeProvenRoute[] = [
  { version: '2.1.283', route: CLAUDE_INTERACTIVE_ROUTE },
];

/** Native, normal-trust mode cells retained separately from the receipt proof. */
export type ClaudeProvenMode = ClaudeProvenRoute & Readonly<{ mode: ListeningMode }>;
export const CLAUDE_INTERACTIVE_MODE_PROVEN: readonly ClaudeProvenMode[] = [
  { version: '2.1.283', route: CLAUDE_INTERACTIVE_ROUTE, mode: 'steer' },
  { version: '2.1.283', route: CLAUDE_INTERACTIVE_ROUTE, mode: 'async' },
];

const IDLE = 'Idle agents receive messages only at their next turn.';
const WATCHER = 'Idle wake works only while the Stop-armed watcher is live, for at most 3000 seconds after arming;'
  + ' after it expires, messages wait until the next native turn. Proof covers human-authored releases only.';
const SYNC_REARM = 'Native Stop delivery and a live-watcher idle wake were observed on Claude Code 2.1.283.'
  + ' Sync remains experimental until a native, automation-fenced rearm delivers after watcher timeout without a user prompt.'
  + ' After the 3000-second watcher expires, messages wait until the next native turn. Proof covers human-authored releases only.';

/**
 * Declares the interactive route for one inspected Claude Code version. An exact
 * version/route pair in `proven` is `tested`. Any other inspected version on this route
 * is `experimental` (decisions 34 and 37): it delivers with batch-token acknowledgement,
 * but its modes need the owner's experimental-route grant. Each mode has its own
 * normal-trust proof registry; receipt proof alone cannot promote one. Another
 * route claims nothing.
 */
export function interactiveClaudeCapabilities(
  version: string,
  route: string,
  limits: DeliveryLimits,
  proven: readonly ClaudeProvenRoute[] = CLAUDE_INTERACTIVE_PROVEN,
  modeProven: readonly ClaudeProvenMode[] = CLAUDE_INTERACTIVE_MODE_PROVEN,
): HarnessCapabilities {
  if (route !== CLAUDE_INTERACTIVE_ROUTE) {
    return closed(version, limits, `Claude Code ${version} on route ${route} is not a Khala delivery route. ${IDLE}`);
  }
  if (version === '2.1.286' || version === '2.1.287') {
    return closed(version, limits,
      `Claude Code ${version} has no retained model-visible, session-bound delivery receipt on ${route}. Native hook visibility and a local session ID do not prove delivery. ${IDLE}`);
  }
  const tested = proven.some(pair => pair.version === version && pair.route === route);
  const reason = tested
    // A separate mode proof is required even when the receipt route is tested.
    ? `Mode delivery is proven separately; until then this mode is experimental. ${IDLE}`
    : `Claude Code ${version} on route ${route} has no retained read-receipt proof, so this route is experimental. ${IDLE}`;
  const experimental = (mode: ListeningMode): ModeSupport => ({
    status: 'experimental',
    route: `${route}-${mode}`,
    testedVersion: version,
    evidenceRef: tested && version === '2.1.283' && mode === 'sync'
      ? CLAUDE_INTERACTIVE_MODE_EVIDENCE_REF : CLAUDE_INTERACTIVE_EVIDENCE_REF,
    evidenceRevision: tested && version === '2.1.283' && mode === 'sync'
      ? CLAUDE_INTERACTIVE_MODE_EVIDENCE_REVISION : CLAUDE_INTERACTIVE_EVIDENCE_REVISION,
    reason: tested && version === '2.1.283' && mode === 'sync' ? SYNC_REARM : reason,
  });
  const modeSupport = (mode: ListeningMode): ModeSupport => tested
    && modeProven.some(pair => pair.version === version && pair.route === route && pair.mode === mode)
    ? {
        status: 'proven', route: `${route}-${mode}`, testedVersion: version,
        evidenceRef: CLAUDE_INTERACTIVE_MODE_EVIDENCE_REF,
        evidenceRevision: CLAUDE_INTERACTIVE_MODE_EVIDENCE_REVISION,
        reason: mode === 'async'
          ? 'Agent-chosen native read only; hooks do not automatically deliver in async mode. Proof covers human-authored releases only.'
          : WATCHER,
      }
    : experimental(mode);
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
    modes: { steer: modeSupport('steer'), sync: modeSupport('sync'), async: modeSupport('async') },
    acknowledgement: 'batch_token_next_call',
  };
}

/** The shape `claude --version` reports once parsed, such as `2.1.283`. */
const INSPECTED_VERSION = /^\d+\.\d+\.\d+$/u;

/** Evidence obtained from the live provider process for the session being inspected. */
export type ClaudeProcessVersionEvidence = Readonly<{
  source: 'provider_process';
  version: string;
  sessionId: string;
  bindingId: string;
  generation: number;
  processId: number;
}>;

export type ClaudeSessionScope = Readonly<{ sessionId: string; bindingId: string; generation: number }>;

/**
 * A PATH executable version describes an installation, not the already-running
 * session. Only a provider-process observation can label that session. The
 * process observation does not itself prove delivery or a receipt: those remain
 * limited to the separately retained exact route/version proof above.
 */
export function installedClaudeCapabilities(
  version: string | null,
  limits: DeliveryLimits,
  processEvidence?: ClaudeProcessVersionEvidence,
  scope?: ClaudeSessionScope,
): HarnessCapabilities {
  if (!processEvidence || !scope || processEvidence.source !== 'provider_process'
    || !INSPECTED_VERSION.test(processEvidence.version)
    || scope.sessionId.trim() === '' || scope.bindingId.trim() === ''
    || !Number.isSafeInteger(scope.generation) || scope.generation <= 0
    || processEvidence.sessionId !== scope.sessionId
    || processEvidence.bindingId !== scope.bindingId
    || processEvidence.generation !== scope.generation
    || !Number.isSafeInteger(processEvidence.processId) || processEvidence.processId <= 0) {
    // A PATH probe may still describe an experimental installation, but it
    // cannot promote the version of a live session to tested support.
    if (version !== null && INSPECTED_VERSION.test(version)
      && version !== '2.1.286' && version !== '2.1.287') {
      const unbound = decodeHarnessCapabilities(interactiveClaudeCapabilities(
        version, CLAUDE_INTERACTIVE_ROUTE, limits, [], []));
      if (unbound.ok) return unbound.value;
    }
    return claudeCapabilities(null, limits);
  }
  // `version` is the PATH probe and may differ from the live executable.
  // Never use it to override process evidence or infer a receipt.
  void version;
  const claimed = decodeHarnessCapabilities(interactiveClaudeCapabilities(
    processEvidence.version, CLAUDE_INTERACTIVE_ROUTE, limits));
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
