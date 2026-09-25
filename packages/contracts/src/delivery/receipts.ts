// Delivery observations are independent facts, not a sortable progress enum.

import {
  type Decoded, type Reader, decodeWith, fail, identifier, literal, nullable, object, safeInteger, utcTimestamp,
} from './decode';
import { type BindingId, type ReceiptId, type ReleaseId, readId } from './ids';

export const RECEIPT_KINDS_V1 = [
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

/** Compatibility vocabulary for existing UI and harness consumers. */
export const RECEIPT_KINDS = RECEIPT_KINDS_V1;

export const RECEIPT_KINDS_V2 = [...RECEIPT_KINDS_V1, 'agent_acknowledged'] as const;

export type ReceiptKindV1 = (typeof RECEIPT_KINDS_V1)[number];
export type ReceiptKindV2 = (typeof RECEIPT_KINDS_V2)[number];
/** Compatibility kind for existing UI and harness consumers. */
export type ReceiptKind = ReceiptKindV1;

export const RECEIPT_SOURCES_V1 = ['connector', 'harness'] as const;
export const RECEIPT_SOURCES_V2 = [...RECEIPT_SOURCES_V1, 'agent'] as const;

export type ReceiptSourceV1 = (typeof RECEIPT_SOURCES_V1)[number];
export type ReceiptSourceV2 = (typeof RECEIPT_SOURCES_V2)[number];

/**
 * Closed, content-free failure vocabulary. Free text is never accepted: adding a
 * code changes the receipt shape and bumps its `v`. Only `failed` and
 * `outcome_unknown` observations carry a code, and `failed` always does.
 */
export const RECEIPT_ERROR_CODES = [
  'harness_unavailable',
  'harness_rejected',
  'session_unavailable',
  'busy_rejected',
  'stale_binding',
  'payload_digest_mismatch',
  'limit_exceeded',
  'disconnected',
  'timeout',
] as const;

export type ReceiptErrorCode = (typeof RECEIPT_ERROR_CODES)[number];

const KINDS_WITH_ERROR: readonly ReceiptKindV1[] = ['failed', 'outcome_unknown'];

type ReceiptIdentity = Readonly<{
  receiptId: ReceiptId;
  releaseId: ReleaseId;
  bindingId: BindingId;
  generation: number;
  observedAt: string;
}>;

export type DeliveryReceiptV1 = ReceiptIdentity & Readonly<{
  v: 1;
  kind: ReceiptKindV1;
  source: ReceiptSourceV1;
  evidenceRef: string | null;
  errorCode: ReceiptErrorCode | null;
}>;

type DeliveryReceiptV2LegacyObservation = Omit<DeliveryReceiptV1, 'v'> & Readonly<{ v: 2 }>;

type DeliveryReceiptV2AgentAcknowledgement = ReceiptIdentity & Readonly<{
  v: 2;
  kind: 'agent_acknowledged';
  source: 'agent';
  evidenceRef: string;
  errorCode: null;
}>;

/** V2 makes the acknowledgement kind and agent source an inseparable pair. */
export type DeliveryReceiptV2 =
  | DeliveryReceiptV2LegacyObservation
  | DeliveryReceiptV2AgentAcknowledgement;

/** Opt-in receipt union for durable storage and transport consumers. */
export type DeliveryReceiptTransport = DeliveryReceiptV1 | DeliveryReceiptV2;

/** Compatibility receipt for existing UI and harness consumers. */
export type DeliveryReceipt = DeliveryReceiptV1;

const RECEIPT_FIELDS = [
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
] as const;

function readDeliveryReceipt(r: Reader, expectedVersion: 1 | 2): DeliveryReceiptTransport {
  const receiptVersion = r.field('v');
  if (receiptVersion !== expectedVersion) fail(r.at('v'), 'invalid_version');

  const kinds = expectedVersion === 1 ? RECEIPT_KINDS_V1 : RECEIPT_KINDS_V2;
  const sources = expectedVersion === 1 ? RECEIPT_SOURCES_V1 : RECEIPT_SOURCES_V2;
  const kind = literal(r.field('kind'), r.at('kind'), kinds);
  const source = literal(r.field('source'), r.at('source'), sources);
  const evidenceRef = nullable(r.field('evidenceRef'), value => identifier(value, r.at('evidenceRef')));
  const errorCode = nullable(
    r.field('errorCode'),
    value => literal(value, r.at('errorCode'), RECEIPT_ERROR_CODES),
  );

  if (expectedVersion === 2) {
    if (kind === 'agent_acknowledged' && source !== 'agent') fail(r.at('source'), 'invalid_field');
    if (source === 'agent' && kind !== 'agent_acknowledged') fail(r.at('kind'), 'invalid_field');
    if (kind === 'agent_acknowledged' && evidenceRef === null) fail(r.at('evidenceRef'), 'invalid_field');
  }
  if (errorCode !== null && !KINDS_WITH_ERROR.includes(kind as ReceiptKindV1)) {
    fail(r.at('errorCode'), 'invalid_field');
  }
  if (kind === 'failed' && errorCode === null) fail(r.at('errorCode'), 'invalid_field');

  return {
    v: receiptVersion,
    receiptId: readId<'ReceiptId'>(r.field('receiptId'), r.at('receiptId')),
    releaseId: readId<'ReleaseId'>(r.field('releaseId'), r.at('releaseId')),
    bindingId: readId<'BindingId'>(r.field('bindingId'), r.at('bindingId')),
    generation: safeInteger(r.field('generation'), r.at('generation')),
    kind,
    observedAt: utcTimestamp(r.field('observedAt'), r.at('observedAt')),
    source,
    evidenceRef,
    errorCode,
  } as DeliveryReceiptTransport;
}

export function decodeDeliveryReceiptV1(input: unknown): Decoded<DeliveryReceiptV1> {
  return decodeWith(() => readDeliveryReceipt(object(input, '', RECEIPT_FIELDS), 1) as DeliveryReceiptV1);
}

export function decodeDeliveryReceiptV2(input: unknown): Decoded<DeliveryReceiptV2> {
  return decodeWith(() => readDeliveryReceipt(object(input, '', RECEIPT_FIELDS), 2) as DeliveryReceiptV2);
}

export function decodeDeliveryReceiptTransport(input: unknown): Decoded<DeliveryReceiptTransport> {
  return decodeWith(() => {
    const r = object(input, '', RECEIPT_FIELDS);
    const receiptVersion = r.field('v');
    if (receiptVersion === 1 || receiptVersion === 2) return readDeliveryReceipt(r, receiptVersion);
    fail(r.at('v'), 'invalid_version');
  });
}

/** Compatibility decoder for existing UI and harness consumers. */
export function decodeDeliveryReceipt(input: unknown): Decoded<DeliveryReceipt> {
  return decodeDeliveryReceiptV1(input);
}
