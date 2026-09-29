import { useState, type FormEvent } from 'react';
import type { AdmissionPort, RoomId } from '@khala/contracts/messaging/index';
import { copyShareLink, type CopyResult } from '../../ui/share-link';

const EMAIL = /^[^\s@]+@[^\s@]+$/;
type ShareState = Readonly<{ operationId: string; url: string | null; status: 'idle' | 'busy' | 'ready' | 'error'; error: string | null }>;
const fresh = (): ShareState => ({ operationId: crypto.randomUUID(), url: null, status: 'idle', error: null });

/** Admission is enforced by the server; the email action prepares a named invite and a user-owned email draft. */
export function ChannelSharePanel({ admission, roomId, roomTitle, onCopy = copyShareLink }: Readonly<{
  admission: Pick<AdmissionPort, 'share'>;
  roomId: RoomId;
  roomTitle: string;
  onCopy?: (url: string) => Promise<CopyResult>;
}>) {
  const [link, setLink] = useState<ShareState>(fresh);
  const [named, setNamed] = useState<ShareState>(fresh);
  const [email, setEmail] = useState('');
  const [emailError, setEmailError] = useState(false);
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');

  async function share(kind: 'link' | 'named_email', address?: string): Promise<string | null> {
    const current = kind === 'link' ? link : named;
    const set = kind === 'link' ? setLink : setNamed;
    if (current.status === 'busy') return null;
    if (current.url) return current.url;
    set({ ...current, status: 'busy', error: null });
    try {
      const result = await admission.share({ operationId: current.operationId, roomId,
        policy: kind === 'link' ? { v: 1, kind: 'link', history: 'none' }
          : { v: 1, kind: 'named_email', email: address!, history: 'none' } });
      if (result.kind === 'ok') {
        set({ ...current, status: 'ready', url: result.value.shareUrl, error: null });
        return result.value.shareUrl;
      }
      // An unknown outcome retries the same operation ID; rejected operations get a fresh one.
      set({ ...current, operationId: result.kind === 'outcome_unknown' ? current.operationId : crypto.randomUUID(),
        status: 'error', error: result.kind === 'rejected' ? result.code : 'unavailable' });
    } catch {
      set({ ...current, status: 'error', error: 'unavailable' });
    }
    return null;
  }

  async function copy() {
    const url = await share('link');
    if (!url) return;
    const result = await onCopy(url);
    setCopied(result.ok ? 'copied' : 'failed');
  }

  function submitEmail(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const address = email.trim();
    if (!EMAIL.test(address)) { setEmailError(true); return; }
    setEmailError(false);
    void share('named_email', address);
  }

  const draft = named.url ? `mailto:${encodeURIComponent(email.trim())}?subject=${encodeURIComponent(`Join ${roomTitle} on Khala`)}&body=${encodeURIComponent(`Join my encrypted Khala channel: ${named.url}`)}` : null;
  return <section className="channel-share" aria-label="Share channel">
    <button type="button" onClick={() => void copy()} disabled={link.status === 'busy'}>Copy link</button>
    {link.url ? <input aria-label="Channel link" readOnly value={link.url} onFocus={event => event.currentTarget.select()} /> : null}
    {link.error ? <p role="alert">Could not prepare a link ({link.error}). Try again.</p> : null}
    {copied === 'copied' ? <p role="status">Link copied.</p> : null}
    {copied === 'failed' ? <p role="alert">Copy failed. Select the link above to copy it.</p> : null}
    <form onSubmit={submitEmail}>
      <label htmlFor="channel-invite-email">Invite by email</label>
      <input id="channel-invite-email" type="email" value={email} disabled={named.status === 'busy'} onChange={event => {
        setEmail(event.target.value); setEmailError(false); setNamed(fresh());
      }} aria-invalid={emailError} />
      <button type="submit" disabled={named.status === 'busy'}>Create email invite</button>
    </form>
    {emailError ? <p role="alert">Enter a valid email address.</p> : null}
    {named.error ? <p role="alert">Could not create the email invite ({named.error}). Try again.</p> : null}
    {named.url ? <><input aria-label="Email invite link" readOnly value={named.url} onFocus={event => event.currentTarget.select()} />
      <a href={draft!}>Open email draft</a><p role="status">Invite prepared for {email.trim()}. Send the email from your mail app.</p></> : null}
  </section>;
}
