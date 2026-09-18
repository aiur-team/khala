// Content-free receipts with stable identities: the same release, binding
// generation and outcome always yield the same receipt ID, across restarts.

import { createHash } from 'node:crypto';
import type {
  DeliveryReceipt, ReceiptErrorCode, ReceiptId, ReleasedJob,
} from '@khala/contracts/delivery/index';

/**
 * A `failed` receipt observed by the adapter itself. Its source is `connector`
 * because there is no native harness response to cite.
 */
export function failedReceipt(job: ReleasedJob, errorCode: ReceiptErrorCode, observedAt: Date): DeliveryReceipt {
  const { releaseId, binding } = job;
  const digest = createHash('sha256')
    .update(JSON.stringify(['claude', binding.bindingId, binding.generation, releaseId, 'failed', errorCode]))
    .digest('hex');
  return {
    v: 1,
    receiptId: `claude-receipt-${digest}` as ReceiptId,
    releaseId,
    bindingId: binding.bindingId,
    generation: binding.generation,
    kind: 'failed',
    observedAt: observedAt.toISOString(),
    source: 'connector',
    evidenceRef: null,
    errorCode,
  };
}
