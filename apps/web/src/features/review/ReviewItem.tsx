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

export interface ReviewItemProps {
  item: ReadableTimelineItem;
  selected: boolean;
  disabled: boolean;
  onToggle: (checked: boolean) => void;
  renderContent: (content: MessageContent) => ReactNode;
}

export function ReviewItem({ item, selected, disabled, onToggle, renderContent }: ReviewItemProps) {
  const inputId = `review-item-${item.ref.eventId}`;
  return (
    <li className="review-item" data-event-id={item.ref.eventId}>
      <header className="review-item__header">
        <input
          id={inputId}
          type="checkbox"
          className="review-item__checkbox"
          checked={selected}
          disabled={disabled}
          onChange={(event: ChangeEvent<HTMLInputElement>) => onToggle(event.currentTarget.checked)}
        />
        <label htmlFor={inputId} className="review-item__author" dir="auto">
          {item.participant.displayName}
        </label>
        <span className="review-item__kind">{item.participant.kind === 'agent' ? 'Agent' : 'Human'}</span>
        <time className="review-item__timestamp" dateTime={item.receivedAt}>
          {item.receivedAt}
        </time>
      </header>
      <div className="review-item__body">{renderContent(item.content)}</div>
    </li>
  );
}
