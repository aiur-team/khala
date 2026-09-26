// Pure projection of the human-authorized review snapshot. The connector answers
// with exact references only; the bodies shown here are the human's own decrypted
// room items. An item joins the review queue only when its reference, including
// author, device and content digest, equals a reference the connector holds as
// pending, so an edited or substituted version can never be released by mistake.

import {
  type BindingId, type DeliveryLimits, type DeliveryReceipt, type EventRef,
  decodeDeliveryReceiptTransport, sameEventRef,
} from '@khala/contracts/delivery/index';
import { decodeEventSelection } from '@khala/contracts/delivery/events';
import type { OwnerId, TimelineItem } from '@khala/contracts/messaging/index';
import type { ReviewView } from '../../features/review/model';

/** The connector's owner-scoped preview, decoded at the browser boundary. */
export type ReviewPreview = Readonly<{
  bindingId: BindingId;
  bindingGeneration: number;
  policyVersion: number;
  pending: readonly EventRef[];
  receipts: readonly DeliveryReceipt[];
}>;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const PREVIEW_KEYS = 'bindingGeneration,bindingId,pending,policyVersion,receipts,v';

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Receipts reach the UI in the v1 vocabulary. A v2 legacy observation carries the
 * same fact; an agent acknowledgement has no v1 label and is left out rather than
 * relabelled as model consumption.
 */
function toUiReceipt(input: unknown): DeliveryReceipt | null | 'invalid' {
  const decoded = decodeDeliveryReceiptTransport(input);
  if (!decoded.ok) return 'invalid';
  const receipt = decoded.value;
  if (receipt.v === 1) return receipt;
  if (receipt.kind === 'agent_acknowledged') return null;
  return { ...receipt, v: 1 } as DeliveryReceipt;
}

/** Strictly decodes a preview body; anything malformed is unavailable, never partial. */
export function decodeReviewPreview(input: unknown, limits: DeliveryLimits, bindingId: BindingId): ReviewPreview | null {
  if (!isObject(input) || Object.keys(input).sort().join(',') !== PREVIEW_KEYS || input.v !== 1) return null;
  if (input.bindingId !== bindingId) return null;
  if (!nonNegativeInteger(input.bindingGeneration) || !nonNegativeInteger(input.policyVersion)) return null;
  if (!Array.isArray(input.pending) || !Array.isArray(input.receipts)) return null;
  let pending: readonly EventRef[] = [];
  if (input.pending.length > 0) {
    const decoded = decodeEventSelection(input.pending, limits);
    if (!decoded.ok) return null;
    pending = decoded.value;
  }
  const receipts: DeliveryReceipt[] = [];
  for (const value of input.receipts) {
    const receipt = toUiReceipt(value);
    if (receipt === 'invalid') return null;
    if (receipt !== null && receipt.bindingId === bindingId) receipts.push(receipt);
  }
  return {
    bindingId,
    bindingGeneration: input.bindingGeneration,
    policyVersion: input.policyVersion,
    pending,
    receipts,
  };
}

type ReadableItem = Extract<TimelineItem, { content: { kind: 'text' } }>;

function isReadable(item: TimelineItem): item is ReadableItem {
  return item.content.kind === 'text' && 'contentDigest' in item.ref;
}

/**
 * The newest readable room items the human can see, as exact references. Only
 * references cross to the connector; bodies stay in the browser.
 */
export function candidateRefs(items: readonly TimelineItem[], max: number): readonly EventRef[] {
  const readable = items.filter(isReadable).map(item => item.ref as EventRef);
  return readable.slice(Math.max(0, readable.length - max));
}

export function loadingView(bindingId: BindingId, viewerOwnerId: OwnerId): ReviewView {
  return {
    access: 'loading', bindingId, bindingGeneration: 0, policyVersion: 0, viewerOwnerId, pending: [], receipts: [],
  };
}

/** Joins the connector's exact pending references with the human's own readable items. */
export function readyView(
  preview: ReviewPreview,
  items: readonly TimelineItem[],
  viewerOwnerId: OwnerId,
): ReviewView {
  const pending = items.filter(item => isReadable(item)
    && preview.pending.some(ref => sameEventRef(ref, item.ref as EventRef)));
  return {
    access: 'ready',
    bindingId: preview.bindingId,
    bindingGeneration: preview.bindingGeneration,
    policyVersion: preview.policyVersion,
    viewerOwnerId,
    pending,
    receipts: preview.receipts,
  };
}

/** Access loss keeps the last binding context but never a protected preview. */
export function withoutAccess(view: ReviewView, access: 'revoked' | 'unavailable'): ReviewView {
  return { ...view, access, pending: access === 'revoked' ? [] : view.pending };
}
