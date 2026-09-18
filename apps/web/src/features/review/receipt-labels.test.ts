import { describe, expect, it } from 'vitest';
import type { BindingId, ReceiptId, ReleaseId } from '@khala/contracts/delivery/ids';
import type { DeliveryReceipt } from '@khala/contracts/delivery/index';
import { isConsumedByAgent, latestReceiptFor, receiptKindLabel, receiptLabel } from './receipt-labels';

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
  it('never labels transport_written as read/consumed', () => {
    const label = receiptKindLabel('transport_written');
    expect(label.toLowerCase()).not.toContain('read');
    expect(label.toLowerCase()).not.toContain('consumed');
  });

  it('context_consumed is required for the "read by the agent" label', () => {
    expect(receiptKindLabel('context_consumed').toLowerCase()).toContain('read');
  });

  it('isConsumedByAgent is false on transport_written alone', () => {
    const receipts = [receipt({ kind: 'transport_written' })];
    expect(isConsumedByAgent(releaseId, receipts)).toBe(false);
  });

  it('isConsumedByAgent is true only once correlated context_consumed/completed evidence exists', () => {
    const receipts = [receipt({ kind: 'transport_written' }), receipt({ kind: 'context_consumed', observedAt: '2026-09-17T00:01:00Z' })];
    expect(isConsumedByAgent(releaseId, receipts)).toBe(true);
  });

  it('isConsumedByAgent ignores receipts for a different release', () => {
    const receipts = [receipt({ kind: 'context_consumed', releaseId: 'release_other' as ReleaseId })];
    expect(isConsumedByAgent(releaseId, receipts)).toBe(false);
  });

  it('appends the closed-vocabulary error reason when present', () => {
    const label = receiptLabel(receipt({ kind: 'failed', errorCode: 'harness_unavailable' }));
    expect(label).toContain('Delivery failed');
    expect(label).toContain('unavailable');
  });

  it('latestReceiptFor returns the most recently observed receipt for that release only', () => {
    const receipts = [
      receipt({ kind: 'queued', observedAt: '2026-09-17T00:00:00Z' }),
      receipt({ kind: 'transport_written', observedAt: '2026-09-17T00:02:00Z' }),
      receipt({ kind: 'dispatching', observedAt: '2026-09-17T00:01:00Z' }),
      receipt({ kind: 'completed', observedAt: '2026-09-17T00:05:00Z', releaseId: 'release_other' as ReleaseId }),
    ];
    expect(latestReceiptFor(releaseId, receipts)?.kind).toBe('transport_written');
  });

  it('latestReceiptFor returns null when no receipt exists for the release', () => {
    expect(latestReceiptFor(releaseId, [])).toBeNull();
  });
});
