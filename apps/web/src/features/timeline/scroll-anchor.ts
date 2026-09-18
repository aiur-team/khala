// Pure scroll-anchor math. The screen captures/measures real DOM offsets;
// this module only computes the scrollTop that keeps one anchored event at
// its prior viewport offset after items are prepended (pagination) or
// appended (live arrivals) — never a global sequence number (KTD1).

import type { EventId } from '@khala/contracts/messaging/ids';
import type { ReaderAnchor } from './model';

export function anchorToTopVisible(eventId: EventId | null, offsetPx: number): ReaderAnchor {
  return eventId ? { eventId, offsetPx } : { atLatest: true };
}

/**
 * Given the anchor captured before a mutation and a way to measure the same
 * event's current offset, returns the scrollTop that restores that offset.
 * Returns `null` when the anchor is `atLatest` (the caller scrolls to the end
 * itself) or the anchored event can no longer be measured (removed/never
 * rendered) — never a discontinuous jump to zero.
 */
export function restoreScrollTop(anchor: ReaderAnchor, measureOffsetTop: (eventId: EventId) => number | null): number | null {
  if ('atLatest' in anchor) return null;
  const offsetTop = measureOffsetTop(anchor.eventId);
  return offsetTop === null ? null : offsetTop - anchor.offsetPx;
}
