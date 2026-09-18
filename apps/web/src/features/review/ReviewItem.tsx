// One pending review row: full inert preview plus a human-owned checkbox.
// `renderContent` is an injected render slot (mirroring timeline's
// `renderReviewAction` symmetry) rather than a direct import of timeline's
// renderer — this feature owns no cross-feature import, and composition
// (KHA-134) wires the real inert renderer in. Message body content is
// rendered exclusively through that injected function; the checkbox and
// every other review-owned control is structural DOM outside of it, so
// content bytes can never fabricate or invoke a control (KTD4, U2).

import type { ChangeEvent, ReactNode } from 'react';
import type { MessageContent, TimelineItem } from '@khala/contracts/messaging/index';

export type ReadableTimelineItem = Extract<TimelineItem, { content: MessageContent }>;

/**
 * Same control/bidi/invisible character classes `ParticipantView.displayName`
 * is decoder-guaranteed to never carry (see `attribution.ts`) — but message
 * body content carries no such guarantee, and the accessible name is a
 * review-owned surface (KTD4), so the body-derived preview below is stripped
 * of them before it reaches `aria-label`.
 */
const UNSAFE_ACCESSIBLE_NAME_CHARS = /[\u0000-\u001f\u007f-\u009f\u061c\u200b\u200e\u200f\u202a-\u202e\u2060\u2066-\u2069\ufeff]/g;

function sanitizeForAccessibleName(value: string): string {
  return value.replace(UNSAFE_ACCESSIBLE_NAME_CHARS, '');
}

/** Takes the first `count` Unicode code points, never splitting a surrogate pair the way `string.slice` (UTF-16 code units) can. */
function takeCodePoints(value: string, count: number): string {
  return Array.from(value).slice(0, count).join('');
}

export interface ReviewItemProps {
  item: ReadableTimelineItem;
  /** Author display name, resolved for same-name collisions across owners (see `attribution.ts`). */
  resolvedDisplayName: string;
  /** "Your agent" / "Another person's agent" / "You" / "Human" — relative to the viewer (R1). */
  ownerLabel: string;
  selected: boolean;
  disabled: boolean;
  onToggle: (checked: boolean) => void;
  renderContent: (content: MessageContent) => ReactNode;
  /**
   * Local-only "collapse from view" action, rendered as a review-owned
   * control alongside the checkbox — never touches selection or submission,
   * so it can never authorize delivery (KTD4).
   */
  onHide: () => void;
  /**
   * True while a submission is in flight/unresolved. Hiding a selected row
   * then would leave its ref selected-but-invisible with no way back short of
   * a full Reselect, so Hide is disabled for the same window the checkbox
   * already is.
   */
  hideDisabled: boolean;
}

export function ReviewItem({ item, resolvedDisplayName, ownerLabel, selected, disabled, onToggle, renderContent, onHide, hideDisabled }: ReviewItemProps) {
  const inputId = `review-item-${item.ref.eventId}`;
  const bodyPreview = sanitizeForAccessibleName(takeCodePoints(item.content.body, 60));
  return (
    <li className="review-item" data-event-id={item.ref.eventId}>
      <header className="review-item__header">
        <input
          id={inputId}
          type="checkbox"
          className="review-item__checkbox"
          checked={selected}
          disabled={disabled}
          aria-label={`Select message from ${resolvedDisplayName} (${ownerLabel}), received ${item.receivedAt}: ${bodyPreview}`}
          onChange={(event: ChangeEvent<HTMLInputElement>) => onToggle(event.currentTarget.checked)}
        />
        <label htmlFor={inputId} className="review-item__author" dir="auto">
          {resolvedDisplayName}
        </label>
        <span className="review-item__kind">{ownerLabel}</span>
        <time className="review-item__timestamp" dateTime={item.receivedAt}>
          {item.receivedAt}
        </time>
        <button type="button" className="review__hide" aria-label={`Hide message ${item.ref.eventId} from this list`} onClick={onHide} disabled={hideDisabled}>
          Hide
        </button>
      </header>
      <div className="review-item__body">{renderContent(item.content)}</div>
    </li>
  );
}
