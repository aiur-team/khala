// The Add agent popover (RECREATION-SPEC §12.3, live in M1): copies the
// channel link the agent passes to `khala_join` (contracts C7).

import { CopyIcon } from './icons';
import { copyWithToast, LinkStatus, type CopyableLink } from './InvitePopover';
import { useToast } from './Toast';

export function AddAgentPopover({ link }: Readonly<{ link: CopyableLink }>) {
  const toast = useToast();
  return <>
    <div className="kh-pop-h">Add agent</div>
    <button type="button" className="kh-btn pri kh-btn-ic" disabled={link.status === 'busy' || link.copying}
      onClick={() => void copyWithToast(link, toast)}><CopyIcon />Copy link</button>
    <span className="kh-hint">paste into your agent</span>
    <LinkStatus link={link} />
  </>;
}
