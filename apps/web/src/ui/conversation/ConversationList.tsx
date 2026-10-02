// The conversation list pane (RECREATION-SPEC §4.1, states §13.4). It renders
// inside `KhalaApp`'s `.kh-list` column, below the brand row.

import type { ReactNode } from 'react';
import { Avatar } from '../khala/Avatar';
import { clockLabel, dayLabel, type TimeOptions } from '../khala/format-time';
import { SearchIcon } from '../khala/icons';
import { initials, useParticipantHue } from '../khala/identity';

export type ConversationMember = Readonly<{ id: string; kind: 'human' | 'agent'; displayName: string; ownerId?: string }>;

export type ConversationSummary = Readonly<{
  id: string;
  title: string;
  preview: string | null;
  timestamp: string | null;
  unreadCount: number | null;
  /** Joined members other than the viewer, in member order. */
  members?: readonly ConversationMember[];
  /** Who sent the latest message: a human's first name or an agent's label. */
  lastSender?: Readonly<{ label: string; isViewer: boolean }>;
}>;

const AGENT_OWNER_SEPARATOR = ' · ';

function MemberAvatar({ member }: Readonly<{ member: ConversationMember }>) {
  const hue = useParticipantHue();
  if (member.kind === 'human') {
    return <Avatar static kind="human" label={member.displayName} initials={initials(member.displayName)}
      hue={hue({ kind: 'human', ownerId: member.ownerId ?? member.id, participantId: member.id })} />;
  }
  // C4 display name: `<label> · <ownerFirstName>`.
  const [label = member.displayName, owner = ''] = member.displayName.split(AGENT_OWNER_SEPARATOR);
  return <Avatar static kind="agent" label={label} initials={initials(label)} logo={null}
    hue={hue({ kind: 'agent', participantId: member.id })}
    ownerHue={hue({ kind: 'human', ownerId: member.ownerId ?? owner })} ownerInitials={initials(owner)} />;
}

function previewText(item: ConversationSummary): string {
  if (item.preview === null) return item.timestamp ? 'Message unavailable on this device' : 'No messages yet';
  if (!item.lastSender) return item.preview;
  return `${item.lastSender.isViewer ? 'You' : item.lastSender.label}: ${item.preview}`;
}

function timeText(timestamp: string, now: Date, options: TimeOptions): string {
  const date = new Date(timestamp);
  const day = dayLabel(date, now, options);
  return day === 'Today' ? clockLabel(date, options) : day;
}

function SkeletonRow() {
  return <div className="kh-cv kh-cv-skel" aria-hidden="true">
    <span className="kh-cv-av" />
    <span className="kh-cv-t"><span /><span /></span>
  </div>;
}

export function ConversationList({ conversations, selectedId, query, onQueryChange, onSelect, status, emptyLabel = 'No channels yet.', action, showSearch = true, now = new Date(), timeOptions = {} }: Readonly<{
  conversations: readonly ConversationSummary[];
  selectedId?: string | null;
  query: string;
  onQueryChange(value: string): void;
  onSelect(id: string): void;
  status?: 'loading' | 'ready' | 'error';
  emptyLabel?: string;
  action?: ReactNode;
  showSearch?: boolean;
  /** The clock for "today"; fixtures and tests pin it. */
  now?: Date;
  /** Fixtures and tests pass UTC; the product uses the viewer's local time. */
  timeOptions?: TimeOptions;
}>) {
  const needle = query.toLocaleLowerCase();
  const visible = conversations.filter(item => `${item.title} ${item.preview ?? ''}`.toLocaleLowerCase().includes(needle));
  const unread = conversations.reduce((count, item) => count + (item.unreadCount ?? 0), 0);
  return <>
    <div className="kh-list-head"><b>Conversations</b><span>{unread} unread</span>{action}</div>
    {showSearch ? <label className="kh-search"><SearchIcon />
      <input type="search" value={query} onChange={event => onQueryChange(event.target.value)} placeholder="Search" aria-label="Search channels" />
    </label> : null}
    <div className="kh-convos">
      {status === 'loading' ? <><SkeletonRow /><SkeletonRow /><SkeletonRow /><span className="sr-only" role="status">Loading conversations…</span></> : null}
      {status === 'error' ? <div className="kh-cv-empty" role="alert">Conversations are unavailable. Try reloading.</div> : null}
      {status === 'ready' && visible.length === 0 ? <div className="kh-cv-empty" role="status">{conversations.length > 0 && query ? 'No conversations match.' : emptyLabel}</div> : null}
      {visible.map(item => {
        const preview = previewText(item);
        const time = item.timestamp ? timeText(item.timestamp, now, timeOptions) : null;
        const members = (item.members ?? []).slice(0, 2);
        const label = [item.title, preview, time, item.unreadCount ? `${item.unreadCount} unread` : null].filter(Boolean).join(', ');
        return <button key={item.id} type="button" className={`kh-cv${selectedId === item.id ? ' is-active' : ''}${item.unreadCount ? ' unread' : ''}`}
          data-kh-convo={item.id} aria-label={label} aria-current={selectedId === item.id ? 'page' : undefined} onClick={() => onSelect(item.id)}>
          <span className="kh-cv-av" aria-hidden="true">
            {members.length ? members.map(member => <MemberAvatar key={member.id} member={member} />) : <Avatar kind="generic" />}
          </span>
          <span className="kh-cv-t">
            <span><b dir="auto">{item.title}</b>{item.timestamp ? <time dateTime={item.timestamp}>{time}</time> : null}</span>
            <span className="kh-cv-pv" dir="auto">{preview}</span>
          </span>
        </button>;
      })}
    </div>
  </>;
}
