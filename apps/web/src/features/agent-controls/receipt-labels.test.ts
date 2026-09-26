import { describe, expect, it } from 'vitest';
import { decodeDeliveryReceipt, type DeliveryReceipt } from '@khala/contracts/delivery/index';
import { receiptDetailFromDecoded, receiptLabel } from './receipt-labels';

function receipt(overrides: Partial<DeliveryReceipt> = {}): DeliveryReceipt {
  return {
    v: 1,
    receiptId: 'receipt-1' as never,
    releaseId: 'release-1' as never,
    bindingId: 'bind-1' as never,
    generation: 0,
    kind: 'queued',
    observedAt: '2026-09-18T00:00:00Z',
    source: 'connector',
    evidenceRef: null,
    errorCode: null,
    ...overrides,
  };
}

describe('receiptLabel', () => {
  it('never implies context_consumed from transport_written', () => {
    expect(receiptLabel(receipt({ kind: 'transport_written' }))).not.toContain('context');
  });

  it('never implies context_consumed from harness_queued', () => {
    expect(receiptLabel(receipt({ kind: 'harness_queued' }))).not.toContain('context');
  });

  it('labels context_consumed as context insertion, never as read, and completion never as a token return', () => {
    expect(receiptLabel(receipt({ kind: 'context_consumed' }))).toBe('Added to agent context');
    expect(receiptLabel(receipt({ kind: 'completed' }))).toBe('Agent turn completed');
    expect(receiptLabel(receipt({ kind: 'completed' }))).not.toMatch(/token|read/i);
  });

  it('stays visible and distinct for outcome_unknown, independent of connector status', () => {
    const label = receiptLabel(receipt({ kind: 'outcome_unknown' }));
    expect(label).toContain('unknown');
  });

  it('a delivery cancellation is never worded as stopping the model turn', () => {
    const label = receiptLabel(receipt({ kind: 'cancelled' }));
    expect(label.toLowerCase()).not.toContain('model');
    expect(label.toLowerCase()).not.toContain('stopped');
  });

  it('includes the closed error vocabulary for a failed receipt', () => {
    const label = receiptLabel(receipt({ kind: 'failed', errorCode: 'harness_unavailable' }));
    expect(label).toContain('harness was unavailable');
  });
});

describe('receiptDetailFromDecoded', () => {
  it('shows a generic unavailable detail for a malformed receipt, never the raw payload', () => {
    const decoded = decodeDeliveryReceipt({ v: 1, kind: 'not_a_real_kind' });
    expect(decoded.ok).toBe(false);
    const detail = receiptDetailFromDecoded(decoded);
    expect(detail).toBe('Delivery status unavailable.');
    expect(detail).not.toContain('not_a_real_kind');
  });

  it('renders the normal label for a well-formed decoded receipt', () => {
    const decoded = decodeDeliveryReceipt(receipt({ kind: 'completed' }));
    const detail = receiptDetailFromDecoded(decoded);
    expect(detail).toBe('Agent turn completed');
  });
});
