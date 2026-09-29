import type { ChannelAccessInboxController } from './controller';
import { pendingIndicator } from './model';
import { useInboxView } from './ChannelRequestsInbox';

export interface ChannelRequestsNavEntryProps {
  controller: ChannelAccessInboxController;
  href: string;
  current?: boolean;
  onNavigate?: () => void;
}

/**
 * Show the request review action only while the owner has known pending work.
 */
export function ChannelRequestsNavEntry({ controller, href, current = false, onNavigate }: ChannelRequestsNavEntryProps) {
  const view = useInboxView(controller);
  const count = pendingIndicator(view.requests);
  if (view.phase !== 'ready' || count === 0) return null;
  return (
    <a href={href} className="channel-requests-nav" aria-label={`Channel requests, ${count} pending`} title="Channel requests"
      onClick={onNavigate ? event => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        onNavigate();
      } : undefined}
      aria-current={current ? 'page' : undefined}>
      <span aria-hidden="true">{count}</span>
    </a>
  );
}
