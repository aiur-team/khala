// Content-free receipts with stable identities: the same release, binding
// generation and outcome always yield the same receipt ID, across restarts.

import { createHash } from 'node:crypto';
import type {
  Clock, DeliveryReceipt, ReceiptErrorCode, ReceiptId, ReleasedJob,
} from '@khala/contracts/delivery/index';

/** Exactly the `receiptEvidence` of `openCodePluginCapabilities`. */
export type OpenCodeReceiptKind = 'harness_queued' | 'outcome_unknown' | 'failed';

export function openCodeReceipt(
  job: ReleasedJob,
  kind: OpenCodeReceiptKind,
  clock: Clock,
  errorCode: ReceiptErrorCode | null = null,
): DeliveryReceipt {
  const { releaseId, binding } = job;
  const digest = createHash('sha256')
    .update(JSON.stringify(['opencode', binding.bindingId, binding.generation, releaseId, kind, errorCode]))
    .digest('hex');
  return {
    v: 1,
    receiptId: `opencode-receipt-${digest}` as ReceiptId,
    releaseId,
    bindingId: binding.bindingId,
    generation: binding.generation,
    kind,
    observedAt: clock.now().toISOString(),
    source: 'connector',
    evidenceRef: null,
    errorCode,
  };
}
