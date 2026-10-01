import { AsyncLocalStorage } from 'node:async_hooks';
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

/** Process-local route witness: a hook ACK from before this manual session cannot prove a pull. */
export function createManualReadWitness() {
  const explicitReadCall = new AsyncLocalStorage<boolean>();
  const offered = new Map<string, Readonly<{ bindingId: string; generation: number }>>();
  const acknowledged = new Map<string, string>();
  const bindingKey = (bindingId: string, generation: number) => JSON.stringify([bindingId, generation]);
  return {
    withinExplicitRead<T>(read: () => Promise<T>): Promise<T> { return explicitReadCall.run(true, read); },
    offer(bindingId: string, generation: number, token: string) {
      offered.set(token, { bindingId, generation });
      if (offered.size > 100) offered.delete(offered.keys().next().value!);
    },
    acknowledge(bindingId: string, generation: number, token: string, releaseIds: readonly string[]) {
      const issued = offered.get(token);
      offered.delete(token);
      if (explicitReadCall.getStore() === true && issued?.bindingId === bindingId
        && issued.generation === generation && releaseIds.length > 0) {
        acknowledged.set(bindingKey(bindingId, generation), releaseIds[0]!);
      }
    },
    includes(bindingId: string, generation: number, releaseId: string) {
      return acknowledged.get(bindingKey(bindingId, generation)) === releaseId;
    },
    latest(bindingId: string, generation: number) {
      return acknowledged.get(bindingKey(bindingId, generation)) ?? null;
    },
  };
}

export type ManualReadWitness = ReturnType<typeof createManualReadWitness>;

/** Only an agent-returned token for this exact binding generation opens explicit pull. */
export async function manualReadProof(
  recorder: Pick<AcknowledgementRecorder, 'readAgentAcknowledgement'>,
  binding: SessionBinding,
  witness: Pick<ManualReadWitness, 'latest'>,
): Promise<ManualReadProof | null> {
  try {
    const releaseId = witness.latest(binding.bindingId, binding.generation);
    if (releaseId === null) return null;
    const receipt = await recorder.readAgentAcknowledgement({ bindingId: binding.bindingId,
      generation: binding.generation }, releaseId as never);
    return receipt?.kind === 'agent_acknowledged' && receipt.source === 'agent'
      && receipt.bindingId === binding.bindingId && receipt.generation === binding.generation
      && receipt.releaseId === releaseId
      ? { bindingId: binding.bindingId, generation: binding.generation,
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
