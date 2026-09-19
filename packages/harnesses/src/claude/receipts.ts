// Content-free receipts with stable identities: the same release, binding
// generation and outcome always yield the same receipt ID, across restarts.

import { createHash } from 'node:crypto';
import type {
  Clock, DeliveryReceipt, ReceiptErrorCode, ReceiptId, ReleasedJob,
} from '@khala/contracts/delivery/index';

export function failedReceipt(
  job: ReleasedJob,
  errorCode: ReceiptErrorCode,
  clock: Clock,
): DeliveryReceipt {
  return makeClaudeReceipt(job, clock, errorCode);
}

function makeClaudeReceipt(
  job: ReleasedJob,
  clock: Clock,
  errorCode: ReceiptErrorCode,
): DeliveryReceipt {
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
    observedAt: clock.now().toISOString(),
    source: 'connector',
    evidenceRef: null,
    errorCode,
  };
}
