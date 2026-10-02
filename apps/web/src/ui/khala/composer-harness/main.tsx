import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatComposer, type MentionTarget } from '../../conversation';
import { KhalaApp } from '../KhalaApp';

// Synthetic people and agents only (the design's worked example).
const targets: readonly MentionTarget[] = [
  { id: 'p-kevin', kind: 'human', label: 'Kevin', display: 'Kevin', hue: 214, ownerHue: 214, ownerInitials: 'YO', ownerId: 'o-kevin', isViewer: true },
  { id: 'a1', kind: 'agent', label: 'Claude', display: 'Claude #frontend', hue: 210, ownerHue: 214, ownerInitials: 'KE', harness: 'claude', ownerId: 'o-kevin', isViewer: false },
  { id: 'p-maya', kind: 'human', label: 'Maya', display: 'Maya', hue: 330, ownerHue: 330, ownerInitials: 'MC', ownerId: 'o-maya', isViewer: false },
  { id: 'a2', kind: 'agent', label: 'Codex', display: 'Codex #backend', hue: 150, ownerHue: 330, ownerInitials: 'MC', harness: 'codex', ownerId: 'o-maya', isViewer: false },
  { id: 'p-kai', kind: 'human', label: 'Kai', display: 'Kai', hue: 150, ownerHue: 150, ownerInitials: 'KA', ownerId: 'o-kai', isViewer: false },
  { id: 'a3', kind: 'agent', label: 'Claude', display: 'Claude #infra', hue: 32, ownerHue: 150, ownerInitials: 'KA', harness: 'claude', ownerId: 'o-kai', isViewer: false },
];

const params = new URLSearchParams(window.location.search);

function Harness() {
  const [draft, setDraft] = useState('');
  const [sent, setSent] = useState<string[]>([]);
  return <KhalaApp theme={params.get('theme') === 'light' ? 'light' : 'dark'} inThread
    main={<div style={{ display: 'flex', flexDirection: 'column' }}>
      <ol data-testid="sent" style={{ flex: 1, margin: 0 }}>{sent.map((body, index) => <li key={index}>{body}</li>)}</ol>
      <ChatComposer value={draft} onChange={setDraft} onSend={() => { setSent([...sent, draft.trim()]); setDraft(''); }} mentionTargets={targets} />
    </div>} />;
}

createRoot(document.getElementById('root')!).render(<Harness />);
