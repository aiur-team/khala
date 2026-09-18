// Capability report pinned to KHA-103 evidence. Only the exact tested version
// carries evidence; any other version is unknown, never promoted by semver.

import {
  type DeliveryLimits, type HarnessCapabilities, decodeHarnessCapabilities,
} from '@khala/contracts/delivery/index';

export const CLAUDE_HARNESS = 'claude';
export const CLAUDE_ADAPTER_VERSION = 'no-setup-route';
export const CLAUDE_EVIDENCE_REF = 'docs/evidence/claude.md';

/**
 * Claude Code 2.1.276 was exercised in SDK streaming mode (`docs/evidence/claude.md`).
 * No route met the no-setup contract: the `Monitor` watch needs a human permission
 * approval, and channels register only at startup. The receipt levels were still
 * observed, so they stay as evidence while support is `unsupported`.
 */
export const CLAUDE_TESTED_VERSION = '2.1.276';

export function claudeCapabilities(installedVersion: string | null, limits: DeliveryLimits): HarnessCapabilities {
  const tested = installedVersion === CLAUDE_TESTED_VERSION;
  const report = decodeHarnessCapabilities({
    v: 1,
    harness: CLAUDE_HARNESS,
    version: installedVersion ?? 'unknown',
    adapterVersion: CLAUDE_ADAPTER_VERSION,
    support: 'unsupported',
    existingSession: tested ? 'unsupported' : 'unknown',
    immediateNotification: tested ? 'unsupported' : 'unknown',
    busy: 'unknown',
    receiptEvidence: tested ? ['transport_written', 'harness_queued', 'context_consumed', 'completed'] : [],
    reconcileByReleaseId: tested ? 'unsupported' : 'unknown',
    limits,
    evidenceRef: tested ? CLAUDE_EVIDENCE_REF : null,
  });
  if (report.ok) return report.value;
  // A version string the contract cannot carry is reported as unknown, not echoed.
  if (installedVersion !== null) return claudeCapabilities(null, limits);
  throw new Error(`claude capabilities: invalid ${report.field}`);
}
