import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatComposer, ChatMessage, ChatSystemEvent, ConversationLayout, ConversationList, ParticipantDetail, type ConversationSummary } from '../ui/conversation';
import './showcase.css';

type Example = Readonly<{
  id: string;
  title: string;
  context: string;
  preview: string;
  participants: readonly { name: string; role: string }[];
  messages: readonly ({ kind: 'message'; author: string; role: string; text: string; mine?: boolean }
    | { kind: 'rename'; actor: string; before: string; after: string })[];
}>;

const examples: readonly Example[] = [
  {
    id: 'planning', title: 'Launch', context: 'Launch checklist · ticket #42',
    preview: 'I can take the docs while you verify the flow.',
    participants: [{ name: 'Maya', role: 'Owner' }, { name: 'Theo', role: 'Collaborator' }, { name: 'Dolan', role: 'Agent · owned by Maya' }],
    messages: [
      { kind: 'message', author: 'Maya', role: 'Owner', mine: true, text: 'Can we split the launch checklist?' },
      { kind: 'message', author: 'Codex #420', role: 'Agent', text: 'I can take the docs.' },
      { kind: 'rename', actor: 'Maya', before: 'Codex #420', after: 'Dolan' },
      { kind: 'message', author: 'Theo', role: 'Collaborator', text: 'I’ll verify the browser flow and report what I find.' },
      { kind: 'message', author: 'Dolan', role: 'Agent', text: 'I can take the docs while you verify the flow.' },
    ],
  },
  {
    id: 'review', title: 'Design', context: 'Conversation view · ticket #529',
    preview: 'The smaller layout keeps the back control visible.',
    participants: [{ name: 'Alex', role: 'Owner' }, { name: 'Jordan', role: 'Collaborator' }, { name: 'Jordan’s agent', role: 'Agent' }],
    messages: [
      { kind: 'message', author: 'Alex', role: 'Owner', mine: true, text: 'How does the thread feel on a phone?' },
      { kind: 'message', author: 'Jordan', role: 'Collaborator', text: 'The conversation list gives way to the thread after a tap.' },
      { kind: 'message', author: 'Jordan’s agent', role: 'Agent', text: 'The smaller layout keeps the back control visible.' },
    ],
  },
  {
    id: 'handoff', title: 'Handoff', context: 'Release notes · ticket #88',
    preview: 'I’ve outlined the next steps for both owners.',
    participants: [{ name: 'Priya', role: 'Owner' }, { name: 'Sam', role: 'Collaborator' }, { name: 'Priya’s agent', role: 'Agent' }],
    messages: [
      { kind: 'message', author: 'Priya', role: 'Owner', mine: true, text: 'What should we hand over before the next review?' },
      { kind: 'message', author: 'Sam', role: 'Collaborator', text: 'I’ll add the open questions to the notes.' },
      { kind: 'message', author: 'Priya’s agent', role: 'Agent', text: 'I’ve outlined the next steps for both owners.' },
    ],
  },
];

const summaries: readonly ConversationSummary[] = examples.map(example => ({
  id: example.id, title: example.title, preview: example.preview, timestamp: null, unreadCount: null,
}));

export function ParticipantsIcon() {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <circle cx="12" cy="8" r="2.5"/><circle cx="4.5" cy="9.5" r="2"/><circle cx="19.5" cy="9.5" r="2"/>
    <path d="M7 19v-1.2a5 5 0 0 1 10 0V19H7ZM2 18v-.7a3.5 3.5 0 0 1 3.5-3.5c.8 0 1.5.2 2.1.7M22 18v-.7a3.5 3.5 0 0 0-3.5-3.5c-.8 0-1.5.2-2.1.7"/>
  </svg>;
}

export function ExampleShowcase() {
  const [selected, setSelected] = useState(examples[0]!.id);
  const [inThread, setInThread] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState('');
  const [localMessages, setLocalMessages] = useState<Record<string, string[]>>({});
  const example = examples.find(item => item.id === selected)!;
  const send = () => {
    const message = draft.trim();
    if (!message) return;
    setLocalMessages(previous => ({ ...previous, [selected]: [...(previous[selected] ?? []), message] }));
    setDraft('');
  };
  return <div className="showcase-app khala-content-root" aria-label="Interactive local conversation demo">
    <ConversationLayout inThread={inThread}
      list={<ConversationList conversations={summaries} selectedId={selected} query={query} onQueryChange={setQuery} status="ready"
        onSelect={id => { setSelected(id); setDetailsOpen(false); setDraft(''); setInThread(true); requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('.showcase-app .conversation-thread__back')?.focus()); }} />}
      thread={<section className="conversation-thread" aria-label="Conversation thread">
        <header className="conversation-thread__head">
          <button type="button" className="conversation-thread__back" onClick={() => { setDetailsOpen(false); setInThread(false); requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`.showcase-app .conversation-list__item[aria-current="page"]`)?.focus()); }} aria-label="All conversations">‹</button>
          <h2 dir="auto">{example.title}</h2>
          <button type="button" className="showcase-app__participants-button" aria-label="Participants and agents" aria-expanded={detailsOpen} onClick={() => setDetailsOpen(!detailsOpen)}>
            <ParticipantsIcon />
          </button>
        </header>
        <div className="conversation-thread__body">
          <ol className="fixture-messages">
          {example.messages.map((message, index) => message.kind === 'rename'
            ? <ChatSystemEvent key={`${example.id}-${index}`} id={`${example.id}-${index}`} actor={message.actor}>
              {message.before} is now called {message.after}
            </ChatSystemEvent>
            : <ChatMessage key={`${example.id}-${index}`} id={`${example.id}-${index}`} author={message.author} kindLabel={message.role} mine={message.mine ?? false}>{message.text}</ChatMessage>)}
            {(localMessages[selected] ?? []).map((message, index) => <ChatMessage key={`local-${index}`} id={`local-${index}`} author="You" kindLabel="Local example" mine>{message}</ChatMessage>)}
          </ol>
          <p className="showcase-app__local-note" id="showcase-local-note">Messages stay in this page and are not sent to agents.</p>
          <ChatComposer value={draft} onChange={setDraft} onSend={send} sendDescriptionId="showcase-local-note" placeholder="" />
        </div>
      </section>}
      detail={detailsOpen ? <ParticipantDetail name="Participants and agents" onClose={() => setDetailsOpen(false)}>
        <p className="showcase-app__detail-context">{example.context}</p>
        <ul className="showcase-app__participants">{example.participants.map(person => <li key={person.name}><span className="showcase-app__participant-avatar" aria-hidden="true">{person.name[0]}</span><span><strong>{person.name}</strong><small>{person.role}</small></span></li>)}</ul>
        <details className="showcase-app__agent-section"><summary>Agent participation</summary><p>Agents in this example can help their owners coordinate. This preview is local and has no connected agents.</p></details>
      </ParticipantDetail> : undefined} />
  </div>;
}

export function mountExampleShowcase(element: HTMLElement): void {
  createRoot(element).render(<ExampleShowcase />);
}
