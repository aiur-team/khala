import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import claudeSymbol from '../khala/assets/claude-symbol.svg';
import { ConversationList, type ConversationSummary } from './ConversationList';

// The spec's worked example: 17:11Z is 10:11 in Los Angeles.
const timeOptions = { timeZone: 'America/Los_Angeles' };

const release: ConversationSummary = {
  id: '!r1:khala.local', title: 'Release 0.9 go / no-go', preview: 'Pushing both fixes now.', timestamp: '2026-10-02T17:11:00Z', unreadCount: 3,
  members: [
    { id: '@maya:khala.local', kind: 'human', displayName: 'Maya Chen' },
    { id: '@agent-1a2b3c4d-x9y8z7:khala.local', kind: 'agent', displayName: 'Sonnet · Kai', ownerId: 'kai' },
  ],
  lastSender: { label: 'Sonnet', isViewer: false },
};
// An older summary shape: no members or sender.
const bare: ConversationSummary = { id: release.id, title: release.title, preview: release.preview, timestamp: release.timestamp, unreadCount: release.unreadCount };

function render(conversations: readonly ConversationSummary[], props: Partial<Parameters<typeof ConversationList>[0]> = {}) {
  return renderToStaticMarkup(<ConversationList conversations={conversations} query="" onQueryChange={vi.fn()} onSelect={vi.fn()}
    status="ready" timeOptions={timeOptions} {...props} />);
}

const avatars = (html: string) => html.match(/<span class="kh-cv-av" aria-hidden="true">(.*?)<\/span><span class="kh-cv-t">/u)?.[1] ?? '';

describe('ConversationList', () => {
  it('renders the worked example row', () => {
    const html = render([release]);
    expect(html).toContain('<button type="button" class="kh-cv unread" data-kh-convo="!r1:khala.local" aria-label="Release 0.9 go / no-go, Sonnet: Pushing both fixes now., 10:11, 3 unread">');
    expect(html).toContain('<b dir="auto">Release 0.9 go / no-go</b><time dateTime="2026-10-02T17:11:00Z">10:11</time>');
    expect(html).toContain('<span class="kh-cv-pv" dir="auto">Sonnet: Pushing both fixes now.</span>');
  });

  it('shows the first two members as static avatars, the agent with its label initials', () => {
    const cell = avatars(render([release]));
    expect(cell.match(/class="kh-av[^"]*"/gu)).toEqual(['class="kh-av kh-hav"', 'class="kh-av"']);
    expect(cell).not.toContain('<button');
    expect(cell).toMatch(/<span class="kh-av kh-hav" style="--oh:\d+" aria-hidden="true">MC<\/span>/u);
    expect(cell).toMatch(/<span class="kh-av" style="--h:\d+" aria-hidden="true"><span class="kh-ini">SO<\/span><span class="kh-own" style="--oh:\d+">KA<\/span><\/span>/u);
  });

  it('caps the avatars at two members', () => {
    const third = { id: '@lee:khala.local', kind: 'human', displayName: 'Lee' } as const;
    expect(avatars(render([{ ...release, members: [...release.members!, third] }])).match(/class="kh-av/gu)).toHaveLength(2);
  });

  it('renders the generic # avatar with no other members', () => {
    expect(avatars(render([{ ...release, members: [] }]))).toBe('<span class="kh-av kh-gen" aria-hidden="true">#</span>');
    expect(avatars(render([bare]))).toContain('kh-gen');
  });

  it('renders one member as a single avatar', () => {
    expect(avatars(render([{ ...release, members: release.members!.slice(0, 1) }])).match(/class="kh-av/gu)).toHaveLength(1);
  });

  it('prefixes the viewer’s own message with You', () => {
    expect(render([{ ...release, lastSender: { label: 'Kevin', isViewer: true } }])).toContain('<span class="kh-cv-pv" dir="auto">You: Pushing both fixes now.</span>');
  });

  it('keeps the no-message and unreadable fallbacks without a sender prefix', () => {
    const html = render([
      { ...bare, id: 'a', preview: null, timestamp: null },
      { ...release, id: 'b', preview: null },
    ]);
    expect(html).toContain('<span class="kh-cv-pv" dir="auto">No messages yet</span>');
    expect(html).toContain('<span class="kh-cv-pv" dir="auto">Message unavailable on this device</span>');
  });

  it('badges the viewer’s own agents YO on the viewer hue', () => {
    const html = avatars(render([release], { viewerOwnerId: 'kai' }));
    expect(html).toContain('<span class="kh-own" style="--oh:214">YO</span>');
  });

  it('shows the last message as h:mm, on any day (§4.1)', () => {
    expect(render([release])).toContain('>10:11</time>');
    expect(render([{ ...release, timestamp: '2026-09-28T15:31:00Z' }])).toContain('>8:31</time>');
  });

  it('shows an agent with a known harness by its logo, owner badge from the owner full name', () => {
    const html = avatars(render([{ ...release, members: [
      { id: '@kai:khala.local', kind: 'human', displayName: 'Kai Watanabe' },
      { ...release.members![1]!, harness: 'claude' },
    ] }]));
    expect(html).toContain(`<img src="${claudeSymbol.replaceAll("'", '&#x27;')}" alt=""/><span class="kh-own" style="--oh:330">KW</span>`);
  });

  it('marks unread rows and sums the head count, always shown', () => {
    const html = render([release, { ...release, id: 'quiet', unreadCount: null }]);
    expect(html).toContain('<div class="kh-list-head"><b>Channels</b><span>3 unread</span></div>');
    expect(html).toMatch(/aria-label="[^"]*, 3 unread"/u);
    expect(html).toContain('class="kh-cv" data-kh-convo="quiet"');
    expect(render([{ ...release, unreadCount: null }])).toContain('<span>0 unread</span>');
  });

  it('marks the selected row active', () => {
    expect(render([release], { selectedId: release.id })).toContain('class="kh-cv is-active unread"');
  });

  it('puts the action after the count in the head', () => {
    expect(render([release], { action: <button type="button" className="kh-ib sm" aria-label="New channel" /> }))
      .toContain('<span>3 unread</span><button type="button" class="kh-ib sm" aria-label="New channel"></button></div>');
  });

  it('searches the preview text as well as the title', () => {
    const other = { ...release, id: 'other', title: 'Design', preview: 'Looks good.' };
    const html = render([release, other], { query: 'FIXES' });
    expect(html).toContain('data-kh-convo="!r1:khala.local"');
    expect(html).not.toContain('data-kh-convo="other"');
  });

  it('renders each list state', () => {
    const loading = render([], { status: 'loading' });
    expect(loading.match(/class="kh-cv kh-cv-skel"/gu)).toHaveLength(3);
    expect(render([], { status: 'error' })).toContain('<div class="kh-cv-empty" role="alert">Channels are unavailable. Try reloading.</div>');
    expect(render([])).toContain('<div class="kh-cv-empty" role="status">No channels yet.</div>');
    expect(render([release], { query: 'nothing here' })).toContain('<div class="kh-cv-empty" role="status">No channels match.</div>');
  });
});
