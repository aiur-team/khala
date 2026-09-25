// Evidence after the dispatch intent. Receipts are independent observations: each one is stored
// once, correlated to one release, and moves the record only toward a state it proves. Nothing here
// returns a record to `queued`, so an intent is submitted at most once.

import {
  type DeliveryReceipt, type DeliveryReceiptTransport, type OwnerAuthority, type ReceiptKindV2, decodeDeliveryReceipt,
} from '@khala/contracts/delivery/index';
import { type DispatchRecord, type DispatchState, type DispatchTx, MAX_RECEIPTS } from './types';

/** States a record reaches only after its dispatch intent was persisted. */
const AFTER_INTENT: readonly DispatchState[] = [
  'dispatching', 'accepted', 'outcome_unknown', 'completed', 'failed', 'cancelled', 'abandoned',
];
const SETTLED: readonly DispatchState[] = ['completed', 'failed', 'cancelled', 'abandoned'];

/** Acceptance is not evidenced by a transport write, a local queue or a cancel request. */
const PROVES: Partial<Record<ReceiptKindV2, DispatchState>> = {
  harness_queued: 'accepted',
  context_consumed: 'accepted',
  agent_acknowledged: 'accepted',
  completed: 'completed',
  cancelled: 'cancelled',
  failed: 'failed',
};

/** A receipt from the harness or an observer, decoded before it can touch a record; else null. */
export function decodeReceipt(input: unknown): DeliveryReceipt | null {
  const decoded = decodeDeliveryReceipt(input);
  return decoded.ok ? decoded.value : null;
}

const sameReceipt = (a: DeliveryReceiptTransport, b: DeliveryReceiptTransport): boolean =>
  (Object.keys(a) as (keyof DeliveryReceiptTransport)[]).every(key => a[key] === b[key]);

export function correlates(record: DispatchRecord, receipt: DeliveryReceiptTransport): boolean {
  return receipt.releaseId === record.releaseId
    && receipt.bindingId === record.job.binding.bindingId
    && receipt.generation === record.job.binding.generation;
}

function proven(receipt: DeliveryReceiptTransport): DispatchState {
  // A failure caused by losing the connection says nothing about whether the harness accepted.
  if (receipt.kind === 'failed' && (receipt.errorCode === 'disconnected' || receipt.errorCode === 'timeout')) {
    return 'outcome_unknown';
  }
  return PROVES[receipt.kind] ?? 'outcome_unknown';
}

function next(current: DispatchState, evidence: DispatchState): DispatchState {
  if (SETTLED.includes(current)) return current;
  if (evidence === 'outcome_unknown') return current === 'dispatching' ? 'outcome_unknown' : current;
  if (current === 'accepted' && evidence === 'accepted') return current;
  return evidence;
}

/**
 * Stores a decoded, correlated receipt and applies the state it proves. Returns false, storing
 * nothing, for a receipt that belongs to no dispatched attempt, reuses a stored receipt ID with other
 * content, or would exceed `MAX_RECEIPTS`.
 */
export function applyReceipt(tx: DispatchTx, receipt: DeliveryReceiptTransport): boolean {
  const record = tx.record(receipt.releaseId);
  if (record === null || !AFTER_INTENT.includes(record.state) || !correlates(record, receipt)) return false;
  const seen = record.receipts.find(stored => stored.receiptId === receipt.receiptId);
  if (seen !== undefined) return sameReceipt(seen, receipt);
  if (record.receipts.length >= MAX_RECEIPTS) return false;
  tx.put({ ...record, state: next(record.state, proven(receipt)), receipts: [...record.receipts, receipt] });
  return true;
}

/**
 * An intent with no evidence and no live submitter becomes `outcome_unknown`. Neither a timeout nor
 * an empty harness lookup proves the submission did not happen.
 */
export function markUnknown(tx: DispatchTx, releaseId: DispatchRecord['releaseId'], attemptId: string): void {
  const record = tx.record(releaseId);
  if (record?.state === 'dispatching' && record.attemptId === attemptId) tx.put({ ...record, state: 'outcome_unknown' });
}

/**
 * Ends an unknown outcome on the authority of the binding's owner and records the authorization.
 * The reservation is kept.
 */
export function abandonUnknown(
  tx: DispatchTx,
  authority: OwnerAuthority | null | undefined,
  releaseId: DispatchRecord['releaseId'],
): boolean {
  const record = tx.record(releaseId);
  if (record?.state !== 'outcome_unknown') return false;
  if (typeof authority?.authorizationId !== 'string' || authority.authorizationId === '') return false;
  if (authority.ownerId !== record.job.binding.ownerId) return false;
  tx.put({ ...record, state: 'abandoned', abandonedBy: authority.authorizationId });
  return true;
}
