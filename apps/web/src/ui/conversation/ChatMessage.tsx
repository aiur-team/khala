import type { CSSProperties, ReactNode } from 'react';
import './conversation.css';

export function ChatMessage({ id, author, time, mine = false, grouped = false, live = false, kindLabel, status, className = '', children }: Readonly<{
  id: string; author: string; time?: string; mine?: boolean; grouped?: boolean;
  live?: boolean;
  kindLabel?: string; status?: string; className?: string; children: ReactNode;
}>) {
  return <li data-event-id={id} aria-live={live ? 'polite' : undefined} className={`conversation-message${mine ? ' conversation-message--mine' : ''}${grouped ? ' conversation-message--grouped' : ''} ${className}`.trim()}>
    <span className="conversation-message__avatar" style={{ '--avatar-hue': `${[...author].reduce((value, char) => value + char.charCodeAt(0), 0) % 360}` } as CSSProperties} aria-hidden="true">{author.trim().slice(0, 1).toLocaleUpperCase()}</span>
    <div className="conversation-message__bubble">
      <header className="conversation-message__meta"><strong dir="auto">{author}</strong>
        {kindLabel && kindLabel !== author ? <span className="conversation-message__kind">{kindLabel}</span> : null}
        {time ? <time dateTime={time}>{new Date(time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' })}</time> : null}
        {status ? <span>{status}</span> : null}</header>
      <div className="conversation-message__content">{children}</div>
    </div>
  </li>;
}
