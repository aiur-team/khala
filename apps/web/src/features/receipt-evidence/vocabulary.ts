// The one truthful vocabulary for delivery receipt evidence. Every kind names the
// observable boundary its producer crossed and nothing more: context insertion is
// not "read", a returned batch token is not agent action, and a completed turn is
// not acknowledgement. Facts are independent, so nothing here derives progress.

import type {
  AcknowledgementSupport, DeliveryReceiptTransport, ReceiptErrorCode, ReceiptKindV2,
} from '@khala/contracts/delivery/index';

/** Listed per kind so a new wire kind is a compile error here, never a silent fallthrough. */
export const RECEIPT_EVIDENCE_LABELS: Readonly<Record<ReceiptKindV2, string>> = {
  queued: 'Queued for delivery',
  dispatching: 'Delivery in progress',
  transport_written: 'Delivered to connector',
  harness_queued: 'Queued at agent session',
  context_consumed: 'Added to agent context',
  agent_acknowledged: 'Batch token returned',
  completed: 'Agent turn completed',
  outcome_unknown: 'Delivery outcome unknown',
  failed: 'Delivery failed',
  cancel_requested: 'Cancellation requested',
  cancelled: 'Delivery cancelled',
};

const ERROR_LABELS: Readonly<Record<ReceiptErrorCode, string>> = {
  harness_unavailable: 'the agent session was unavailable',
  harness_rejected: 'the agent session rejected delivery',
  session_unavailable: 'the session was unavailable',
  busy_rejected: 'the agent session was busy',
  stale_binding: 'the agent binding changed',
  payload_digest_mismatch: 'the delivered content did not match',
  limit_exceeded: 'a delivery limit was exceeded',
  disconnected: 'the connection was lost',
  timeout: 'delivery timed out',
};

/** The exact boundary a returned batch token proves, shown beside every such status. */
export const TOKEN_RETURN_HELP = 'A later Khala call returned the token for this batch. This does not prove the agent acted on '
  + 'the message, the message entered context, was understood, or was completed.';

/** Shown only after a ready evidence read confirms the absence. */
export const NO_TOKEN_RETURN = 'No token-return fact';

export const EVIDENCE_UNAVAILABLE = 'Delivery evidence unavailable';

export const ACKNOWLEDGEMENT_SUPPORT_LABELS: Readonly<Record<AcknowledgementSupport, string>> = {
  unknown: 'Batch-token return support not verified',
  unsupported: 'Batch-token return not supported',
  batch_token_next_call: 'Batch-token return supported',
};

export function receiptEvidenceLabel(receipt: Pick<DeliveryReceiptTransport, 'kind' | 'errorCode'>): string {
  const base = RECEIPT_EVIDENCE_LABELS[receipt.kind];
  return receipt.errorCode === null ? base : `${base}: ${ERROR_LABELS[receipt.errorCode]}`;
}

type Orderable = Pick<DeliveryReceiptTransport, 'kind' | 'observedAt' | 'receiptId'>;

/**
 * The one canonical, non-semantic order: ascending kind code, then timestamp and
 * receipt ID only as same-kind tie-breakers. It never ranks by perceived strength.
 */
export function compareReceiptEvidence(a: Orderable, b: Orderable): number {
  const left = [a.kind, a.observedAt, a.receiptId];
  const right = [b.kind, b.observedAt, b.receiptId];
  for (let index = 0; index < left.length; index += 1) {
    if (left[index]! < right[index]!) return -1;
    if (left[index]! > right[index]!) return 1;
  }
  return 0;
}

export function inCanonicalOrder<T extends Orderable>(receipts: readonly T[]): T[] {
  return [...receipts].sort(compareReceiptEvidence);
}
