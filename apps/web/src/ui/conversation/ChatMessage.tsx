import type { AnimationEventHandler, CSSProperties, ReactNode } from 'react';
import { clockLabel, type TimeOptions } from '../khala/format-time';
import './conversation.css';

/** Where a row sits in its run (`features/timeline/runs.ts`, RECREATION-SPEC §7.1). */
export type ThreadRun = Readonly<{ first: boolean; mid: boolean; lastOf: boolean; showName: boolean; showAvatar: boolean }>;

export type ThreadRowName = Readonly<{
  /** Agent label (`Claude`) or human display name. */
  label: string;
  hue: number;
  /** Collision suffix such as `#395`; rendered only when set. */
  idBadge?: string;
  /** `Human` for other humans; agents carry no tag (their avatar's owner badge says whose they are). */
  tag: Readonly<{ kind: 'htag' }> | null;
  ariaLabel: string;
  onClick?: () => void;
}>;

type ThreadRowProps = Readonly<{
  id: string;
  run: ThreadRun;
  sender: 'me' | 'human' | 'agent';
  /**
   * Agent rows: whose agent it is. The bubble takes a greyed tint of its owner's colour: the viewer's
   * accent for `.yours`, the owner's identity hue (`--oh`, as on the avatar's owner badge) for `.theirs`.
   */
  agentOwner?: Readonly<{ yours: boolean; hue: number }>;
  /** ISO time: the row `title` and the name line's `dateTime`. */
  time?: string;
  /** Fixtures and tests pass UTC; the product uses the viewer's local time. */
  timeOptions?: TimeOptions;
  name?: ThreadRowName;
  /** The §3 avatar button (or its ghost); omitted for the viewer. */
  avatar?: ReactNode;
  live?: boolean;
  pop?: boolean;
  onPopEnd?: AnimationEventHandler<HTMLLIElement>;
  pending?: boolean;
  failed?: boolean;
  /** A `.kh-retry` button; after the column in the DOM, so `row-reverse` places it left of the bubble. */
  retry?: ReactNode;
  /** App-owned controls under the bubble (review slot, evidence). */
  after?: ReactNode;
  className?: string;
  children: ReactNode;
}>;

type LegacyProps = Readonly<{
  id: string; author: string; time?: string; mine?: boolean; grouped?: boolean;
  live?: boolean;
  kindLabel?: string; status?: string; className?: string; children: ReactNode;
}>;

/**
 * A thread row. With `run` it renders the §7.1 design row; without it, the
 * earlier card markup the landing showcase and harnesses still use.
 */
export function ChatMessage(props: ThreadRowProps | LegacyProps) {
  return 'run' in props ? <ThreadRow {...props} /> : <LegacyMessage {...props} />;
}

function ThreadRow({ id, run, sender, agentOwner, time, timeOptions, name, avatar, live = false, pop = false, onPopEnd, pending = false, failed = false,
  retry, after, className = '', children }: ThreadRowProps) {
  const position = run.first ? 'first' : run.mid ? 'mid' : 'last-of';
  const classes = ['kh-row', sender === 'me' ? 'me' : sender === 'human' ? 'human' : '',
    sender === 'agent' && agentOwner ? `agent ${agentOwner.yours ? 'yours' : 'theirs'}` : '', position,
    pop ? 'pop' : '', pending ? 'pending' : '', failed ? 'failed' : '', className].filter(Boolean).join(' ');
  return <li data-event-id={id} aria-live={live ? 'polite' : undefined} className={classes} title={time}
    style={sender === 'agent' && agentOwner ? { '--oh': agentOwner.hue } as CSSProperties : undefined} onAnimationEnd={pop ? onPopEnd : undefined}>
    {run.showAvatar ? avatar : null}
    <div className="kh-col">
      {run.showName && name ? <button type="button" className="kh-name" style={{ '--h': name.hue } as CSSProperties}
        aria-label={name.ariaLabel} onClick={name.onClick}>
        <b dir="auto">{name.label}</b>
        {name.idBadge ? <span className="kh-id">{name.idBadge}</span> : null}
        {name.tag?.kind === 'htag' ? <span className="kh-htag">Human</span> : null}
        {time ? <time dateTime={time} title={time}>{clockLabel(new Date(time), timeOptions)}</time> : null}
      </button> : null}
      <div className="kh-b">{children}</div>
      {after}
    </div>
    {retry}
  </li>;
}

function LegacyMessage({ id, author, time, mine = false, grouped = false, live = false, kindLabel, status, className = '', children }: LegacyProps) {
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
