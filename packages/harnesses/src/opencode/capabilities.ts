// Capability report for the OpenCode plugin route. The vocabulary, the evidence keys
// and the report itself belong to the delivery contract (`openCodePluginCapabilities`);
// this adapter only decides which claims the plugin may be credited with.

import {
  type DeliveryLimits, type HarnessCapabilities, type OpenCodeRouteEvidenceKey, decodeHarnessCapabilities,
  decodeOpenCodeRouteEvidenceKey, openCodePluginCapabilities,
} from '@khala/contracts/delivery/index';

/**
 * The report for what the plugin said about itself. Claims that do not decode are
 * dropped, and the contract resolves anything unrecorded to unproven, so a plugin that
 * is not bound to the exact binding generation passes no claims and is `unsupported`.
 */
export function openCodeCapabilities(
  installedVersion: string | null,
  claims: readonly unknown[],
  limits: DeliveryLimits,
): HarnessCapabilities {
  const decoded: OpenCodeRouteEvidenceKey[] = [];
  for (const claim of claims) {
    const key = decodeOpenCodeRouteEvidenceKey(claim);
    if (key.ok) decoded.push(key.value);
  }
  const report = decodeHarnessCapabilities(
    openCodePluginCapabilities({ version: installedVersion ?? 'unknown', limits, claims: decoded }),
  );
  if (report.ok) return report.value;
  // A version string the contract cannot carry is reported as unknown, not echoed.
  if (installedVersion !== null) return openCodeCapabilities(null, [], limits);
  throw new Error(`opencode capabilities: invalid ${report.field}`);
}
