import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AgentJoinView } from '@khala/contracts/m1/agent-join';
import { AgentConfirm } from './AgentConfirm';
import type { AgentConfirmController, AgentConfirmSnapshot, AgentConfirmError } from './controller';

const view: AgentJoinView = { joinId: 'j1', label: 'Helper', harness: 'claude', channelName: 'Launch', roomId: '!r1:khala.local', state: 'pending' };
function render(snapshot: AgentConfirmSnapshot) {
  const controller: AgentConfirmController = { getSnapshot: () => snapshot, subscribe: () => () => undefined,
    start: vi.fn(), confirm: vi.fn(), cancelAuto: vi.fn(), retry: vi.fn(), dispose: vi.fn() };
  return renderToStaticMarkup(<AgentConfirm controller={controller} roomHref={id => `/channels/${encodeURIComponent(id)}`} onOpenRoom={vi.fn()} />);
}
const all = [{ state: 'loading' }, { state: 'review', view }, { state: 'review', view: { ...view, access: 'auto' } },
  { state: 'review', view: { ...view, access: 'join' } }, { state: 'connecting', view }, { state: 'done', view },
  { state: 'error', code: 'not_finished', view }] satisfies AgentConfirmSnapshot[];
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
const statuses = (html: string) => [...html.matchAll(/role="(?:status|alert)">(?:<svg.*?<\/svg>)?([^<]*)</g)].map(m => m[1]!);

describe('AgentConfirm', () => {
  it('shows only who joins where and one Approve icon button for review', () => {
    const html = render({ state: 'review', view });
    expect(html).toContain('<h1 class="kh-fin-n">Helper <span aria-hidden="true">→</span><span class="kh-fin-sr">joins</span> Launch</h1>');
    expect(html).toMatch(/<button type="button" class="kh-btn pri" aria-label="Approve" title="Approve"><svg /);
    expect(text(html)).toBe('khala Helper → joins Launch'); // the wordmark, then the agent line
  });
  it('drops the eyebrow, harness chip, prose and account line in every state', () => {
    for (const snapshot of all) {
      const html = render(snapshot);
      expect(html).not.toMatch(/kh-fin-eb|kh-mchip|Claude Code|Signed in as|wants to join|Approve joins|Keep this tab open/);
      expect(html.match(/class="kh-spin"/g)?.length ?? 0).toBeLessThanOrEqual(1);
      expect(html.match(/class="kh-fin-c"/g)).toHaveLength(1);
      for (const status of statuses(html)) expect(status.trim().split(/\s+/).length).toBeLessThanOrEqual(3);
      expect(html.match(/class="wm"/g)).toHaveLength(1);
    }
  });
  it.each<[AgentConfirmSnapshot, string]>([
    [{ state: 'loading' }, 'Loading'],
    [{ state: 'review', view: { ...view, access: 'auto' } }, 'Joining'],
    [{ state: 'connecting', view }, 'Connecting'],
    [{ state: 'connecting', view, slow: true }, 'Connecting'],
  ])('shows one spinner with a short status (%#)', (snapshot, status) => {
    expect(render(snapshot)).toContain(`<span class="kh-spin" aria-hidden="true"></span><p class="kh-fin-p" role="status">${status}</p>`);
  });
  it('keeps the auto-confirm Cancel as an icon button and no Approve', () => {
    const html = render({ state: 'review', view: { ...view, access: 'auto' } });
    expect(html).toMatch(/<button type="button" class="kh-btn" aria-label="Cancel" title="Cancel"><svg /);
    expect(html).not.toContain('aria-label="Approve"');
    expect(html).toContain('Helper');
  });
  it('offers a non-member one join-and-approve icon button', () => {
    const html = render({ state: 'review', view: { ...view, access: 'join' } });
    expect(html).toContain('aria-label="Join and approve"');
    expect(html).not.toContain('aria-label="Approve"');
  });
  it('links to the encoded channel after success', () => {
    const html = render({ state: 'done', view });
    expect(html).toMatch(/<span class="kh-fin-ok" role="status"><svg [^>]*>.*?<\/svg>Joined<\/span>/);
    expect(html).toMatch(/<a class="kh-btn pri" aria-label="Open channel" title="Open channel" href="\/channels\/!r1%3Akhala.local"><svg /);
  });
  it.each<[AgentConfirmError, string]>([
    ['not_member', 'Not a member'], ['wrong_account', 'Wrong account'], ['invite_unavailable', 'Invite expired'],
    ['not_found', 'Invalid link'], ['expired', 'Request expired'], ['already_confirmed_by_other', 'Already confirmed'],
    ['not_picked_up', 'Agent not responding'], ['not_finished', 'Join incomplete'], ['unavailable', 'Khala unavailable'],
    ['signed_out', 'Signed out'],
  ])('renders %s briefly with the right action', (code, copy) => {
    const html = render({ state: 'error', code });
    expect(html).toContain(`<p class="kh-fin-p kh-fin-err" role="alert">${copy}</p>`);
    expect(html.includes('aria-label="Retry"')).toBe(code === 'unavailable');
    expect(html.includes('aria-label="Sign in"')).toBe(code === 'signed_out');
    expect(html).not.toContain('<h1');
  });
  it('escapes agent-controlled labels', () => {
    expect(render({ state: 'review', view: { ...view, label: '<script>bad</script>' } })).toContain('&lt;script&gt;');
  });
});
