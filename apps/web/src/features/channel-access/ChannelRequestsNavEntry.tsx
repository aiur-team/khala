import type { ChannelAccessInboxController } from './controller';
import { pendingIndicator } from './model';
import { useInboxView } from './ChannelRequestsInbox';

export interface ChannelRequestsNavEntryProps {
  controller: ChannelAccessInboxController;
  href: string;
  current?: boolean;
}

/**
 * The owner's persistent "Channel requests" navigation entry. It is always
 * rendered, and its indicator shows the exact pending count from 0 up to the
 * hard owner maximum of 50. The label stays readable when a host collapses its
 * menu behind a toggle.
 */
export function ChannelRequestsNavEntry({ controller, href, current = false }: ChannelRequestsNavEntryProps) {
  const view = useInboxView(controller);
  const count = pendingIndicator(view.requests);
  const known = view.phase === 'ready';
  return (
    <a href={href} className="channel-requests-nav" aria-current={current ? 'page' : undefined}>
      <span className="channel-requests-nav__label">Channel requests</span>
      <span className="channel-requests-nav__count" aria-hidden="true">{known ? count : '–'}</span>
      <span className="channel-requests-nav__sr">{known ? `, ${count} pending` : ', pending count loading'}</span>
    </a>
  );
}
