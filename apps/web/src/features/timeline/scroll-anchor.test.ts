import { describe, expect, it } from 'vitest';
import type { EventId } from '@khala/contracts/messaging/ids';
import { anchorToTopVisible, restoreScrollTop } from './scroll-anchor';

describe('anchorToTopVisible', () => {
  it('anchors to the given event and offset', () => {
    expect(anchorToTopVisible('E1' as EventId, 42)).toEqual({ eventId: 'E1', offsetPx: 42 });
  });

  it('falls back to atLatest when there is no top-visible event', () => {
    expect(anchorToTopVisible(null, 0)).toEqual({ atLatest: true });
  });
});

describe('restoreScrollTop', () => {
  it('preserves a selected reading event after 30 rows are prepended', () => {
    const anchor = anchorToTopVisible('E31' as EventId, 12);
    // Before prepend, E31 sat at offsetTop 12 (viewport-relative 12). After 30 rows of
    // 40px each are prepended above it, its new offsetTop is 30 * 40 + 12.
    const measure = (eventId: EventId) => (eventId === 'E31' ? 30 * 40 + 12 : null);
    expect(restoreScrollTop(anchor, measure)).toBe(30 * 40 + 12 - 12);
  });

  it('returns null for an atLatest anchor so the caller scrolls to the end itself', () => {
    expect(restoreScrollTop({ atLatest: true }, () => 999)).toBeNull();
  });

  it('returns null when the anchored event can no longer be measured, never a jump to zero', () => {
    expect(restoreScrollTop(anchorToTopVisible('E1' as EventId, 5), () => null)).toBeNull();
  });

  it('a new live row appended at the end does not move the anchor for a reader scrolled away', () => {
    const anchor = anchorToTopVisible('E5' as EventId, 100);
    const beforeOffset = 500;
    const afterOffset = 500; // appending after E5 does not change E5's own offsetTop
    expect(restoreScrollTop(anchor, () => beforeOffset)).toBe(restoreScrollTop(anchor, () => afterOffset));
  });
});
