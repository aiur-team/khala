// Owner-only reads behind the review control handler. Every function here runs
// after the protected transport authenticated the human; none of them is ever
// reachable from a model tool, notification or resource listing.
//
// A preview answers "which of these exact references are pending for my agent
// right now" with references only. The human already reads the bodies through
// their own room membership, so pending plaintext never leaves the connector on
// this path and never enters an error, log line or receipt.

import {
  type BindingId, type DeliveryLimits, type DeliveryReceiptTransport, type EventRef, type OwnerAuthority,
  type ReleaseId, sameEventRef,
} from '@khala/contracts/delivery/index';
import { decodeEventSelection } from '@khala/contracts/delivery/events';
import { MESSAGE_ENCODING_V1 } from '@khala/contracts/messaging/events';
import type { LedgerTx, PendingRecord as StoredPendingRecord } from '@khala/connector/storage/ledger';
import type { PendingRecord as ReleasePendingRecord } from '@khala/policy/release/types';

export const REVIEW_PREVIEW_V1 = 1;

/** Owner-scoped read of the review queue for one binding; references only. */
export type ReviewPreview = Readonly<{
  v: typeof REVIEW_PREVIEW_V1;
  bindingId: BindingId;
  bindingGeneration: number;
  policyVersion: number;
  /** The requested candidates that are pending for the current generation, byte-for-byte equal. */
  pending: readonly EventRef[];
  /** Correlated receipts for the requested releases, in ledger order. */
  receipts: readonly DeliveryReceiptTransport[];
}>;

export type PreviewRequest = Readonly<{
  bindingId: BindingId;
  candidates: readonly EventRef[];
  releaseIds: readonly ReleaseId[];
}>;

export type PreviewOutcome =
  | Readonly<{ ok: true; preview: ReviewPreview }>
  | Readonly<{ ok: false; code: 'forbidden' | 'revoked' | 'unavailable' }>;

const MAX_RELEASE_QUERY = 64;

/**
 * The connector-effective policy version and the binding generation it was
 * applied to, read from the dispatch ledger before the review transaction.
 */
export type EffectivePolicy = Readonly<{ generation: number; version: number }>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Decodes an untrusted preview request. Unknown fields, including any claimed
 * owner or authority, refuse the whole request instead of being ignored.
 */
export function decodePreviewRequest(input: unknown, limits: DeliveryLimits): PreviewRequest | null {
  if (!isObject(input)) return null;
  const keys = Object.keys(input).sort();
  if (keys.join(',') !== 'bindingId,candidates,releaseIds') return null;
  if (typeof input.bindingId !== 'string' || input.bindingId.length === 0 || input.bindingId.length > 512) return null;
  if (!Array.isArray(input.candidates) || !Array.isArray(input.releaseIds)) return null;
  if (input.releaseIds.length > MAX_RELEASE_QUERY) return null;
  if (!input.releaseIds.every(id => typeof id === 'string' && id.length > 0 && id.length <= 512)) return null;
  let candidates: readonly EventRef[] = [];
  if (input.candidates.length > 0) {
    const decoded = decodeEventSelection(input.candidates, limits);
    if (!decoded.ok) return null;
    candidates = decoded.value;
  }
  return {
    bindingId: input.bindingId as BindingId,
    candidates,
    releaseIds: [...new Set(input.releaseIds as ReleaseId[])],
  };
}

/**
 * Converts the ledger's stored content bytes into the release policy's content
 * shape. Anything that is not exactly version 1 text becomes `unavailable`, so
 * the policy refuses it instead of guessing; the policy re-derives the digest
 * from this value, so a damaged row can only ever fail closed.
 */
export function toReleasePending(record: StoredPendingRecord): ReleasePendingRecord {
  const unavailable = { ref: record.event, content: { v: 1, kind: 'unavailable', reason: 'undecodable' } } as const;
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(record.content));
  } catch {
    return unavailable;
  }
  if (!Array.isArray(parsed) || parsed.length !== 3 || parsed[0] !== MESSAGE_ENCODING_V1 || parsed[1] !== 'text'
    || typeof parsed[2] !== 'string') {
    return unavailable;
  }
  return { ref: record.event, content: { v: 1, kind: 'text', body: parsed[2] } };
}

/**
 * Reads one owner-scoped preview in a single ledger transaction. The owner check
 * runs before any pending row is looked up, so another owner learns nothing about
 * which references exist.
 */
export function readPreview(
  tx: LedgerTx,
  authority: OwnerAuthority,
  request: PreviewRequest,
  effective: EffectivePolicy | null,
): PreviewOutcome {
  const binding = tx.readBinding(request.bindingId);
  if (binding === null || binding.ownerId !== authority.ownerId) return { ok: false, code: 'forbidden' };
  const snapshot = tx.readApprovalSnapshot({ bindingId: request.bindingId, selection: request.candidates });
  if (snapshot === null) return { ok: false, code: 'forbidden' };
  if (snapshot.kind === 'revoked') return { ok: false, code: 'revoked' };
  // No applied policy, or one applied to another generation, is never coerced to a version.
  if (effective === null || effective.generation !== snapshot.binding.generation) {
    return { ok: false, code: 'unavailable' };
  }
  const pending = request.candidates.filter(candidate =>
    snapshot.pending.some(record => sameEventRef(record.event, candidate)));
  const receipts: DeliveryReceiptTransport[] = [];
  for (const releaseId of request.releaseIds) {
    const release = tx.readRelease(releaseId);
    // Another owner's release ID reads exactly like an unknown one.
    if (release === null || release.ownerId !== authority.ownerId) continue;
    for (const stored of tx.readReceipts(releaseId)) {
      if (stored.correlation === 'correlated') receipts.push(stored.receipt);
    }
  }
  return {
    ok: true,
    preview: {
      v: REVIEW_PREVIEW_V1,
      bindingId: snapshot.binding.bindingId,
      bindingGeneration: snapshot.binding.generation,
      policyVersion: effective.version,
      pending,
      receipts,
    },
  };
}
