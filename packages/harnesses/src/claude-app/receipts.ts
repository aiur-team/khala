// Content-free connector-side refusals with stable identities: the same release,
// binding generation and outcome always yield the same receipt ID.

import { createHash } from 'node:crypto';
import type {
  Clock, DeliveryReceipt, ReceiptErrorCode, ReceiptId, ReleasedJob,
} from '@khala/contracts/delivery/index';

export function failedReceipt(job: ReleasedJob, errorCode: ReceiptErrorCode, clock: Clock): DeliveryReceipt {
  const { releaseId, binding } = job;
  const digest = createHash('sha256')
    .update(JSON.stringify(['claude-app', binding.bindingId, binding.generation, releaseId, 'failed', errorCode]))
    .digest('hex');
  return {
    v: 1,
    receiptId: `claude-app-receipt-${digest}` as ReceiptId,
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
