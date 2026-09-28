import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';

const tokens = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');
const fonts = readFileSync(new URL('./fonts.css', import.meta.url), 'utf8');

describe('brand tokens', () => {
  test('consumes Aiur palette and fonts through package imports', () => {
    expect(tokens).toContain("@import '@aiur/components/theme.css'");
    expect(tokens).toContain("@import '@aiur/components/fonts.css'");
    expect(fonts).toContain("@import '@aiur/components/fonts.css'");
    expect(tokens).toContain('--khala-ink: var(--aiur-fg)');
    expect(tokens).toContain('--khala-accent: var(--aiur-accent)');
    expect(tokens).toContain('--khala-font-body: var(--aiur-font-body)');
  });

  test('Khala layout tokens remain scoped to the shell and content roots', () => {
    expect(tokens).not.toContain(':root {');
    expect(tokens).not.toMatch(/^\s*body\s*{/m);
    expect(tokens.indexOf('.aiur-shell')).toBeLessThan(tokens.indexOf('--khala-ink:'));
    expect(tokens).toContain('--khala-nav-width: 15rem');
    expect(tokens).toContain('--khala-nav-width-collapsed: 2.6rem');
    expect(tokens).toContain('--khala-content-measure: 75rem');
    expect(tokens).toContain('--khala-breakpoint: 960px');
  });

  test('focus-visible keeps a visible themed outline', () => {
    expect(tokens).toMatch(/:focus-visible\s*{\s*outline:\s*3px solid var\(--khala-accent\)/);
  });
});
