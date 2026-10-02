import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AddAgentPopover } from './AddAgentPopover';
import { copyWithToast, type CopyableLink } from './InvitePopover';
import { ToastProvider } from './Toast';
import { copyShareLink } from '../share-link';

const link: CopyableLink = { url: null, status: 'idle', error: null, copying: false, copied: 'idle', copy: async () => ({ ok: true }) };

describe('AddAgentPopover', () => {
  it('renders the design body', () => {
    const html = renderToStaticMarkup(<ToastProvider><AddAgentPopover link={link} /></ToastProvider>);
    expect(html).toContain('<div class="kh-pop-h">Add agent</div><button type="button" class="kh-btn pri kh-btn-ic">');
    expect(html).toContain('Copy link</button><span class="kh-hint">paste into your agent</span>');
  });

  it('writes the channel link to the clipboard and toasts Copied', async () => {
    const writer = vi.fn<(text: string) => Promise<void>>(async () => {});
    const url = 'https://khala.aiur.team/c/release';
    const toast = vi.fn();
    await copyWithToast({ copy: () => copyShareLink(url, writer) }, toast);
    expect(writer).toHaveBeenCalledWith(url);
    expect(toast).toHaveBeenCalledWith('Copied');
  });
});
