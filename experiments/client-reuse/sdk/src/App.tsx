import { useRef, useState } from 'react';
import { batch, messages, deliveryLabel, fixtureReviewPort, type ReviewPort } from '../../fixtures/scenario';
import { fixtureAuthentication, type AuthenticationPort } from './ports';

export function Conversation({ review = fixtureReviewPort(), auth = fixtureAuthentication() }: { review?: ReviewPort; auth?: AuthenticationPort }) {
  const [joined, setJoined] = useState(false);
  const [status, setStatus] = useState<'pending' | 'unknown' | 'acknowledged'>('pending');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  async function approve() {
    setBusy(true); setError('');
    try { setStatus(await review.approve(batch)); dialog.current?.close(); }
    catch { setError('Review failed. No confirmed delivery.'); }
    finally { setBusy(false); }
  }
  return <section className="conversation" aria-label="Conversation fixture">
    <header><p className="eyebrow">SYNTHETIC PRESENTATION FIXTURE</p><h1>Khala</h1><p>One shared plan. Each person keeps their own agent.</p></header>
    {!joined ? <section className="panel"><h2>Invitation from Alex</h2><p>Authentication return is simulated; no account or infrastructure setup.</p><button onClick={async () => { try { const returned = await auth.signInAndReturn('fixture-invitation'); setJoined(returned === 'fixture-invitation'); } catch { setError('Sign-in unavailable'); } }}>Continue with account (fixture)</button></section> : <>
      <section className="panel" aria-label="Timeline"><h2>Launch notes</h2>{messages.map(message => <article key={message.id}><strong>{message.author}</strong><p className={message.available ? '' : 'muted'}>{message.text}</p></article>)}</section>
      <section className="panel"><h2>Human review</h2><p role="status">{deliveryLabel(status)}</p><button ref={opener} disabled={status !== 'pending'} onClick={() => dialog.current?.showModal()}>Review selected batch</button></section>
      <dialog ref={dialog} onClose={() => opener.current?.focus()} aria-labelledby="review-heading"><h2 id="review-heading">Review selected batch</h2><p>{messages[0]!.text}</p><p>1 human event selected. Fixture approval only.</p><button autoFocus onClick={() => dialog.current?.close()} disabled={busy}>Close review</button> <button onClick={approve} disabled={busy}>Approve fixture batch</button>{error && <p role="alert">{error}</p>}</dialog>
    </>}{error && <p role="alert">{error}</p>}
  </section>;
}
export function App({ embedded = false }: { embedded?: boolean }) {
  const [collapsed, setCollapsed] = useState(false);
  const [light, setLight] = useState(false);
  if (embedded) return <Conversation />;
  return <div className={`dashboard ${collapsed ? 'collapsed' : ''}`} data-theme={light ? 'light' : 'dark'}>
    <header className="topbar"><strong>AIUR</strong><button onClick={() => setLight(!light)}>Use {light ? 'dark' : 'light'} theme</button></header>
    <nav aria-label="Main navigation"><button aria-expanded={!collapsed} onClick={() => setCollapsed(!collapsed)}>Toggle navigation</button><a href="#khala" aria-current="page">{collapsed ? 'K' : 'Khala'}</a></nav>
    <main id="khala"><Conversation /></main>
  </div>;
}
