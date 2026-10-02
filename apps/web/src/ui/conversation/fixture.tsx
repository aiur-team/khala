import { useState, type CSSProperties } from 'react';
import { Avatar } from '../khala/Avatar';
import { KhalaApp } from '../khala/KhalaApp';
import { ChatComposer, ChatMessage, ChatThread, ConversationList, ParticipantDetail, type ConversationSummary } from './index';

/** Deterministic populated visual state for screenshot comparison. Never imported by production. */
const conversations: readonly ConversationSummary[] = [
  { id: 'design', title: 'Khala design', preview: 'The conversation view is ready for review.', timestamp: '2026-09-28T12:10:00.000Z', unreadCount: 2 },
  { id: 'release', title: 'Release planning', preview: 'I checked the deployment notes.', timestamp: '2026-09-27T14:05:00.000Z', unreadCount: null },
  { id: 'support', title: 'Owner support', preview: null, timestamp: null, unreadCount: null },
];

export function ConversationFixture() {
  const [selected, setSelected] = useState('design');
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState('');
  const [detail, setDetail] = useState(false);
  const [inThread, setInThread] = useState(false);
  const current = conversations.find(item => item.id === selected)!;
  return <KhalaApp theme="dark" inThread={inThread}
    list={<ConversationList conversations={conversations} selectedId={selected} query={query} onQueryChange={setQuery}
      onSelect={id => { setSelected(id); setInThread(true); }} status="ready" />}
    main={<ChatThread title={current.title} onBack={() => setInThread(false)}
      headerDetail={<span className="conversation-fixture__subtitle">Alex, Mira · encrypted</span>}
      headerActions={<button type="button" className="conversation-fixture__details" onClick={() => setDetail(true)}>Conversation details</button>}>
      <ol className="fixture-messages" aria-label="Messages">
        {current.id === 'support' ? <li className="conversation-system-event">No messages yet</li> : <>
        <ChatMessage id="one" author="Alex" time="2026-09-28T12:00:00.000Z">Can we review the conversation layout?</ChatMessage>
        <ChatMessage id="two" author="Mira" time="2026-09-28T12:06:00.000Z">The list and thread look good in both themes.</ChatMessage>
        <ChatMessage id="three" author="You" time="2026-09-28T12:10:00.000Z" mine>The conversation view is ready for review.</ChatMessage>
        </>}
      </ol>
      <ChatComposer value={draft} onChange={setDraft} onSend={() => setDraft('')} />
    </ChatThread>}
    detail={detail ? <ParticipantDetail name="Conversation details" kind="Human" onClose={() => setDetail(false)}>
      <div className="kh-d-hero"><Avatar kind="human" static label="Mira" hue={330} initials="MI" /><b>Mira</b><span>Owner of 1 agent</span>
        <button type="button" className="kh-d-owner" style={{ '--oh': 330 } as CSSProperties}><i>MI</i><span>Owned by <b>Mira</b></span></button></div>
      <div className="kh-d-sec"><span className="kh-d-lbl">Agents · 1</span><div className="kh-d-agents">
        <div role="button" tabIndex={0} className="kh-d-agent"><Avatar kind="agent" static label="Scout" hue={210} ownerHue={330}
          ownerInitials="MI" logo={null} initials="SC" /><span><b>Scout</b><em>Claude Code</em></span></div>
      </div></div>
    </ParticipantDetail> : undefined} />;
}
