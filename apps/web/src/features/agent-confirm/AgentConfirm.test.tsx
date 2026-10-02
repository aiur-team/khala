import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AgentJoinView } from '@khala/contracts/m1/agent-join';
import { AgentConfirm } from './AgentConfirm';
import type { AgentConfirmController, AgentConfirmSnapshot, AgentConfirmError } from './controller';

const view: AgentJoinView = { joinId: 'j1', label: 'Helper', harness: 'claude', channelName: 'Launch', roomId: '!r1:khala.local', state: 'pending' };
function render(snapshot: AgentConfirmSnapshot) {
  const controller: AgentConfirmController = { getSnapshot: () => snapshot, subscribe: () => () => undefined,
    start: vi.fn(), confirm: vi.fn(), retry: vi.fn(), dispose: vi.fn() };
  return renderToStaticMarkup(<AgentConfirm controller={controller} roomHref={id => `/channels/${encodeURIComponent(id)}`} onOpenRoom={vi.fn()} />);
}
describe('AgentConfirm', () => {
  it('shows the label, harness and channel for review', () => {
    const html = render({ state: 'review', view });
    expect(html).toContain('Confirm agent');
    expect(html).toContain('Helper (Claude Code) wants to join Launch.');
    expect(html).toContain('>Confirm</button>');
    expect(render({ state: 'review', view: { ...view, harness: 'codex' } })).toContain('Helper (Codex)');
  });
  it('shows keep-tab-open guidance only while connecting', () => {
    expect(render({ state: 'connecting', view })).toContain('role="status">Connecting Helper… Keep this tab open.');
    for (const snapshot of [{ state: 'loading' }, { state: 'review', view }, { state: 'done', view },
      { state: 'error', code: 'ready_timeout', view }] satisfies AgentConfirmSnapshot[]) {
      expect(render(snapshot)).not.toContain('Keep this tab open');
    }
  });
  it('links to the encoded channel after success', () => {
    const html = render({ state: 'done', view });
    expect(html).toContain('Helper joined Launch.');
    expect(html).toContain('href="/channels/!r1%3Akhala.local">Open channel');
  });
  it.each<[AgentConfirmError, string, boolean]>([
    ['not_member', 'You are not a member of this channel.', false],
    ['not_found', 'This confirmation link is not valid.', false],
    ['expired', 'This request expired. Ask your agent to run khala_join again.', false],
    ['already_confirmed_by_other', 'Another member already confirmed this agent.', false],
    ['ready_timeout', 'The agent did not finish connecting.', true],
    ['invite_failed', 'Could not add the agent to the channel.', true],
    ['unavailable', 'Khala is unavailable right now. Try again.', true],
    ['signed_out', 'Khala is unavailable right now. Try again.', true],
  ])('renders %s with appropriate retry', (code, copy, retry) => {
    const html = render({ state: 'error', code });
    expect(html).toContain(`role="alert">${copy}`);
    expect(html.includes('>Retry</button>')).toBe(retry);
    expect(html).not.toMatch(/\b(room|chat)\b/i);
  });
  it('renders review as the agent-finish card', () => {
    const html = render({ state: 'review', view: { ...view, label: 'Claude' } });
    expect(html).toMatch(/<div class="khala-app kh-agent-confirm" data-theme="(dark|light)"><div class="kh-brand">/);
    expect(html).toContain('<section class="kh-fin kh-fin--page" aria-label="Confirm agent"><div class="kh-fin-c"><span class="kh-fin-eb">Khala</span>');
    expect(html).toMatch(/<span class="kh-mchip" aria-hidden="true"><img src="[^"]+" alt=""\/>Claude Code<\/span><h1 class="kh-fin-n">Claude<\/h1>/);
    expect(html).toContain('<p class="kh-fin-p" aria-hidden="true">wants to join <b>Launch</b></p>');
    expect(html).toContain('<button type="button" class="kh-btn pri">Confirm</button>');
  });
  it('renders connecting with a spinner and status', () => {
    expect(render({ state: 'connecting', view })).toContain(
      '<span class="kh-spin" aria-hidden="true"></span><p class="kh-fin-p" role="status">Connecting Helper… Keep this tab open.</p>');
  });
  it('renders done with a check line and a primary Open channel link', () => {
    const html = render({ state: 'done', view });
    expect(html).toMatch(/<span class="kh-fin-ok"><svg [^>]*>.*?<\/svg>Helper joined Launch\.<\/span>/);
    expect(html).toContain('<a class="kh-btn pri" href="/channels/!r1%3Akhala.local">Open channel</a>');
  });
  it('renders a retryable error as an alert with Retry', () => {
    expect(render({ state: 'error', code: 'invite_failed', view })).toContain(
      '<p class="kh-fin-p kh-fin-err" role="alert">Could not add the agent to the channel.</p><button type="button" class="kh-btn">Retry</button>');
  });
  it('titles a viewless error without the chip', () => {
    const html = render({ state: 'error', code: 'not_found' });
    expect(html).toContain('<h1 class="kh-fin-n">Agent confirmation</h1>');
    expect(html).not.toContain('kh-mchip');
  });
  it('has no close button and keeps Bungee to the wordmark', () => {
    for (const snapshot of [{ state: 'loading' }, { state: 'review', view }, { state: 'connecting', view }, { state: 'done', view },
      { state: 'error', code: 'ready_timeout', view }] satisfies AgentConfirmSnapshot[]) {
      const html = render(snapshot);
      expect(html).not.toContain('kh-fin-x');
      expect(html.match(/class="wm"/g)).toHaveLength(1);
      expect(html).toMatch(/<h1 class="kh-fin-n">/);
    }
  });
  it('escapes agent-controlled labels', () => {
    expect(render({ state: 'review', view: { ...view, label: '<script>bad</script>' } })).toContain('&lt;script&gt;');
  });
});
