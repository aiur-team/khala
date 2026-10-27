import opencodeLogo from '../../ui/khala/assets/opencode.svg';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { AgentJoinView } from '@khala/contracts/m1/agent-join';
import { AgentConfirm } from './AgentConfirm';
import type { AgentConfirmController, AgentConfirmSnapshot, AgentConfirmError } from './controller';

const view: AgentJoinView = { joinId: 'j1', label: 'Helper', harness: 'claude', channelName: 'Launch', roomId: '!r1:khala.local', state: 'pending' };
function render(snapshot: AgentConfirmSnapshot, email?: string) {
  const controller: AgentConfirmController = { getSnapshot: () => snapshot, subscribe: () => () => undefined,
    start: vi.fn(), confirm: vi.fn(), cancelAuto: vi.fn(), retry: vi.fn(), dispose: vi.fn() };
  return renderToStaticMarkup(<AgentConfirm controller={controller} roomHref={id => `/channels/${encodeURIComponent(id)}`} onOpenRoom={vi.fn()}
    {...(email ? { email } : {})} />);
}
describe('AgentConfirm', () => {
  it.each([['opencode', 'OpenCode'], ['vscode', 'Copilot (VS Code)'], ['claude-code', 'MCP agent (claude-code)']])(
    'renders registry identity for %s', (harness, name) => {
      // Wire contracts widen in U2; this tests the web rendering boundary independently.
      const html = render({ state: 'review', view: { ...view, harness: harness as AgentJoinView['harness'] } });
      expect(html).toContain(`Helper (${name}) wants to join Launch.`);
      expect(html).toContain(`${name}</span>`);
      if (harness === 'opencode') expect(html).toContain(renderToStaticMarkup(<img src={opencodeLogo} alt="" />));
      if (harness === 'claude-code') expect(html).not.toContain('Claude Code');
    });
  it('shows the label, harness and channel for review', () => {
    const html = render({ state: 'review', view });
    expect(html).toContain('Confirm agent');
    expect(html).toContain('Helper (Claude Code) wants to join Launch.');
    expect(html).toContain('>Confirm</button>');
    expect(render({ state: 'review', view: { ...view, harness: 'codex' } })).toContain('Helper (Codex)');
  });
  it('never asks to keep the tab open: the server finishes the join', () => {
    for (const snapshot of [{ state: 'loading' }, { state: 'review', view }, { state: 'connecting', view }, { state: 'done', view },
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
    ['not_member', 'You are not in this channel yet. Open the channel&#x27;s invite link, then ask your agent to run join again.', false],
    ['wrong_account', 'This invite is for a different account. Sign in with the invited account and open this link again.', false],
    ['invite_unavailable', 'The invite link your agent used no longer works. Ask someone in the channel for a new link and give it to your agent.', false],
    ['not_found', 'This confirmation link is not valid.', false],
    ['expired', 'This request expired. Ask your agent to run join again.', false],
    ['already_confirmed_by_other', 'Another member already confirmed this agent.', false],
    ['ready_timeout', 'The agent did not finish connecting.', true],
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
      '<span class="kh-spin" aria-hidden="true"></span><p class="kh-fin-p" role="status">Connecting Helper…</p>');
  });
  it('renders done with a check line and a primary Open channel link', () => {
    const html = render({ state: 'done', view });
    expect(html).toMatch(/<span class="kh-fin-ok"><svg [^>]*>.*?<\/svg>Helper joined Launch\.<\/span>/);
    expect(html).toContain('<a class="kh-btn pri" href="/channels/!r1%3Akhala.local">Open channel</a>');
  });
  it('renders a retryable error as an alert with Retry', () => {
    expect(render({ state: 'error', code: 'ready_timeout', view })).toContain(
      '<p class="kh-fin-p kh-fin-err" role="alert">The agent did not finish connecting.</p><button type="button" class="kh-btn">Retry</button>');
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
  it('offers one join-and-add button to a non-member the invite admits, naming the account', () => {
    const html = render({ state: 'review', view: { ...view, access: 'join' } }, 'ada@example.test');
    expect(html).toContain('You are not in this channel yet. Confirming adds you and your agent.');
    expect(html).toContain('>Join Launch and add Helper</button>');
    expect(html).not.toContain('>Confirm</button>');
    expect(html).toContain('Signed in as ada@example.test');
    expect(render({ state: 'error', code: 'wrong_account' }, 'ada@example.test')).toContain('Signed in as ada@example.test');
    expect(render({ state: 'review', view })).not.toContain('Signed in as');
  });
  it('names the agent and offers Cancel while a no-click confirm is pending', () => {
    const html = render({ state: 'review', view: { ...view, access: 'auto' } }, 'ada@example.test');
    expect(html).toContain('Adding Helper to Launch now. Approve joins is off.');
    expect(html).toContain('>Cancel</button>');
    expect(html).not.toContain('>Confirm</button>');
    expect(html).toContain('Signed in as ada@example.test');
  });
  it('escapes agent-controlled labels', () => {
    expect(render({ state: 'review', view: { ...view, label: '<script>bad</script>' } })).toContain('&lt;script&gt;');
  });
});
