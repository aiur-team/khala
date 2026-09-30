import { useEffect, useId, useRef, useState } from 'react';
import type { AdmissionPort, RoomId } from '@khala/contracts/messaging/index';
import { copyShareLink, type CopyResult } from '../../ui/share-link';
import type { HumanChannelLinks } from '../../composition/human/channel-links';

type ShareState = Readonly<{ operationId: string; url: string | null; status: 'idle' | 'busy' | 'ready' | 'error'; error: string | null }>;
const fresh = (): ShareState => ({ operationId: crypto.randomUUID(), url: null, status: 'idle', error: null });

/** Admission remains server-enforced; this control shares one link and reports copy feedback. */
export function ChannelSharePanel({ admission, channelLinks, roomId, onCopy = copyShareLink }: Readonly<{
  admission: Pick<AdmissionPort, 'share'>;
  channelLinks?: Pick<HumanChannelLinks, 'personal'>;
  roomId: RoomId;
  onCopy?: (url: string) => Promise<CopyResult>;
}>) {
  const [link, setLink] = useState<ShareState>(fresh);
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [copying, setCopying] = useState(false);
  const fallbackId = useId();
  const fallbackInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (copied === 'failed') {
      fallbackInput.current?.focus();
      fallbackInput.current?.select();
    }
  }, [copied]);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copiedTimer.current) clearTimeout(copiedTimer.current); }, []);
  useEffect(() => { if (channelLinks) void share(); }, []);

  async function share(): Promise<string | null> {
    const current = link;
    const set = setLink;
    if (current.status === 'busy') return null;
    if (current.url) return current.url;
    set({ ...current, status: 'busy', error: null });
    try {
      if (channelLinks) {
        const result = await channelLinks.personal(roomId);
        if (result.kind === 'personal_link') {
          set({ ...current, status: 'ready', url: result.shareUrl, error: null });
          return result.shareUrl;
        }
        set({ ...current, status: 'error', url: null, error: result.kind });
        return null;
      }
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
    if (copying) return;
    setCopying(true);
    const url = link.url ?? await share();
    if (!url) { setCopying(false); return; }
    let result: CopyResult;
    try { result = await onCopy(url); } catch { result = { ok: false, reason: 'unavailable' }; }
    setCopied(result.ok ? 'copied' : 'failed');
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    if (result.ok) copiedTimer.current = setTimeout(() => setCopied('idle'), 2200);
    setCopying(false);
  }

  const actionLabel = channelLinks ? 'Copy my channel link' : 'Copy channel invite link';
  return <section className="channel-share" aria-label="Share channel">
    <button type="button" className="aiur-shell__icon-button" aria-label={actionLabel} title={actionLabel} onClick={() => void copy()} disabled={link.status === 'busy' || copying}>
      <svg aria-hidden="true" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>
    </button>
    {link.error ? <p className="channel-share__feedback" role="alert">Could not prepare a link. Try again.</p> : null}
    {copied === 'copied' ? <p className="channel-share__feedback" role="status">Copied</p> : null}
    {copied === 'failed' && link.url ? <div className="channel-share__feedback channel-share__fallback">
      <p id={`${fallbackId}-hint`} role="alert">Copy failed. Select and copy the link below.</p>
      <label htmlFor={fallbackId}>Channel link</label>
      <input ref={fallbackInput} id={fallbackId} aria-describedby={`${fallbackId}-hint`} readOnly value={link.url} onFocus={event => event.currentTarget.select()} />
    </div> : null}
  </section>;
}
