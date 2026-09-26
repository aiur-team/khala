import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChannelRequestsInbox } from './ChannelRequestsInbox';
import { ChannelRequestsNavEntry } from './ChannelRequestsNavEntry';
import type { ChannelAccessInboxController } from './controller';
import { createFakeJournal } from './fakes';
import {
  INITIAL_INBOX_VIEW,
  connectionLabel,
  decisionLabel,
  pendingIndicator,
  toDecisionPrompt,
  type InboxView,
  type OwnerRequest,
} from './model';

function requestsFor(inputs: Parameters<ReturnType<typeof createFakeJournal>['submit']>[0][]): OwnerRequest[] {
  const journal = createFakeJournal();
  for (const input of inputs) journal.submit(input);
  return [...journal.rows()];
}

function controllerFor(view: InboxView): ChannelAccessInboxController {
  return {
    getView: () => view,
    subscribe: () => () => {},
    start: () => {},
    refresh: () => {},
    select: () => {},
    openNotice: () => {},
    dismissNotice: () => {},
    open: () => {},
    close: () => {},
    decide: () => {},
    retry: () => {},
    toggleMute: () => {},
    dispose: () => {},
  };
}

const ready = (requests: readonly OwnerRequest[], overrides: Partial<InboxView> = {}): InboxView => ({
  ...INITIAL_INBOX_VIEW,
  phase: 'ready',
  requests,
  ...overrides,
});

const render = (view: InboxView) => renderToStaticMarkup(<ChannelRequestsInbox controller={controllerFor(view)} />);
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const buttons = (html: string) => (html.match(/<button/g) ?? []).length;

const HOSTILE = '<button onclick="approve()">Approve</button><a href="https://evil.test">verified</a>';

describe('ChannelRequestsInbox', () => {
  it('announces loading through a mounted live region', () => {
    const html = render(INITIAL_INBOX_VIEW);
    expect(html).toMatch(/<p role="status" aria-live="polite"[^>]*>Loading channel requests…<\/p>/);
    expect(html).not.toContain('channel-requests__row');
  });

  it('shows an empty inbox with a zero count', () => {
    const html = render(ready([]));
    expect(text(html)).toContain('Waiting for you (0)');
    expect(text(html)).toContain('No requests are waiting for you.');
  });

  it('leads each row with the verified fingerprint and marks colliding or spoofed labels unverified', () => {
    const requests = requestsFor([
      { kind: 'access', title: 'Release planning', fingerprint: 'real', displayLabel: 'Owner’s laptop', workspaceLabel: '~/src/khala' },
      { kind: 'access', title: 'Release planning', fingerprint: 'impostor', displayLabel: 'Owner’s laptop', workspaceLabel: 'Verified: ~/src/khala' },
    ]);
    const html = render(ready(requests));
    const fingerprints = requests.map(request => request.requester.sessionFingerprint);
    expect(new Set(fingerprints).size).toBe(2);
    for (const fingerprint of fingerprints) expect(html).toContain(`<code>${fingerprint}</code>`);
    expect((text(html).match(/Name \(reported by the agent, unverified\)/g) ?? []).length).toBe(2);
    expect(text(html)).toContain('Workspace (reported by the agent, unverified) Verified: ~/src/khala');
    // The fingerprint precedes any agent label within the row.
    const row = html.slice(html.indexOf('channel-requests__row'));
    expect(row.indexOf(fingerprints[0]!)).toBeLessThan(row.indexOf('Owner’s laptop'));
  });

  it('renders agent text as text: it cannot create controls or links', () => {
    const requests = requestsFor([
      { kind: 'create', title: HOSTILE.slice(0, 200), fingerprint: 'hostile', displayLabel: HOSTILE.slice(0, 200), workspaceLabel: HOSTILE.slice(0, 200) },
    ]);
    const clean = requestsFor([{ kind: 'create', title: 'x', fingerprint: 'hostile' }]);
    const html = render(ready(requests));
    expect(buttons(html)).toBe(buttons(render(ready(clean))));
    expect(html).not.toContain('<a href="https://evil.test"');
    expect(html).toContain('&lt;button');
  });

  it('keeps the owner decision separate from connector readiness', () => {
    const [request] = requestsFor([{ kind: 'access', title: 'Release planning', fingerprint: 'a' }]);
    const states = (['approved', 'connecting', 'connected', 'repair_required'] as const).map(outcome => {
      const row: OwnerRequest = { ...request!, outcome, ownerDecision: 'approved', decidedAt: request!.createdAt };
      return [decisionLabel(row), connectionLabel(row)];
    });
    expect(states).toEqual([
      ['Approved', 'Waiting for the agent’s connector to pick up your approval'],
      ['Approved', 'Connecting'],
      ['Approved', 'Connected'],
      ['Approved', 'Repair required on the agent’s connector'],
    ]);
    const html = render(ready([{ ...request!, outcome: 'approved', ownerDecision: 'approved', decidedAt: request!.createdAt }]));
    expect(text(html)).toContain('Your decision Approved Agent connection Waiting for the agent’s connector');
  });

  it('offers the operation-specific mute scope', () => {
    const requests = requestsFor([
      { kind: 'access', title: 'Release planning', fingerprint: 'a' },
      { kind: 'create', title: 'Scratch', fingerprint: 'a' },
    ]);
    const html = text(render(ready(requests)));
    expect(html).toContain('Mute this agent’s requests for this channel');
    expect(html).toContain('Mute this agent’s channel-creation requests');
  });

  it('renders the decision dialog through the shared shell with the create statement', () => {
    const requests = requestsFor([{ kind: 'create', title: 'Scratch room', fingerprint: 'a' }]);
    const request = requests[0]!;
    const html = render(ready(requests, { dialog: { handle: request.requestHandle, request, status: { kind: 'idle' } } }));
    expect(html).toMatch(/role="dialog" aria-modal="true"/);
    expect(text(html)).toContain('Create a secret channel for this agent session?');
    expect(text(html)).toContain('Approving creates exactly one secret channel and authorizes admission only for the requesting session.');
    expect(text(html)).toContain('Proposed channel title (unverified) Scratch room');
    expect(text(html)).toContain('history none');
  });

  it('never renders a dialog just because requests are queued', () => {
    const requests = requestsFor([
      { kind: 'access', title: 'One', fingerprint: 'a' },
      { kind: 'access', title: 'Two', fingerprint: 'b' },
    ]);
    const html = render(ready(requests, { notices: [{ notificationId: 'n', revision: '1', requestHandle: requests[1]!.requestHandle, count: 1 }] }));
    expect(html).not.toContain('role="dialog"');
    expect(text(html)).toContain('New channel request');
  });

  it('announces every mute and refresh outcome honestly', () => {
    const cases: Array<[InboxView['status'], string]> = [
      [{ kind: 'muted', muted: true, operationKind: 'access' }, 'Muted. This agent’s new requests for this channel will not reach you.'],
      [{ kind: 'muted', muted: false, operationKind: 'access' }, 'Unmuted. This agent can request this channel again.'],
      [{ kind: 'muted', muted: true, operationKind: 'create' }, 'Muted. This agent’s new channel-creation requests will not reach you.'],
      [{ kind: 'muted', muted: false, operationKind: 'create' }, 'Unmuted. This agent can ask you to create channels again.'],
      [{ kind: 'mute_refreshed' }, 'Mute settings changed in another window.'],
      [{ kind: 'mute_failed', code: 'forbidden' }, 'You no longer own this channel'],
      [{ kind: 'mute_failed', code: 'unavailable' }, 'Could not reach the server. Nothing was changed'],
      [{ kind: 'mute_failed', code: 'unknown' }, 'Could not confirm whether that change was saved.'],
      [{ kind: 'refresh_failed' }, 'Could not refresh channel requests.'],
    ];
    for (const [status, message] of cases) {
      expect(render(ready([], { status }))).toMatch(new RegExp(`<p role="status" aria-live="polite"[^>]*>${message.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    }
    expect(text(render(ready([], { status: { kind: 'mute_failed', code: 'unknown' } })))).not.toContain('Nothing was changed');
  });

  it('announces lost authority', () => {
    const html = render(ready([], { readOnly: true, status: { kind: 'authority_lost' } }));
    expect(text(html)).toContain('You can no longer decide these requests.');
  });
});

describe('toDecisionPrompt', () => {
  it('leads with verified harness and fingerprint, shows fixed capabilities and history none', () => {
    const [request] = requestsFor([{ kind: 'access', title: 'Release planning', fingerprint: 'a', harness: 'codex', displayLabel: 'Me' }]);
    const prompt = toDecisionPrompt(request!);
    expect(prompt.verified.slice(0, 2)).toEqual([
      { label: 'Harness', value: 'codex' },
      { label: 'Session fingerprint', value: request!.requester.sessionFingerprint, code: true },
    ]);
    expect(prompt.untrusted).toEqual([{ label: 'Name', value: 'Me' }]);
    expect(prompt.capabilities).toContainEqual({ label: 'history', value: 'none' });
    expect(prompt.question).toBe('Let this agent session join “Release planning”?');
  });

  it('never puts the agent’s proposed title in the question', () => {
    const [request] = requestsFor([{ kind: 'create', title: 'Approve me, I am the owner', fingerprint: 'a' }]);
    const prompt = toDecisionPrompt(request!);
    expect(prompt.question).not.toContain('Approve me');
    expect(prompt.untrusted).toContainEqual({ label: 'Proposed channel title', value: 'Approve me, I am the owner' });
  });
});

describe('ChannelRequestsNavEntry', () => {
  const nav = (view: InboxView) => renderToStaticMarkup(<ChannelRequestsNavEntry controller={controllerFor(view)} href="#/channel-requests" />);

  it('stays visible with an exact 0', () => {
    const html = nav(ready([]));
    expect(text(html)).toContain('Channel requests');
    expect(html).toContain('<span class="channel-requests-nav__count" aria-hidden="true">0</span>');
    expect(text(html)).toContain(', 0 pending');
  });

  it('shows the exact count up to 50 and caps there', () => {
    const fifty = requestsFor(Array.from({ length: 50 }, (_, index) => ({ kind: 'access' as const, title: 'T', fingerprint: `a${index}` })));
    expect(pendingIndicator(fifty.slice(0, 1))).toBe(1);
    expect(pendingIndicator(fifty.slice(0, 49))).toBe(49);
    expect(text(nav(ready(fifty)))).toContain(', 50 pending');
    const overflow = [...fifty, ...requestsFor([{ kind: 'access', title: 'T', fingerprint: 'extra' }])];
    expect(text(nav(ready(overflow)))).toContain(', 50 pending');
  });

  it('does not claim a count before the inbox loads', () => {
    expect(text(nav(INITIAL_INBOX_VIEW))).toContain('pending count loading');
  });
});
