import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { KhalaPageFrame } from '../KhalaPageFrame';
import type { ThemeChoice } from '../types';
import { ChatComposer, ChatMessage, ChatThread, ConversationLayout, ConversationList, type ConversationSummary } from '../../ui/conversation';
import { Avatar } from '../../ui/khala/Avatar';
import { KhalaApp } from '../../ui/khala/KhalaApp';
import { LogOutIcon, PlusIcon } from '../../ui/khala/icons';

// Synthetic content only: no real channel, credential or person.
const conversations: ConversationSummary[] = [
  { id: 'launch', title: 'Release retro', preview: 'The build is green on every target.', timestamp: '2026-09-28T09:41:00Z', unreadCount: 2,
    members: [{ id: '@maya:khala.test', kind: 'human', displayName: 'Maya Chen' }, { id: '@agent-1a2b3c4d-x9y8z7:khala.test', kind: 'agent', displayName: 'Claude · Kai' }],
    lastSender: { label: 'Claude', isViewer: false } },
  { id: 'design', title: 'Design review', preview: 'The brand row lands at 300px.', timestamp: '2026-09-27T16:05:00Z', unreadCount: null,
    members: [{ id: '@kai:khala.test', kind: 'human', displayName: 'Kai' }], lastSender: { label: 'Kai', isViewer: true } },
  { id: 'empty', title: 'A rather long channel name that has to truncate inside the list column', preview: null, timestamp: null, unreadCount: null, members: [] },
];
// A pinned clock and zone, so list times never drift between screenshot runs.
const now = new Date('2026-09-28T12:00:00Z');

const params = new URLSearchParams(window.location.search);

function Harness() {
  const [theme, setTheme] = useState<ThemeChoice>(params.get('theme') === 'light' ? 'light' : 'dark');
  const [inThread, setInThread] = useState(params.get('view') === 'thread');
  const [query, setQuery] = useState('');
  return <KhalaApp theme={theme} onThemeChange={setTheme} homeHref="#conversations" inThread={inThread} live
    // `?probe` adds an interactive avatar, so the browser spec can check that component fonts beat the base rules.
    detail={params.has('probe') ? <Avatar kind="human" label="Maya Chen" hue={330} initials="MC" /> : null}
    brandActions={<button type="button" className="tool-btn icon-only" aria-label="Log out" title="Log out"><LogOutIcon /></button>}
    list={<ConversationList conversations={conversations} selectedId={inThread ? 'launch' : null} query={query} onQueryChange={setQuery}
      status="ready" onSelect={() => setInThread(true)} now={now} timeOptions={{ timeZone: 'UTC' }}
      action={<button type="button" className="kh-ib sm" data-tip="New channel" aria-label="New channel"><PlusIcon /></button>} />}
    main={<div className="channel-page"><KhalaPageFrame model={{ title: 'Release retro', labelledBy: 'harness-title' }}>
      <ConversationLayout inThread thread={<ChatThread title="Release retro" onBack={() => setInThread(false)}>
        <ul className="fixture-messages">
          <ChatMessage id="m1" author="Maya Chen" time="2026-09-28T09:41:00Z">Kicking off the retro. What went well?</ChatMessage>
          <ChatMessage id="m2" author="Claude" kindLabel="Agent" time="2026-09-28T09:42:00Z">The build is green on every target.</ChatMessage>
          <ChatMessage id="m3" author="You" mine time="2026-09-28T09:43:00Z">{'A long wrapping synthetic message. '.repeat(6)}</ChatMessage>
        </ul>
        <ChatComposer value="" onChange={() => {}} onSend={() => {}} />
      </ChatThread>} />
    </KhalaPageFrame></div>} />;
}

createRoot(document.getElementById('root')!).render(<Harness />);
