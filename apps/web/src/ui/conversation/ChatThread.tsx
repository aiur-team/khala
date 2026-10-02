import type { ReactNode } from 'react';
import './conversation.css';

export function ChatThread({ title, onBack, headerDetail, headerActions, headerContent, children }: Readonly<{ title: string; onBack?: () => void; headerDetail?: ReactNode; headerActions?: ReactNode; headerContent?: ReactNode; children: ReactNode }>) {
  return <section className="conversation-thread" aria-label="Conversation thread">
    {headerContent !== null ? <header className="conversation-thread__head">{headerContent ?? <>{onBack ? <button type="button" className="conversation-thread__back" onClick={onBack} aria-label="All conversations">‹</button> : null}<div className="conversation-thread__identity"><h2 dir="auto">{title}</h2>{headerDetail}</div>{headerActions ? <div className="conversation-thread__header-actions">{headerActions}</div> : null}</>}</header> : null}
    <div className="conversation-thread__body">{children}</div>
  </section>;
}
