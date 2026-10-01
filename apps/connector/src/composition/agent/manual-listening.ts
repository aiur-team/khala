import { decodeDeliveryLimits, type HarnessCapabilities, type SessionBinding } from '@khala/contracts/delivery/index';
import type { AcknowledgementRecorder } from '@khala/connector/storage/acknowledgements';

const limits = (() => {
  const decoded = decodeDeliveryLimits({ maxSelectionEvents: 20, maxPayloadBytes: 64 * 1024 });
  if (!decoded.ok) throw new Error('manual_listening_limits_invalid');
  return decoded.value;
})();

/** A manual MCP release is an inbox write, not proof of a native listening mode. */
export type ManualReadProof = Readonly<{
  bindingId: SessionBinding['bindingId'];
  generation: number;
  kind: 'agent_acknowledged';
  source: 'agent';
}>;

/** Only an agent-returned token for this exact binding generation opens explicit pull. */
export async function manualReadProof(
  recorder: Pick<AcknowledgementRecorder, 'readReceiptOutbox'>,
  binding: SessionBinding,
): Promise<ManualReadProof | null> {
  try {
    // A full page without a match stays unsupported. Never infer proof from a
    // cursor that could skip another row at the same ledger revision.
    const page = await recorder.readReceiptOutbox({ limit: 100 });
    const match = page.find(entry => entry.receipt.kind === 'agent_acknowledged'
      && entry.receipt.source === 'agent'
      && entry.receipt.bindingId === binding.bindingId
      && entry.receipt.generation === binding.generation);
    return match ? { bindingId: binding.bindingId, generation: binding.generation,
      kind: 'agent_acknowledged', source: 'agent' } : null;
  } catch { return null; }
}

export function manualListeningCapabilities(
  binding: SessionBinding,
  harness: 'claude' | 'codex',
  version: string,
  proof: ManualReadProof | null,
): HarnessCapabilities {
  const acknowledged = version !== 'unknown'
    && proof?.bindingId === binding.bindingId && proof.generation === binding.generation
    && proof.kind === 'agent_acknowledged' && proof.source === 'agent';
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
    version,
    adapterVersion: 'hosted-manual-mcp-1',
    support: acknowledged ? 'tested' : 'unsupported',
    existingSession: 'unknown',
    immediateNotification: 'unsupported',
    busy: 'unknown',
    receiptEvidence: [],
    reconcileByReleaseId: 'unsupported',
    limits,
    evidenceRef: acknowledged ? 'docs/evidence/hosted-manual-mcp.md' : null,
    modes: {
      steer: unsupported('steer', 'This hosted MCP binding has no native Steer delivery hook.'),
      sync: unsupported('sync', 'This hosted MCP binding has no native Sync delivery hook.'),
      async: acknowledged ? {
        status: 'proven',
        route: `hosted-manual-mcp-${harness}-explicit-pull`,
        testedVersion: version,
        evidenceRef: 'docs/evidence/hosted-manual-mcp.md',
        evidenceRevision: 'hosted-manual-mcp-2026-10-01',
        reason: 'The agent reads the approved batch explicitly; native hooks do not inject it.',
      } : unsupported('async', 'This binding has no model-visible explicit-read and next-call receipt proof.'),
    },
    acknowledgement: acknowledged ? 'batch_token_next_call' : 'unknown',
  };
}
