// Test fixtures for receipt evidence: wire-shaped facts exactly as the owner-gated
// receipts route serves them.

import type { ReceiptKindV2 } from '@khala/contracts/delivery/index';

export type WireFact = Readonly<{
  receipt: Readonly<Record<string, unknown>>;
  evidenceRef: string;
  events: readonly Readonly<{ eventId: string; sequence: number | null }>[];
}>;

let counter = 0;

export function wireFact(input: Readonly<{
  kind: ReceiptKindV2;
  releaseId: string;
  events: readonly (string | Readonly<{ eventId: string; sequence: number | null }>)[];
  receiptId?: string;
  observedAt?: string;
  batch?: string;
}>): WireFact {
  const acknowledged = input.kind === 'agent_acknowledged';
  const evidenceRef = acknowledged ? input.batch ?? 'ack_batch' : `ref_${input.releaseId}`;
  return {
    receipt: {
      v: acknowledged ? 2 : 1,
      receiptId: input.receiptId ?? `receipt_${input.kind}_${input.releaseId}_${counter += 1}`,
      releaseId: input.releaseId,
      bindingId: 'binding_1',
      generation: 1,
      kind: input.kind,
      observedAt: input.observedAt ?? '2026-09-25T00:00:00.000Z',
      source: acknowledged ? 'agent' : input.kind === 'transport_written' ? 'connector' : 'harness',
      evidenceRef: acknowledged ? evidenceRef : null,
      errorCode: input.kind === 'failed' ? 'timeout' : null,
    },
    evidenceRef,
    events: input.events.map((event, index) => (typeof event === 'string' ? { eventId: event, sequence: index + 1 } : event)),
  };
}

/** The route body for a set of wire facts, with groups derived as the server derives them. */
export function wireBody(facts: readonly WireFact[]): Readonly<{ v: 1; facts: readonly WireFact[]; groups: unknown[] }> {
  const groups = new Map<string, string[]>();
  for (const fact of facts) groups.set(fact.evidenceRef, [...(groups.get(fact.evidenceRef) ?? []), String(fact.receipt.receiptId)]);
  return { v: 1, facts, groups: [...groups].map(([evidenceRef, receiptIds]) => ({ evidenceRef, receiptIds })) };
}
