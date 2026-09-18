import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('./shell.css', import.meta.url), 'utf8');

describe('shell.css layout guarantees', () => {
  test('grid columns and content region never collapse to a fixed width', () => {
    expect(css).toContain('grid-template-columns: var(--khala-nav-width) minmax(0, 1fr)');
    expect(css).toContain('.aiur-shell__nav {');
    expect(css).toMatch(/\.aiur-shell__nav\s*{[^}]*min-width:\s*0/);
    expect(css).toMatch(/\.aiur-shell__content\s*{[^}]*min-width:\s*0/);
  });

  test('the mobile breakpoint switches at 959px, matching the 960px desktop rail', () => {
    expect(css).toContain('@media (max-width: 959px)');
    expect(css).not.toContain('@media (max-width: 960px)');
  });

  test('the collapsed rail narrows to the collapsed width token', () => {
    expect(css).toContain('.aiur-shell--collapsed {');
    expect(css).toMatch(/\.aiur-shell--collapsed\s*{[^}]*grid-template-columns:\s*var\(--khala-nav-width-collapsed\)/);
  });

  test('the mobile nav keeps overflow-x for a horizontally scrollable rail', () => {
    const mobileBlock = css.slice(css.indexOf('@media (max-width: 959px)'));
    expect(mobileBlock).toMatch(/overflow-x:\s*auto/);
  });
});
