import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('./shell.css', import.meta.url), 'utf8');

describe('shell.css', () => {
  test('carries no topbar, navigation rail or drawer chrome', () => {
    expect(css).not.toMatch(/aiur-shell__(topbar|nav|brand|content|title)/u);
    expect(css).not.toMatch(/khala-(sidebar|mobile-bar|channel-drawer|owner-shell|content-actions)/u);
    expect(css).not.toContain('khala-channel-toolbar');
  });

  test('never puts page titles in the logo font', () => {
    expect(css).not.toContain('--khala-font-heading');
    expect(css).not.toMatch(/Bungee/u);
  });
});
