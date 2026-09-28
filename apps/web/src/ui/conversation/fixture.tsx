import { useState } from 'react';
import { ChatComposer, ChatMessage, ChatThread, ConversationLayout, ConversationList, ParticipantDetail, type ConversationSummary } from './index';

/** Deterministic populated visual state for screenshot comparison. Never imported by production. */
const conversations: readonly ConversationSummary[] = [
  { id: 'design', title: 'Khala design', preview: 'The conversation view is ready for review.', timestamp: '2026-09-28T12:10:00.000Z', unreadCount: 2 },
  { id: 'release', title: 'Release planning', preview: 'I checked the deployment notes.', timestamp: '2026-09-27T14:05:00.000Z', unreadCount: null },
  { id: 'support', title: 'Owner support', preview: 'Thanks, that answers my question.', timestamp: '2026-09-25T19:30:00.000Z', unreadCount: null },
];

export function ConversationFixture() {
  const [selected, setSelected] = useState('design');
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState('');
  const [detail, setDetail] = useState(false);
  const [inThread, setInThread] = useState(false);
  const current = conversations.find(item => item.id === selected)!;
  return <ConversationLayout inThread={inThread}
    list={<ConversationList conversations={conversations} selectedId={selected} query={query} onQueryChange={setQuery}
      onSelect={id => { setSelected(id); setInThread(true); }} status="ready" />}
    thread={<ChatThread title={current.title} onBack={() => setInThread(false)}>
      <div className="channel-screen__chat-actions"><span>Encrypted conversation</span><button type="button" onClick={() => setDetail(true)}>Conversation details</button></div>
      <ol className="fixture-messages" aria-label="Messages">
        <ChatMessage id="one" author="Alex" time="2026-09-28T12:00:00.000Z">Can we review the conversation layout?</ChatMessage>
        <ChatMessage id="two" author="Mira" time="2026-09-28T12:06:00.000Z">The list and thread look good in both themes.</ChatMessage>
        <ChatMessage id="three" author="You" time="2026-09-28T12:10:00.000Z" mine>The conversation view is ready for review.</ChatMessage>
      </ol>
      <ChatComposer value={draft} onChange={setDraft} onSend={() => setDraft('')} />
    </ChatThread>}
    detail={detail ? <ParticipantDetail name={current.title} onClose={() => setDetail(false)}><p>Encrypted conversation</p></ParticipantDetail> : undefined} />;
}
