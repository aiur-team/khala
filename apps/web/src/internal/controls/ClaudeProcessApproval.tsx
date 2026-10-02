import { useEffect, useRef, useState, type FormEvent } from 'react';
import { readRequestSecret } from '../composition/ports';

/** The owner copies the code shown in the intended Claude conversation. */
export function ClaudeProcessApproval({ channelId, onClose }: Readonly<{ channelId: string; onClose(): void }>) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [sessionId, setSessionId] = useState('');
  const [bindingId, setBindingId] = useState('');
  const [candidateId, setCandidateId] = useState('');
  const [code, setCode] = useState('');
  const [state, setState] = useState<'ready' | 'submitting' | 'approved' | 'refused'>('ready');
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => { if (element?.open) element.close(); };
  }, []);
  async function approve(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const secret = readRequestSecret();
    if (secret === null) { setState('refused'); return; }
    setState('submitting');
    try {
      const response = await fetch(`/api/v1/channels/${encodeURIComponent(channelId)}/claude-process/approve`, {
        method: 'POST', credentials: 'same-origin', redirect: 'error',
        headers: { 'content-type': 'application/json', 'x-khala-request-secret': secret },
        body: JSON.stringify({ v: 1, sessionId, bindingId, candidateId, code }),
      });
      setState(response.ok ? 'approved' : 'refused');
    } catch { setState('refused'); }
  }
  return <dialog ref={dialog} aria-label="Approve Claude process" className="claude-process-approval" onClose={onClose}>
      <h2>Approve Claude process</h2>
      <p>In the intended Claude conversation, run <code>khala_prove_session</code>. Copy its four fields here. Compare the code in that conversation before approving.</p>
      <form onSubmit={event => void approve(event)}>
        <label>Session ID<input required value={sessionId} onChange={event => setSessionId(event.target.value)} /></label>
        <label>Binding ID<input required value={bindingId} onChange={event => setBindingId(event.target.value)} /></label>
        <label>Candidate ID<input required value={candidateId} onChange={event => setCandidateId(event.target.value)} /></label>
        <label>Code from Claude<input required value={code} onChange={event => setCode(event.target.value)} /></label>
        <button type="submit" disabled={state === 'submitting' || state === 'approved'}>Approve this process</button>
        <button type="button" onClick={() => dialog.current?.close()}>Close</button>
      </form>
      {state === 'approved' ? <p role="status">Process approved. Return to Claude and call Khala read or send.</p> : null}
      {state === 'refused' ? <p role="alert">Approval failed. Check the exact fields and current binding.</p> : null}
  </dialog>;
}
