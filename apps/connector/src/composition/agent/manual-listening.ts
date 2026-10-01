import { decodeDeliveryLimits, type HarnessCapabilities } from '@khala/contracts/delivery/index';

const limits = (() => {
  const decoded = decodeDeliveryLimits({ maxSelectionEvents: 20, maxPayloadBytes: 64 * 1024 });
  if (!decoded.ok) throw new Error('manual_listening_limits_invalid');
  return decoded.value;
})();

/** A manual MCP release is an inbox write, not proof of a native listening mode. */
export function manualListeningCapabilities(harness: 'claude' | 'codex'): HarnessCapabilities {
  const unsupported = (mode: 'steer' | 'sync' | 'async', reason: string) => ({
    status: 'unsupported' as const,
    route: `hosted-manual-mcp-${harness}-${mode}`,
    evidenceRef: null,
    evidenceRevision: null,
    reason,
  });
  return {
    v: 3,
    harness,
    version: 'unknown',
    adapterVersion: 'hosted-manual-mcp-1',
    support: 'unsupported',
    existingSession: 'unknown',
    immediateNotification: 'unsupported',
    busy: 'unknown',
    receiptEvidence: [],
    reconcileByReleaseId: 'unsupported',
    limits,
    evidenceRef: null,
    modes: {
      steer: unsupported('steer', 'This hosted MCP binding has no native Steer delivery hook.'),
      sync: unsupported('sync', 'This hosted MCP binding has no native Sync delivery hook.'),
      async: unsupported('async', 'This binding has no model-visible explicit-read and next-call receipt proof.'),
    },
    acknowledgement: 'unknown',
  };
}
