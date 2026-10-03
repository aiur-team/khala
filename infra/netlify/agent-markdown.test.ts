import assert from 'node:assert/strict';
import test from 'node:test';
import {
  agentMarkdownBody,
  isAgentMarkdownPath,
  prefersMarkdown,
} from './edge-functions/agent-markdown/negotiate.ts';

const FIREFOX = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const CHROME =
  'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7';

test('agents get markdown: missing, wildcard-only, markdown, plain text and non-HTML Accept headers', () => {
  for (const accept of [null, undefined, '', '*/*', 'text/markdown', 'text/plain', 'text/markdown, */*;q=0.1', 'application/json']) {
    assert.equal(prefersMarkdown(accept), true, `expected markdown for ${JSON.stringify(accept)}`);
  }
});

test('markdown or plain text ranked above text/html wins', () => {
  assert.equal(prefersMarkdown('text/markdown, text/html;q=0.5'), true);
  assert.equal(prefersMarkdown('text/html;q=0.4, text/plain;q=0.9'), true);
  assert.equal(prefersMarkdown('TEXT/MARKDOWN;Q=1, text/html;q=0.2'), true);
});

test('text/html refused with q=0 counts as no text/html', () => {
  assert.equal(prefersMarkdown('text/html;q=0, */*'), true);
});

test('browsers, and any Accept ranking text/html at least as high, get the SPA', () => {
  for (const accept of [FIREFOX, CHROME, 'text/html,application/xhtml+xml,*/*;q=0.8', 'text/html', 'text/html, text/markdown', 'text/markdown;q=0.5, text/html;q=0.5']) {
    assert.equal(prefersMarkdown(accept), false, `expected HTML for ${accept}`);
  }
});

test('only the site root and /join/<token> are served markdown', () => {
  for (const path of ['/', '/join/inv_EXAMPLE', '/join/inv_EXAMPLE/']) assert.equal(isAgentMarkdownPath(path), true, path);
  for (const path of ['/api/agent/join', '/assets/index.js', '/join', '/join/', '/join/a/b', '/channels/x', '/AGENTS.md']) {
    assert.equal(isAgentMarkdownPath(path), false, path);
  }
});

test('a /join/ link is prefixed with a header naming the exact requested URL', () => {
  const url = 'https://khala.aiur.team/join/inv_EXAMPLE?x=1';
  const body = agentMarkdownBody(url, '# Khala agent instructions\n');
  const [firstLine] = body.split('\n');
  assert.equal(
    firstLine,
    "You were given this Khala channel link: `https://khala.aiur.team/join/inv_EXAMPLE?x=1`. Follow 'Given a khala.aiur.team/join/… link' below, then call khala_join with that exact link.",
  );
  assert.ok(body.endsWith('# Khala agent instructions\n'));
});

test('the site root gets AGENTS.md unchanged', () => {
  assert.equal(agentMarkdownBody('https://khala.aiur.team/', '# Khala agent instructions\n'), '# Khala agent instructions\n');
});
