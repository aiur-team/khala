import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { copyWithToast, InvitePopover, type CopyableLink } from './InvitePopover';
import { ToastProvider } from './Toast';

const link = (overrides: Partial<CopyableLink> = {}): CopyableLink => ({
  url: 'https://khala.aiur.team/c/release', status: 'ready', error: null, copying: false, copied: 'idle',
  copy: async () => ({ ok: true }), ...overrides,
});
const render = (value: CopyableLink) => renderToStaticMarkup(<ToastProvider><InvitePopover link={value} /></ToastProvider>);

describe('InvitePopover', () => {
  it('shows the live link once loaded, with a copy button', () => {
    expect(render(link({ url: null, status: 'busy' }))).toContain('<code>Preparing link…</code>');
    const html = render(link());
    expect(html).toContain('<div class="kh-link"><code>https://khala.aiur.team/c/release</code>');
    expect(html).toContain('data-tip="Copy link" aria-label="Copy link"');
  });

  it('toasts Copied after a successful copy only', async () => {
    const toast = vi.fn();
    await copyWithToast(link(), toast);
    expect(toast).toHaveBeenCalledWith('Copied');
    toast.mockClear();
    await copyWithToast(link({ copy: async () => ({ ok: false, reason: 'denied' }) }), toast);
    expect(toast).not.toHaveBeenCalled();
  });

  it('locks Type, Approve joins and History with Coming soon', () => {
    const html = render(link());
    expect(html).toContain('<span class="kh-seg lock" role="radiogroup" aria-label="Type">');
    expect(html).toContain('<span class="kh-seg lock" role="radiogroup" aria-label="History">');
    expect(html).toMatch(/aria-checked="true" class="on" data-v="open" title="Coming soon" disabled=""/);
    expect(html).toMatch(/aria-checked="true" class="on" data-v="join" title="Coming soon" disabled=""/);
    expect(html).toContain('class="kh-sw" role="switch" aria-checked="false" aria-label="Approve joins" disabled="" title="Coming soon"');
    expect(html).toContain('class="kh-lk" data-tip="Humans see messages from when they join">History<svg');
    // Every disabled control says it is coming.
    const disabled = html.match(/<button[^>]*disabled=""[^>]*>/g) ?? [];
    expect(disabled).toHaveLength(5);
    for (const button of disabled) expect(button).toContain('title="Coming soon"');
  });

  it('offers the link in a selectable field after a failed copy', () => {
    const html = render(link({ copied: 'failed' }));
    expect(html).toContain('Copy failed. Select and copy the link.');
    expect(html).toContain('class="kh-txt" aria-label="Channel link"');
    expect(html).toContain('readOnly="" value="https://khala.aiur.team/c/release"');
  });

  it('reports a link that could not be prepared', () => {
    expect(render(link({ url: null, status: 'error', error: 'unavailable' }))).toContain('Could not prepare a link. Try again.');
  });
});
