// Delivery observations are independent facts, not a sortable progress enum.

import {
  type Decoded, decodeWith, identifier, literal, nullable, object, safeInteger, utcTimestamp, version,
} from './decode';
import { type BindingId, type ReceiptId, type ReleaseId, readId } from './ids';

export const RECEIPT_KINDS = [
  'queued',
  'dispatching',
  'transport_written',
  'harness_queued',
  'context_consumed',
  'completed',
  'outcome_unknown',
  'failed',
  'cancel_requested',
  'cancelled',
] as const;

export type ReceiptKind = (typeof RECEIPT_KINDS)[number];

const RECEIPT_SOURCES = ['connector', 'harness'] as const;

export type DeliveryReceipt = Readonly<{
  v: 1;
  receiptId: ReceiptId;
  releaseId: ReleaseId;
  bindingId: BindingId;
  generation: number;
  kind: ReceiptKind;
  observedAt: string;
  source: (typeof RECEIPT_SOURCES)[number];
  evidenceRef: string | null;
  errorCode: string | null;
}>;

export function decodeDeliveryReceipt(input: unknown): Decoded<DeliveryReceipt> {
  return decodeWith(() => {
    const r = object(input, '', [
      'v',
      'receiptId',
      'releaseId',
      'bindingId',
      'generation',
      'kind',
      'observedAt',
      'source',
      'evidenceRef',
      'errorCode',
    ]);
    return {
      v: version(r.field('v'), r.at('v')),
      receiptId: readId<'ReceiptId'>(r.field('receiptId'), r.at('receiptId')),
      releaseId: readId<'ReleaseId'>(r.field('releaseId'), r.at('releaseId')),
      bindingId: readId<'BindingId'>(r.field('bindingId'), r.at('bindingId')),
      generation: safeInteger(r.field('generation'), r.at('generation')),
      kind: literal(r.field('kind'), r.at('kind'), RECEIPT_KINDS),
      observedAt: utcTimestamp(r.field('observedAt'), r.at('observedAt')),
      source: literal(r.field('source'), r.at('source'), RECEIPT_SOURCES),
      evidenceRef: nullable(r.field('evidenceRef'), value => identifier(value, r.at('evidenceRef'))),
      errorCode: nullable(r.field('errorCode'), value => identifier(value, r.at('errorCode'))),
    };
  });
}
