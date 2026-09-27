import { describe, expect, it } from 'vitest';
import type { BindingId, ReceiptId, ReleaseId } from '@khala/contracts/delivery/ids';
import type { DeliveryReceipt } from '@khala/contracts/delivery/index';
import { receiptKindLabel, receiptLabel } from './receipt-labels';

const releaseId = 'release_1' as ReleaseId;

function receipt(overrides: Partial<DeliveryReceipt> = {}): DeliveryReceipt {
  return {
    v: 1,
    receiptId: 'receipt_1' as ReceiptId,
    releaseId,
    bindingId: 'bind_1' as BindingId,
    generation: 0,
    kind: 'transport_written',
    observedAt: '2026-09-17T00:00:00Z',
    source: 'connector',
    evidenceRef: null,
    errorCode: null,
    ...overrides,
  };
}

describe('receipt-labels', () => {
  it('never labels any receipt kind as read or consumed', () => {
    for (const kind of ['transport_written', 'harness_queued', 'context_consumed', 'completed', 'agent_acknowledged'] as const) {
      expect(receiptKindLabel(kind).toLowerCase()).not.toMatch(/\bread\b|consumed/);
    }
  });

  it('names context insertion, completion and token return as their own observable boundaries', () => {
    expect(receiptKindLabel('context_consumed')).toBe('Added to agent context');
    expect(receiptKindLabel('completed')).toBe('Agent turn completed');
    expect(receiptKindLabel('agent_acknowledged')).toBe('Batch token returned');
  });

  it('appends the closed-vocabulary error reason when present', () => {
    const label = receiptLabel(receipt({ kind: 'failed', errorCode: 'harness_unavailable' }));
    expect(label).toContain('Delivery failed');
    expect(label).toContain('unavailable');
  });
});
