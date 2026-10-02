import type { ReactNode } from 'react';
import { clockLabel } from '../khala/format-time';
import './conversation.css';

type RenameProps = Readonly<{ id: string; previousName: string; name: string; actor: string; time: string }>;
type LegacyProps = Readonly<{ id: string; actor: string; children: ReactNode }>;

/**
 * An ordered, attributed event in the conversation rather than a chat bubble.
 * A rename renders as a static §8 `.kh-ev` pill; the children form is the
 * earlier markup the landing showcase still uses.
 */
export function ChatSystemEvent(props: RenameProps | LegacyProps) {
  if ('previousName' in props) {
    return <li data-event-id={props.id} className="kh-ev kh-ev--static">
      <i aria-hidden="true" />
      <span dir="auto">{props.previousName} is now {props.name} · {props.actor} · <time dateTime={props.time}>{clockLabel(new Date(props.time))}</time></span>
    </li>;
  }
  return <li data-event-id={props.id} className="conversation-system-event">
    <span className="conversation-system-event__text" dir="auto">{props.children}</span>
    <span className="conversation-system-event__actor" dir="auto">Changed by {props.actor}</span>
  </li>;
}
