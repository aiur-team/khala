import type { ReactNode } from 'react';
import './conversation.css';

export function ConversationLayout({ list, thread, detail, inThread = false }: Readonly<{
  list?: ReactNode; thread?: ReactNode; detail?: ReactNode; inThread?: boolean;
}>) {
  return <div className={`conversation-layout${inThread ? ' conversation-layout--thread' : ''}${detail ? ' conversation-layout--detail' : ''}${list ? '' : ' conversation-layout--no-list'}`}>
    {list}{thread ?? <section className="conversation-thread conversation-thread--empty" aria-label="Conversation thread"><p>Select a conversation to read its messages.</p></section>}{detail}
  </div>;
}
