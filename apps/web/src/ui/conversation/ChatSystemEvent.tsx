import type { ReactNode } from 'react';
import './conversation.css';

/** An ordered, attributed event in the conversation rather than a chat bubble. */
export function ChatSystemEvent({ id, actor, children }: Readonly<{ id: string; actor: string; children: ReactNode }>) {
  return <li data-event-id={id} className="conversation-system-event">
    <span className="conversation-system-event__text" dir="auto">{children}</span>
    <span className="conversation-system-event__actor" dir="auto">Changed by {actor}</span>
  </li>;
}
