// Review's view of delivery receipt labels. Observations are independent facts,
// not a sortable progress enum: review never picks one "latest" receipt, never
// labels context insertion as "read", and never lets `completed` stand in for a
// returned batch token. The shared vocabulary is the single source of copy.

import type { DeliveryReceiptTransport } from '@khala/contracts/delivery/index';
import { RECEIPT_EVIDENCE_LABELS, receiptEvidenceLabel } from '../receipt-evidence/vocabulary';

/** The bare kind label. Never combines multiple receipts into one ordinal claim. */
export function receiptKindLabel(kind: DeliveryReceiptTransport['kind']): string {
  return RECEIPT_EVIDENCE_LABELS[kind];
}

/** Adds the closed-vocabulary error reason when the receipt carries one. */
export function receiptLabel(receipt: DeliveryReceiptTransport): string {
  return receiptEvidenceLabel(receipt);
}
