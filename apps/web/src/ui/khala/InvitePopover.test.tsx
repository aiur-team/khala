import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { APPROVE_JOINS_HINT, copyWithToast, InvitePopover, TOUCH_HINT, type ApproveJoins, type CopyableLink } from './InvitePopover';
import { ToastProvider } from './Toast';

const link = (overrides: Partial<CopyableLink> = {}): CopyableLink => ({
  url: 'https://khala.aiur.team/c/release', status: 'ready', error: null, copying: false, copied: 'idle',
  copy: async () => ({ ok: true }), ...overrides,
});
const render = (value: CopyableLink, approval?: ApproveJoins) => renderToStaticMarkup(<ToastProvider><InvitePopover link={value} approval={approval} /></ToastProvider>);

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

  it('locks Type and History with Coming soon', () => {
    const html = render(link());
    expect(html).toContain('<span class="kh-seg lock" role="radiogroup" aria-label="Type">');
    expect(html).toContain('<span class="kh-seg lock" role="radiogroup" aria-label="History">');
    expect(html).toMatch(/aria-checked="true" class="on" data-v="open" title="Coming soon" disabled=""/);
    expect(html).toMatch(/aria-checked="true" class="on" data-v="join" title="Coming soon" disabled=""/);
    expect(html).toContain('class="kh-lk" data-tip="Humans see messages from when they join">History<svg');
    // Every locked segment says it is coming; Approve joins never does.
    const disabled = (html.match(/<button[^>]*disabled=""[^>]*>/g) ?? []).filter(button => !button.includes('role="switch"'));
    expect(disabled).toHaveLength(4);
    for (const button of disabled) expect(button).toContain('title="Coming soon"');
    expect(html).not.toMatch(/role="switch"[^>]*Coming soon/);
  });

  it('spells out the locked controls on touch screens, where title tooltips never show', () => {
    expect(render(link())).toContain(`<span class="kh-hint kh-touch-hint">${TOUCH_HINT}</span>`);
    const css = readFileSync(new URL('./controls.css', import.meta.url), 'utf8');
    expect(css).toContain('.kh-touch-hint { display: none; } @media (hover: none) { .kh-touch-hint { display: block; } }');
  });

  it('shows the stored Approve joins state, changeable only by the owner', () => {
    const set = vi.fn();
    const owner = render(link(), { on: true, owner: true, set });
    expect(owner).toContain(`class="kh-sw" role="switch" aria-checked="true" aria-label="Approve joins" title="${APPROVE_JOINS_HINT}"`);
    expect(render(link(), { on: false, owner: true, set })).toContain('role="switch" aria-checked="false" aria-label="Approve joins" title=');
    // A member sees the real value but cannot change it.
    expect(render(link(), { on: true, owner: false, set }))
      .toContain('role="switch" aria-checked="true" aria-label="Approve joins" disabled="" title="Only the channel owner can change this"');
    // While loading, and without the setting at all, it is off and inert.
    expect(render(link(), { on: null, owner: true, set })).toContain('role="switch" aria-checked="false" aria-label="Approve joins" disabled=""');
    expect(render(link())).toContain('role="switch" aria-checked="false" aria-label="Approve joins" disabled=""');
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
