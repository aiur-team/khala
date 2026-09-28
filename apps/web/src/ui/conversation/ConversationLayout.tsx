import type { ReactNode } from 'react';
import './conversation.css';

export type ConversationSummary = Readonly<{
  id: string;
  title: string;
  preview: string | null;
  timestamp: string | null;
  unreadCount: number | null;
}>;

export function ConversationList({ conversations, selectedId, query, onQueryChange, onSelect, status }: Readonly<{
  conversations: readonly ConversationSummary[];
  selectedId?: string | null;
  query: string;
  onQueryChange(value: string): void;
  onSelect(id: string): void;
  status?: 'loading' | 'ready' | 'error';
}>) {
  const visible = conversations.filter(item => `${item.title} ${item.preview ?? ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <aside className="conversation-list" aria-label="Conversations">
    <header className="conversation-list__head"><strong>Conversations</strong><span>{conversations.length}</span></header>
    <label className="conversation-list__search"><span className="sr-only">Search conversations</span>
      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
      <input type="search" value={query} onChange={event => onQueryChange(event.target.value)} placeholder="Search conversations" />
    </label>
    <div className="conversation-list__items">
      {status === 'loading' ? <p role="status">Loading conversations…</p> : null}
      {status === 'error' ? <p role="alert">Conversations are unavailable. Try reloading.</p> : null}
      {status === 'ready' && visible.length === 0 ? <p role="status">{query ? 'No matching conversations.' : 'No encrypted conversations yet.'}</p> : null}
      {visible.map(item => <button key={item.id} type="button" className={`conversation-list__item${selectedId === item.id ? ' is-active' : ''}`}
        aria-current={selectedId === item.id ? 'page' : undefined} onClick={() => onSelect(item.id)}>
        <span className="conversation-list__avatar" aria-hidden="true">{item.title.trim().slice(0, 1).toLocaleUpperCase()}</span>
        <span className="conversation-list__copy"><span className="conversation-list__top"><strong dir="auto">{item.title}</strong>
          {item.timestamp ? <time dateTime={item.timestamp}>{new Date(item.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}</time> : null}</span>
          <span className="conversation-list__preview" dir="auto">{item.preview ?? 'No messages yet'}</span></span>
        {item.unreadCount ? <span className="conversation-list__unread" aria-label={`${item.unreadCount} unread notifications`}>{item.unreadCount}</span> : null}
      </button>)}
    </div>
  </aside>;
}

export function ChatThread({ title, onBack, children }: Readonly<{ title: string; onBack(): void; children: ReactNode }>) {
  return <section className="conversation-thread" aria-label="Conversation thread">
    <header className="conversation-thread__head"><button type="button" className="conversation-thread__back" onClick={onBack} aria-label="All conversations">‹</button><strong dir="auto">{title}</strong></header>
    <div className="conversation-thread__body">{children}</div>
  </section>;
}

export function ChatMessage({ id, author, time, mine = false, children }: Readonly<{
  id: string; author: string; time: string; mine?: boolean; children: ReactNode;
}>) {
  return <li data-event-id={id} className={`timeline__row${mine ? ' timeline__row--mine' : ''}`}>
    <header className="timeline__row-header"><strong className="timeline__author" dir="auto">{author}</strong><time dateTime={time}>{new Date(time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' })}</time></header>
    <div className="timeline__body">{children}</div>
  </li>;
}

export function ChatComposer({ value, onChange, onSend, disabled = false, sendDisabled = false, sendDescriptionId }: Readonly<{
  value: string; onChange(value: string): void; onSend(): void; disabled?: boolean; sendDisabled?: boolean; sendDescriptionId?: string;
}>) {
  return <form className="conversation-composer" onSubmit={event => { event.preventDefault(); onSend(); }}>
    <label className="sr-only" htmlFor="conversation-draft">Message</label>
    <textarea id="conversation-draft" value={value} onChange={event => onChange(event.target.value)} disabled={disabled} rows={1} placeholder="Message the Khala" />
    <button type="submit" disabled={disabled || sendDisabled || !value.trim()} aria-describedby={sendDescriptionId} aria-label="Send message">↑</button>
  </form>;
}

export function ParticipantDetail({ name, children, onClose }: Readonly<{ name: string; children?: ReactNode; onClose(): void }>) {
  return <aside className="conversation-detail" aria-label="Conversation details"><button type="button" onClick={onClose} aria-label="Close details">×</button><h2>{name}</h2>{children}</aside>;
}

export function ConversationLayout({ list, thread, detail, inThread = false }: Readonly<{
  list: ReactNode; thread?: ReactNode; detail?: ReactNode; inThread?: boolean;
}>) {
  return <div className={`conversation-layout${inThread ? ' conversation-layout--thread' : ''}${detail ? ' conversation-layout--detail' : ''}`}>
    {list}{thread ?? <section className="conversation-thread conversation-thread--empty" aria-label="Conversation thread"><p>Select a conversation to read its messages.</p></section>}{detail}
  </div>;
}
