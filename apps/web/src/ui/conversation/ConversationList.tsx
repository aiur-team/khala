import type { CSSProperties, ReactNode } from 'react';
import './conversation.css';

export type ConversationSummary = Readonly<{
  id: string;
  title: string;
  preview: string | null;
  timestamp: string | null;
  unreadCount: number | null;
}>;

export function ConversationList({ conversations, selectedId, query, onQueryChange, onSelect, status, emptyLabel = 'No conversations yet.', action, showSearch = true }: Readonly<{
  conversations: readonly ConversationSummary[];
  selectedId?: string | null;
  query: string;
  onQueryChange(value: string): void;
  onSelect(id: string): void;
  status?: 'loading' | 'ready' | 'error';
  emptyLabel?: string;
  action?: ReactNode;
  showSearch?: boolean;
}>) {
  const visible = conversations.filter(item => `${item.title} ${item.preview ?? ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const unread = conversations.reduce((count, item) => count + (item.unreadCount ?? 0), 0);
  return <aside className="conversation-list" aria-label="Conversations">
    <header className="conversation-list__head"><strong>Conversations</strong>{unread > 0 ? <span>{unread} unread</span> : null}{action ? <div className="conversation-list__head-actions">{action}</div> : null}</header>
    {showSearch ? <label className="conversation-list__search"><span className="sr-only">Search channels</span>
      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
      <input type="search" value={query} onChange={event => onQueryChange(event.target.value)} placeholder="Search" />
    </label> : null}
    <div className="conversation-list__items">
      {status === 'loading' ? <p role="status">Loading conversations…</p> : null}
      {status === 'error' ? <p role="alert">Conversations are unavailable. Try reloading.</p> : null}
      {status === 'ready' && visible.length === 0 ? <p role="status">{query ? 'No matching conversations.' : emptyLabel}</p> : null}
      {visible.map(item => <button key={item.id} type="button" className={`conversation-list__item${selectedId === item.id ? ' is-active' : ''}`}
        aria-current={selectedId === item.id ? 'page' : undefined} onClick={() => onSelect(item.id)}>
        <span className="conversation-list__avatar" style={{ '--avatar-hue': `${[...item.id].reduce((value, char) => value + char.charCodeAt(0), 0) % 360}` } as CSSProperties} aria-hidden="true">{item.title.trim().slice(0, 1).toLocaleUpperCase()}</span>
        <span className="conversation-list__copy"><span className="conversation-list__top"><strong dir="auto">{item.title}</strong>
          {item.timestamp ? <time dateTime={item.timestamp}>{new Date(item.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}</time> : null}</span>
          <span className="conversation-list__preview" dir="auto">{item.preview ?? (item.timestamp ? 'Message unavailable on this device' : 'No messages yet')}</span></span>
        {item.unreadCount ? <span className="conversation-list__unread" aria-label={`${item.unreadCount} unread notifications`}>{item.unreadCount}</span> : null}
      </button>)}
    </div>
  </aside>;
}
