// Capability report pinned to KHA-145 evidence. Only the exact tested version
// carries evidence; any other version is unknown, never promoted by semver.

import {
  type DeliveryLimits, type HarnessCapabilities, decodeHarnessCapabilities, unknownModeSupportMap,
} from '@khala/contracts/delivery/index';

export const CLAUDE_HARNESS = 'claude';
export const CLAUDE_ADAPTER_VERSION = 'native-route-unavailable-1';
export const CLAUDE_EVIDENCE_REF = 'docs/evidence/claude-native-cli.md';

/**
 * Claude Code 2.1.276 was exercised by KHA-145. The agent-child socket route was
 * not live-proven, while the hosted stream route failed the existing-session and
 * reconnect requirements. The adapter therefore remains unsupported.
 */
export const CLAUDE_TESTED_VERSION = '2.1.276';

export function claudeCapabilities(installedVersion: string | null, limits: DeliveryLimits): HarnessCapabilities {
  const tested = installedVersion === CLAUDE_TESTED_VERSION;
  const report = decodeHarnessCapabilities({
    v: 3,
    harness: CLAUDE_HARNESS,
    version: installedVersion ?? 'unknown',
    adapterVersion: CLAUDE_ADAPTER_VERSION,
    support: 'unsupported',
    existingSession: tested ? 'unsupported' : 'unknown',
    immediateNotification: tested ? 'unsupported' : 'unknown',
    busy: 'unknown',
    // These are connector-side refusal/uncertainty outcomes, not native support claims.
    receiptEvidence: ['failed'],
    reconcileByReleaseId: tested ? 'unsupported' : 'unknown',
    limits,
    evidenceRef: tested ? CLAUDE_EVIDENCE_REF : null,
    modes: unknownModeSupportMap(
      'claude-interactive-hooks',
      tested
        ? 'The retained negative predates the interactive hook routes; idle agents receive messages only at their next turn until those routes are proved.'
        : 'This exact Claude version and interactive hook route have not been inspected.',
      installedVersion ?? 'unknown',
    ),
    acknowledgement: 'unknown',
  });
  if (report.ok) return report.value;
  // A version string the contract cannot carry is reported as unknown, not echoed.
  if (installedVersion !== null) return claudeCapabilities(null, limits);
  throw new Error(`claude capabilities: invalid ${report.field}`);
}
