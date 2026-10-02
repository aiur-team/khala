// The Invite popover (RECREATION-SPEC §12.3, M1 column): the live channel
// link with a copy button, and the M2 invite options shown locked.

import { useEffect, useId, useRef } from 'react';
import type { CopyResult } from '../share-link';
import { CopyIcon, LockIcon } from './icons';
import { Segmented } from './Segmented';
import { Switch } from './Switch';
import { useToast } from './Toast';

export const COMING_SOON = 'Coming soon';

/** The channel link a popover shows and copies (`useChannelLink`). */
export type CopyableLink = Readonly<{
  url: string | null;
  status: 'idle' | 'busy' | 'ready' | 'error';
  error: string | null;
  copying: boolean;
  copied: 'idle' | 'copied' | 'failed';
  copy(): Promise<CopyResult | null>;
}>;

/** Copies the link and toasts `Copied`; a failure leaves the fallback field to the caller. */
export async function copyWithToast(link: Pick<CopyableLink, 'copy'>, toast: (text: string) => void): Promise<void> {
  const result = await link.copy();
  if (result?.ok) toast('Copied');
}

/** After a failed copy: the link in a `.kh-txt`, focused and selected for copying by hand. */
export function CopyFallback({ url }: Readonly<{ url: string }>) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  return <>
    <span id={`${id}-hint`} className="kh-hint" role="alert">Copy failed. Select and copy the link.</span>
    <input ref={input} className="kh-txt" aria-label="Channel link" aria-describedby={`${id}-hint`} readOnly value={url}
      onFocus={event => event.currentTarget.select()} />
  </>;
}

export function LinkStatus({ link }: Readonly<{ link: CopyableLink }>) {
  if (link.error) return <span className="kh-hint" role="alert">Could not prepare a link. Try again.</span>;
  if (link.copied === 'failed' && link.url) return <CopyFallback url={link.url} />;
  return null;
}

export function InvitePopover({ link }: Readonly<{ link: CopyableLink }>) {
  const toast = useToast();
  return <>
    <div className="kh-pop-h">Invite</div>
    <div className="kh-f"><span>Type</span>
      <Segmented label="Type" locked title={COMING_SOON} value="open"
        options={[{ value: 'open', label: 'Open' }, { value: 'single', label: 'Single-use' }]} />
    </div>
    <div className="kh-f"><span>Approve joins</span>
      <Switch checked={false} label="Approve joins" disabled title={COMING_SOON} />
    </div>
    <div className="kh-f"><span className="kh-lk" data-tip="Humans see messages from when they join">History<LockIcon /></span>
      <Segmented label="History" locked title={COMING_SOON} value="join"
        options={[{ value: 'full', label: 'Full' }, { value: 'join', label: 'From join' }]} />
    </div>
    <div className="kh-link">
      <code>{link.url ?? (link.error ? 'Link unavailable' : 'Preparing link…')}</code>
      <button type="button" className="kh-ib sm" data-tip="Copy link" aria-label="Copy link"
        disabled={link.status === 'busy' || link.copying} onClick={() => void copyWithToast(link, toast)}><CopyIcon /></button>
    </div>
    <LinkStatus link={link} />
  </>;
}
