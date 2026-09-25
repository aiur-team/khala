// Capability report for the OpenCode plugin route. The route vocabulary and its
// evidence keys belong to `opencode-delivery-contract`; until that contract names
// them, this adapter claims nothing and the connector never selects it.

import {
  type DeliveryLimits, type HarnessCapabilities, decodeHarnessCapabilities, unknownModeSupportMap,
} from '@khala/contracts/delivery/index';

export const OPENCODE_HARNESS = 'opencode';
export const OPENCODE_ADAPTER_VERSION = 'inbox-notifier-1';

/** Outcomes this adapter can observe itself; none claims model consumption. */
export const OPENCODE_RECEIPT_EVIDENCE = ['transport_written', 'outcome_unknown', 'failed'] as const;

export function openCodeCapabilities(installedVersion: string | null, limits: DeliveryLimits): HarnessCapabilities {
  const report = decodeHarnessCapabilities({
    v: 3,
    harness: OPENCODE_HARNESS,
    version: installedVersion ?? 'unknown',
    adapterVersion: OPENCODE_ADAPTER_VERSION,
    support: 'unsupported',
    existingSession: 'unknown',
    immediateNotification: 'unknown',
    busy: 'unknown',
    receiptEvidence: [...OPENCODE_RECEIPT_EVIDENCE],
    reconcileByReleaseId: 'unsupported',
    limits,
    evidenceRef: null,
    modes: unknownModeSupportMap(
      'opencode-plugin',
      'The OpenCode plugin route has no admitted evidence key yet; a durable inbox hint is not a delivery proof.',
      installedVersion ?? 'unknown',
    ),
    acknowledgement: 'unknown',
  });
  if (report.ok) return report.value;
  // A version string the contract cannot carry is reported as unknown, not echoed.
  if (installedVersion !== null) return openCodeCapabilities(null, limits);
  throw new Error(`opencode capabilities: invalid ${report.field}`);
}
