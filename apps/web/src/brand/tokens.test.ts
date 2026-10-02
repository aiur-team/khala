import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';

const tokens = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');
const fonts = readFileSync(new URL('./fonts.css', import.meta.url), 'utf8');
const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');

function block(selector: string): string {
  const start = tokens.indexOf(`${selector} {`);
  expect(start).toBeGreaterThan(-1);
  return tokens.slice(start, tokens.indexOf('}', start));
}

describe('brand tokens', () => {
  test('scopes the design tokens to the app roots, dark by default', () => {
    expect(tokens).not.toContain(':root {');
    expect(tokens).not.toMatch(/^\s*body\s*\{/mu);
    const dark = block('.khala-app,\n.khala-content-root');
    expect(dark).toContain('--surface-3: #292d34;');
    expect(dark).toContain('--accent: #2f86ff;');
    expect(dark).toContain('color-scheme: dark;');
    const light = block('.khala-app[data-theme="light"],\n.khala-content-root[data-theme="light"]');
    expect(light).toContain('--surface-3: #e9dcbf;');
    expect(light).toContain('--accent: #1f57c4;');
    expect(light).toContain('color-scheme: light;');
  });

  test('keeps the --khala-* aliases for non-chat screens', () => {
    for (const alias of [
      '--khala-fill: var(--bg)', '--khala-fill-raised: var(--surface)', '--khala-fill-control: var(--surface-3)',
      '--khala-ink: var(--fg)', '--khala-ink-muted: var(--muted)', '--khala-line: var(--line)',
      '--khala-accent: var(--accent)', '--khala-status-positive: var(--good)',
      '--khala-status-caution: var(--attn)', '--khala-status-critical: var(--block)',
    ]) expect(tokens).toContain(alias);
  });

  test('uses the design font stacks and has no general logo-font token', () => {
    expect(tokens).toContain('font-family: "Space Grotesk", system-ui, -apple-system, "Segoe UI", sans-serif;');
    expect(tokens).not.toContain('--khala-font-heading');
    expect(tokens).not.toContain('Bungee');
    expect(tokens).not.toContain('@aiur/components/fonts.css');
  });

  test('loads the design fonts from Google Fonts in the app page', () => {
    expect(html).toContain('<link rel="preconnect" href="https://fonts.googleapis.com" />');
    expect(html).toContain('<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />');
    expect(html).toContain('<link href="https://fonts.googleapis.com/css2?family=Bungee&family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap" rel="stylesheet" />');
    expect(html).toContain('viewport-fit=cover');
  });

  test('offers offline stand-ins for harnesses under the design family names', () => {
    for (const family of ['"Space Grotesk"', '"JetBrains Mono"', '"Bungee"']) expect(fonts).toContain(`font-family: ${family};`);
  });

  test('focus-visible keeps a visible accent outline', () => {
    expect(tokens).toMatch(/:focus-visible\s*\{\s*outline:\s*2px solid var\(--accent\)/u);
  });
});
