// Evidence after the dispatch intent. Receipts are independent observations: each one is stored
// once, correlated to one release, and moves the record only toward a state it proves. Nothing here
// returns a record to `queued`, so an intent is submitted at most once.

import type { DeliveryReceipt, ReceiptKind } from '@khala/contracts/delivery/index';
import type { DispatchRecord, DispatchState, DispatchTx } from './types';

/** States a record reaches only after its dispatch intent was persisted. */
const AFTER_INTENT: readonly DispatchState[] = [
  'dispatching', 'accepted', 'outcome_unknown', 'completed', 'failed', 'cancelled', 'abandoned',
];
const SETTLED: readonly DispatchState[] = ['completed', 'failed', 'cancelled', 'abandoned'];

/** Acceptance is not evidenced by a transport write, a local queue or a cancel request. */
const PROVES: Partial<Record<ReceiptKind, DispatchState>> = {
  harness_queued: 'accepted',
  context_consumed: 'accepted',
  completed: 'completed',
  cancelled: 'cancelled',
  failed: 'failed',
};

export function correlates(record: DispatchRecord, receipt: DeliveryReceipt): boolean {
  return receipt.releaseId === record.releaseId
    && receipt.bindingId === record.job.binding.bindingId
    && receipt.generation === record.job.binding.generation;
}

function proven(receipt: DeliveryReceipt): DispatchState {
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
 * Stores a correlated receipt and applies the state it proves. Returns false for a receipt that
 * belongs to no dispatched attempt; it is not stored.
 */
export function applyReceipt(tx: DispatchTx, receipt: DeliveryReceipt): boolean {
  const record = tx.record(receipt.releaseId);
  if (record === null || !AFTER_INTENT.includes(record.state) || !correlates(record, receipt)) return false;
  if (record.receipts.some(seen => seen.receiptId === receipt.receiptId)) return true;
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

/** Ends an unknown outcome on owner authority. The reservation is kept. */
export function abandonUnknown(tx: DispatchTx, releaseId: DispatchRecord['releaseId']): boolean {
  const record = tx.record(releaseId);
  if (record?.state !== 'outcome_unknown') return false;
  tx.put({ ...record, state: 'abandoned' });
  return true;
}
