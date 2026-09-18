// Maps a `DeliveryReceipt.kind` (KHA-106) to a human-facing label. Delivery
// observations are independent facts, not a sortable progress enum — this
// module never invents an ordinal progress bar over them, and it never labels
// `transport_written` as "read" or "consumed": only `context_consumed` is
// correlated evidence of the model actually seeing the release (U3).

import type { DeliveryReceipt, ReceiptErrorCode } from '@khala/contracts/delivery/index';

const RECEIPT_LABELS: Readonly<Record<DeliveryReceipt['kind'], string>> = {
  queued: 'Queued for delivery',
  dispatching: 'Dispatching',
  transport_written: 'Delivered to connector',
  harness_queued: 'Queued at the agent session',
  context_consumed: 'Read by the agent',
  completed: 'Delivery complete',
  outcome_unknown: 'Delivery status unknown',
  failed: 'Delivery failed',
  cancel_requested: 'Cancellation requested',
  cancelled: 'Cancelled',
};

const ERROR_LABELS: Readonly<Record<ReceiptErrorCode, string>> = {
  harness_unavailable: 'The agent session is unavailable',
  harness_rejected: 'The agent session rejected delivery',
  session_unavailable: 'The session is unavailable',
  busy_rejected: 'The agent session was busy',
  stale_binding: 'The agent binding changed',
  payload_digest_mismatch: 'The delivered content did not match',
  limit_exceeded: 'A delivery limit was exceeded',
  disconnected: 'The connection was lost',
  timeout: 'Delivery timed out',
};

/** The bare kind label. Never combines multiple receipts into one ordinal claim. */
export function receiptKindLabel(kind: DeliveryReceipt['kind']): string {
  return RECEIPT_LABELS[kind];
}

/** Adds the closed-vocabulary error reason when the receipt carries one. */
export function receiptLabel(receipt: DeliveryReceipt): string {
  const base = receiptKindLabel(receipt.kind);
  return receipt.errorCode ? `${base}: ${ERROR_LABELS[receipt.errorCode]}` : base;
}

/**
 * True only when at least one receipt for `releaseId` is `context_consumed` or
 * `completed` — the correlated evidence this feature requires before ever
 * implying the model actually consumed the release. `transport_written` alone
 * is never sufficient (U3).
 */
export function isConsumedByAgent(releaseId: DeliveryReceipt['releaseId'], receipts: readonly DeliveryReceipt[]): boolean {
  return receipts.some(receipt => receipt.releaseId === releaseId && (receipt.kind === 'context_consumed' || receipt.kind === 'completed'));
}

/**
 * The most recently observed receipt for one release, by `observedAt`. Ties
 * keep the last one encountered rather than guessing an order the source
 * never promised.
 */
export function latestReceiptFor(releaseId: DeliveryReceipt['releaseId'], receipts: readonly DeliveryReceipt[]): DeliveryReceipt | null {
  let latest: DeliveryReceipt | null = null;
  for (const receipt of receipts) {
    if (receipt.releaseId !== releaseId) continue;
    if (!latest || receipt.observedAt >= latest.observedAt) latest = receipt;
  }
  return latest;
}
