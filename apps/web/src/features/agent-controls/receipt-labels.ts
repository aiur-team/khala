import type { Decoded, DeliveryReceipt, ReceiptErrorCode, ReceiptKind } from '@khala/contracts/delivery/index';

/**
 * Receipt kinds are independent facts (see `packages/contracts/src/delivery/receipts.ts`),
 * never a sortable progress enum: `transport_written` and `harness_queued` must
 * never be read as implying `context_consumed`. Each case is listed explicitly so
 * adding a wire kind is a compile error here, not a silent fallthrough.
 */
const RECEIPT_LABELS: Record<ReceiptKind, string> = {
  queued: 'Queued for delivery',
  dispatching: 'Sending to the connector',
  transport_written: 'Delivered to the connector',
  harness_queued: 'Queued on the agent harness',
  context_consumed: 'Received by the model',
  completed: 'Delivery confirmed complete',
  outcome_unknown: 'Outcome unknown — needs reconciliation',
  failed: 'Delivery failed',
  cancel_requested: 'Cancellation requested (delivery only, not the model turn)',
  cancelled: 'Delivery cancelled',
};

const RECEIPT_ERROR_LABELS: Record<ReceiptErrorCode, string> = {
  harness_unavailable: 'the agent harness was unavailable',
  harness_rejected: 'the agent harness rejected the delivery',
  session_unavailable: 'the session was unavailable',
  busy_rejected: 'the agent was busy',
  stale_binding: 'the connection binding is stale',
  payload_digest_mismatch: 'the payload did not match',
  limit_exceeded: 'a delivery limit was exceeded',
  disconnected: 'the connector disconnected',
  timeout: 'the delivery timed out',
};

/**
 * A receipt observation is a fact about a point in time, not a claim about the
 * current state — `outcome_unknown` must stay visible after a later unrelated
 * `connected` status until a correlated reconciling receipt for the same
 * `releaseId`/`generation` arrives.
 */
export function receiptLabel(receipt: DeliveryReceipt): string {
  const base = RECEIPT_LABELS[receipt.kind];
  if (receipt.errorCode === null) return base;
  return `${base}: ${RECEIPT_ERROR_LABELS[receipt.errorCode]}`;
}

/**
 * A receipt that failed to decode (malformed shape, or a kind/error code this
 * build does not recognize) shows a generic unavailable detail. The raw payload
 * and decode error field are never surfaced, since they may carry connector
 * internals not meant for display.
 */
export function receiptDetailFromDecoded(decoded: Decoded<DeliveryReceipt>): string {
  if (decoded.ok) return receiptLabel(decoded.value);
  return 'Delivery status unavailable.';
}
