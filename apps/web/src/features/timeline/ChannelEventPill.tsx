import { formatChannelEventLine, statusFor, type ChannelEventContent } from '@khala/contracts/m1/channel-event';
import { clockLabel, type TimeOptions } from '../../ui/khala/format-time';
import './channel-event-pill.css';

export function ChannelEventPill({ id, content, senderName, receivedAt, timeOptions }: Readonly<{
  id: string; content: ChannelEventContent; senderName: string; receivedAt: string; timeOptions?: TimeOptions;
}>) {
  const status = statusFor(content);
  const line = formatChannelEventLine(content);
  const time = content.occurred_at ?? receivedAt;
  const children = <>
    <i className={`channel-event-pill__dot channel-event-pill__dot--${status}`} aria-hidden="true" />
    <span className="channel-event-pill__body">
      <span className="channel-event-pill__text" dir="auto">{line}</span>
      <span aria-hidden="true"> · </span><time dateTime={time}>{clockLabel(new Date(time), timeOptions)}</time>
    </span>
  </>;
  return <li data-event-id={id} className="channel-event-pill">
    {content.url ? <a className="channel-event-pill__link" href={content.url} target="_blank"
      rel="noopener noreferrer" title={`From ${senderName}`}>{children}</a>
      : <div className="channel-event-pill__link" title={`From ${senderName}`}>{children}</div>}
  </li>;
}
