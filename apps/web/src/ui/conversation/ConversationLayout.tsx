import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import './conversation.css';

export type ConversationSummary = Readonly<{
  id: string;
  title: string;
  preview: string | null;
  timestamp: string | null;
  unreadCount: number | null;
}>;

export function ConversationList({ conversations, selectedId, query, onQueryChange, onSelect, status, emptyLabel = 'No conversations yet.', action }: Readonly<{
  conversations: readonly ConversationSummary[];
  selectedId?: string | null;
  query: string;
  onQueryChange(value: string): void;
  onSelect(id: string): void;
  status?: 'loading' | 'ready' | 'error';
  emptyLabel?: string;
  action?: ReactNode;
}>) {
  const visible = conversations.filter(item => `${item.title} ${item.preview ?? ''}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <aside className="conversation-list" aria-label="Conversations">
    <header className="conversation-list__head"><strong>Channels</strong><span>{conversations.length}</span>{action}</header>
    <label className="conversation-list__search"><span className="sr-only">Search channels</span>
      <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
      <input type="search" value={query} onChange={event => onQueryChange(event.target.value)} placeholder="Search channels" />
    </label>
    <div className="conversation-list__items">
      {status === 'loading' ? <p role="status">Loading conversations…</p> : null}
      {status === 'error' ? <p role="alert">Conversations are unavailable. Try reloading.</p> : null}
      {status === 'ready' && visible.length === 0 ? <p role="status">{query ? 'No matching conversations.' : emptyLabel}</p> : null}
      {visible.map(item => <button key={item.id} type="button" className={`conversation-list__item${selectedId === item.id ? ' is-active' : ''}`}
        aria-current={selectedId === item.id ? 'page' : undefined} onClick={() => onSelect(item.id)}>
        <span className="conversation-list__avatar" aria-hidden="true">{item.title.trim().slice(0, 1).toLocaleUpperCase()}</span>
        <span className="conversation-list__copy"><span className="conversation-list__top"><strong dir="auto">{item.title}</strong>
          {item.timestamp ? <time dateTime={item.timestamp}>{new Date(item.timestamp).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}</time> : null}</span>
          <span className="conversation-list__preview" dir="auto">{item.preview ?? (item.timestamp ? 'Message unavailable on this device' : 'No messages yet')}</span></span>
        {item.unreadCount ? <span className="conversation-list__unread" aria-label={`${item.unreadCount} unread notifications`}>{item.unreadCount}</span> : null}
      </button>)}
    </div>
  </aside>;
}

export function ChatThread({ title, onBack, children }: Readonly<{ title: string; onBack?: () => void; children: ReactNode }>) {
  return <section className="conversation-thread" aria-label="Conversation thread">
    <header className="conversation-thread__head">{onBack ? <button type="button" className="conversation-thread__back" onClick={onBack} aria-label="All conversations">‹</button> : null}<h1 dir="auto">{title}</h1></header>
    <div className="conversation-thread__body">{children}</div>
  </section>;
}

export function ChatMessage({ id, author, time, mine = false, grouped = false, live = false, kindLabel, status, className = '', children }: Readonly<{
  id: string; author: string; time?: string; mine?: boolean; grouped?: boolean;
  live?: boolean;
  kindLabel?: string; status?: string; className?: string; children: ReactNode;
}>) {
  return <li data-event-id={id} aria-live={live ? 'polite' : undefined} className={`conversation-message${mine ? ' conversation-message--mine' : ''}${grouped ? ' conversation-message--grouped' : ''} ${className}`.trim()}>
    <span className="conversation-message__avatar" aria-hidden="true">{author.trim().slice(0, 1).toLocaleUpperCase()}</span>
    <div className="conversation-message__bubble">
      <header className="conversation-message__meta"><strong dir="auto">{author}</strong>
        {kindLabel ? <span>{kindLabel}</span> : null}
        {time ? <time dateTime={time}>{new Date(time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' })}</time> : null}
        {status ? <span>{status}</span> : null}</header>
      <div className="conversation-message__content">{children}</div>
    </div>
  </li>;
}

export function ChatComposer({ value, onChange, onSend, disabled = false, sendDisabled = false, sendDescriptionId, placeholder = '' }: Readonly<{
  value: string; onChange(value: string): void; onSend(): void; disabled?: boolean; sendDisabled?: boolean; sendDescriptionId?: string; placeholder?: string;
}>) {
  return <form className="conversation-composer" onSubmit={event => { event.preventDefault(); onSend(); }}>
    <label className="sr-only" htmlFor="conversation-draft">Message</label>
    <textarea id="conversation-draft" value={value} onChange={event => onChange(event.target.value)} disabled={disabled} rows={1} placeholder={placeholder}
      onKeyDown={event => {
        if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        event.preventDefault();
        if (!disabled && !sendDisabled && value.trim()) onSend();
      }} />
    <button type="submit" disabled={disabled || sendDisabled || !value.trim()} aria-describedby={sendDescriptionId} aria-label="Send message">↑</button>
  </form>;
}

export function ParticipantDetail({ name, children, onClose }: Readonly<{ name: string; children?: ReactNode; onClose(): void }>) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  const [overlay, setOverlay] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 1100px)').matches);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 1100px)');
    const update = () => setOverlay(media.matches);
    media.addEventListener('change', update);
    update();
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    if (!overlay) return undefined;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => opener?.focus();
  }, [overlay]);
  function handleKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (!overlay) return;
    if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
    if (event.key !== 'Tab') return;
    const focusable = [...(detailRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])') ?? [])];
    if (focusable.length === 0) { event.preventDefault(); closeRef.current?.focus(); return; }
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }
  return <aside ref={detailRef} className="conversation-detail" role={overlay ? 'dialog' : 'complementary'}
    aria-modal={overlay ? 'true' : undefined} aria-label="Conversation details" onKeyDown={handleKeyDown}>
    <button ref={closeRef} type="button" onClick={onClose} aria-label="Close details">×</button><h2>{name}</h2>{children}</aside>;
}

export function ConversationLayout({ list, thread, detail, inThread = false }: Readonly<{
  list?: ReactNode; thread?: ReactNode; detail?: ReactNode; inThread?: boolean;
}>) {
  return <div className={`conversation-layout${inThread ? ' conversation-layout--thread' : ''}${detail ? ' conversation-layout--detail' : ''}${list ? '' : ' conversation-layout--no-list'}`}>
    {list}{thread ?? <section className="conversation-thread conversation-thread--empty" aria-label="Conversation thread"><p>Select a conversation to read its messages.</p></section>}{detail}
  </div>;
}
