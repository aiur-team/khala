import { formatChannelEventLine, statusFor, type ChannelEventContent } from '@khala/contracts/m1/channel-event';
import './channel-event-pill.css';

export function ChannelEventPill({ id, content, senderName, receivedAt }: Readonly<{
  id: string; content: ChannelEventContent; senderName: string; receivedAt: string;
}>) {
  const status = statusFor(content);
  const line = formatChannelEventLine(content);
  const time = content.occurred_at ?? receivedAt;
  const label = new Date(time).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
  const children = <>
    <i className={`channel-event-pill__dot channel-event-pill__dot--${status}`} aria-hidden="true" />
    <span className="channel-event-pill__body">
      <span className="channel-event-pill__text" dir="auto">{line}</span>
      <span aria-hidden="true"> · </span><time dateTime={time}>{label}</time>
    </span>
  </>;
  return <li data-event-id={id} className="channel-event-pill">
    {content.url ? <a className="channel-event-pill__link" href={content.url} target="_blank"
      rel="noopener noreferrer" title={`From ${senderName}`}>{children}</a>
      : <div className="channel-event-pill__link" title={`From ${senderName}`}>{children}</div>}
  </li>;
}
