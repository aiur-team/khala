// Capability records for the Claude app shapes, one per shape. A mode is proven
// only by an admitted exact-tuple row; everything else is `unknown` with its reason.

import {
  type AppHarnessBoundaries, type AppHarnessIdentity, type AppHarnessRecord, type DeliveryLimits,
  type ListeningMode, type ModeSupport, LISTENING_MODES, decodeAppHarnessRecord, unknownModeSupport,
} from '@khala/contracts/delivery/index';
import {
  CLAUDE_APP_EVIDENCE, CLAUDE_APP_PROOF_REF, type ClaudeAppEvidence, type ClaudeAppShape, admittedEvidence,
  identityComplete,
} from './evidence';

/** The contract keys app records by `app`, so capabilities carry the shared `claude` harness name. */
export const CLAUDE_APP_HARNESS = 'claude';
export const CLAUDE_APP_ADAPTER_VERSION = 'claude-app-pull-1';

const IDLE = 'Idle agents receive messages only at their next turn.';

/** What inspection could establish. `null` means the field was not observed. */
export type ClaudeAppObservation = Readonly<{
  shape: ClaudeAppShape;
  appVersion: string | null;
  accountTier: string | null;
  administratorPolicyScope: string | null;
}>;

export function claudeAppIdentity(observation: ClaudeAppObservation): AppHarnessIdentity {
  return {
    v: 1,
    app: 'claude',
    shape: observation.shape,
    appVersion: observation.appVersion ?? 'unknown',
    accountTier: observation.accountTier ?? 'unknown',
    administratorPolicyScope: observation.administratorPolicyScope ?? 'unknown',
  };
}

export function claudeAppRecord(
  observation: ClaudeAppObservation,
  limits: DeliveryLimits,
  evidence: readonly ClaudeAppEvidence[] = CLAUDE_APP_EVIDENCE,
): AppHarnessRecord {
  const identity = claudeAppIdentity(observation);
  const admitted = Object.fromEntries(
    LISTENING_MODES.map(mode => [mode, admittedEvidence(identity, mode, evidence)]),
  ) as Record<ListeningMode, ClaudeAppEvidence | null>;
  const modes = Object.fromEntries(LISTENING_MODES.map(mode => [
    mode, modeSupport(identity, mode, admitted[mode]),
  ])) as Record<ListeningMode, ModeSupport>;
  const proven = LISTENING_MODES.some(mode => admitted[mode] !== null);
  const boundaries: AppHarnessBoundaries = {
    steer: admitted.steer?.boundary as AppHarnessBoundaries['steer'] ?? null,
    sync: admitted.sync?.boundary as AppHarnessBoundaries['sync'] ?? null,
    async: admitted.async?.boundary as AppHarnessBoundaries['async'] ?? null,
  };
  const decoded = decodeAppHarnessRecord({
    ...identity,
    boundaries,
    capabilities: {
      v: 3,
      harness: CLAUDE_APP_HARNESS,
      version: identity.appVersion,
      adapterVersion: CLAUDE_APP_ADAPTER_VERSION,
      support: proven ? 'tested' : 'unsupported',
      // No existing-session route in the shared vocabulary describes an app-driven
      // MCP pull; the per-mode rows are the claim.
      existingSession: 'unknown',
      immediateNotification: 'unknown',
      busy: 'unknown',
      // Connector-side refusals only; the adapter never pushes into the app.
      receiptEvidence: ['failed'],
      reconcileByReleaseId: 'unknown',
      limits,
      evidenceRef: proven ? CLAUDE_APP_PROOF_REF : null,
      modes,
      acknowledgement: admitted.async === null ? 'unknown' : 'batch_token_next_call',
    },
  });
  if (decoded.ok) return decoded.value;
  // A value the contract cannot carry is reported as uninspected, never echoed.
  const blank = { shape: observation.shape, appVersion: null, accountTier: null, administratorPolicyScope: null };
  const observed = [observation.appVersion, observation.accountTier, observation.administratorPolicyScope]
    .some(field => field !== null);
  if (observed) return claudeAppRecord(blank, limits, evidence);
  throw new Error(`claude app capabilities: invalid ${decoded.field}`);
}

function modeSupport(identity: AppHarnessIdentity, mode: ListeningMode, row: ClaudeAppEvidence | null): ModeSupport {
  const route = `claude-app-${identity.shape}-${mode}`;
  if (row !== null) {
    return {
      status: 'proven',
      route: row.route,
      testedVersion: identity.appVersion,
      evidenceRef: row.evidenceRef,
      evidenceRevision: row.evidenceRevision,
      reason: mode === 'async' ? 'Delivered only when the agent calls khala_read.' : IDLE,
    };
  }
  return unknownModeSupport(route, unprovenReason(identity, mode), identity.appVersion);
}

function unprovenReason(identity: AppHarnessIdentity, mode: ListeningMode): string {
  if (!identityComplete(identity)) {
    return `The Claude ${identity.shape} version, account tier, or administrator policy was not inspected, `
      + `so no proof can match. ${IDLE}`;
  }
  if (mode === 'async') {
    return `No exact-version proof covers the khala_read pull route for this Claude ${identity.shape} tuple. ${IDLE}`;
  }
  // Push modes need a proven injection boundary; Khala never polls in their place.
  return `No injection boundary into this Claude ${identity.shape} tuple is proven, and polling is not ${mode}. ${IDLE}`;
}
