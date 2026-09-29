import { useEffect, useRef, useState } from 'react';
import type { AdmissionPort, RoomId } from '@khala/contracts/messaging/index';
import { copyShareLink, type CopyResult } from '../../ui/share-link';

type ShareState = Readonly<{ operationId: string; url: string | null; status: 'idle' | 'busy' | 'ready' | 'error'; error: string | null }>;
const fresh = (): ShareState => ({ operationId: crypto.randomUUID(), url: null, status: 'idle', error: null });

/** Admission remains server-enforced; this control shares one link and reports copy feedback. */
export function ChannelSharePanel({ admission, roomId, onCopy = copyShareLink }: Readonly<{
  admission: Pick<AdmissionPort, 'share'>;
  roomId: RoomId;
  onCopy?: (url: string) => Promise<CopyResult>;
}>) {
  const [link, setLink] = useState<ShareState>(fresh);
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copiedTimer.current) clearTimeout(copiedTimer.current); }, []);

  async function share(): Promise<string | null> {
    const current = link;
    const set = setLink;
    if (current.status === 'busy') return null;
    if (current.url) return current.url;
    set({ ...current, status: 'busy', error: null });
    try {
      const result = await admission.share({ operationId: current.operationId, roomId,
        policy: { v: 1, kind: 'link', history: 'none' } });
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
    const url = await share();
    if (!url) return;
    const result = await onCopy(url);
    setCopied(result.ok ? 'copied' : 'failed');
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    if (result.ok) copiedTimer.current = setTimeout(() => setCopied('idle'), 2200);
  }

  return <section className="channel-share" aria-label="Share channel">
    <button type="button" className="aiur-shell__icon-button" aria-label="Copy channel invite link" title="Copy channel invite link" onClick={() => void copy()} disabled={link.status === 'busy'}>
      <svg aria-hidden="true" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="18" cy="5" r="2"/><circle cx="6" cy="12" r="2"/><circle cx="18" cy="19" r="2"/><path d="m8 11 8-5M8 13l8 5"/></svg>
    </button>
    {link.url && copied === 'failed' ? <input aria-label="Channel link" readOnly value={link.url} onFocus={event => event.currentTarget.select()} /> : null}
    {link.error ? <p role="alert">Could not prepare a link ({link.error}). Try again.</p> : null}
    {copied === 'copied' ? <p role="status">Copied</p> : null}
    {copied === 'failed' ? <p role="alert">Copy failed. Select the link above to copy it.</p> : null}
  </section>;
}
