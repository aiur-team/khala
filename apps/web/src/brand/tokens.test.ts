import { describe, expect, test } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('.', import.meta.url));
const tokens = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');
const fonts = readFileSync(new URL('./fonts.css', import.meta.url), 'utf8');

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

describe('brand tokens', () => {
  test('dark token set defines semantic ink/fill pairs', () => {
    expect(tokens).toMatch(/--khala-ink:\s*#[0-9a-f]{6}/);
    expect(tokens).toMatch(/--khala-fill:\s*#[0-9a-f]{6}/);
    expect(tokens).toMatch(/--khala-fill-raised:\s*#[0-9a-f]{6}/);
    expect(tokens).toMatch(/--khala-line:\s*#[0-9a-f]{6}/);
  });

  test('light token set overrides every dark semantic pair', () => {
    const lightBlock = tokens.slice(tokens.indexOf("[data-theme='light']"));
    for (const variable of ['--khala-ink', '--khala-fill', '--khala-fill-raised', '--khala-line', '--khala-accent']) {
      expect(lightBlock).toContain(variable);
    }
  });

  test('layout tokens match the source-derived measurements', () => {
    expect(tokens).toContain('--khala-nav-width: 15rem');
    expect(tokens).toContain('--khala-nav-width-collapsed: 2.6rem');
    expect(tokens).toContain('--khala-content-measure: 75rem');
    expect(tokens).toContain('--khala-breakpoint: 960px');
  });

  test('font declarations keep a system fallback for load failure', () => {
    expect(tokens).toMatch(/--khala-font-heading:[^;]*sans-serif/);
    expect(tokens).toMatch(/--khala-font-body:[^;]*sans-serif/);
    expect(tokens).toMatch(/--khala-font-mono:[^;]*monospace/);
  });
});

describe('vendored fonts', () => {
  const cases = [
    { family: 'Khala Bungee', file: 'Bungee-Regular.woff2', sha256: '4513a7d68c82c053f363075a8aee249d60146f7c0bb7236cd27d721bffd16eeb' },
    { family: 'Khala Space Grotesk', file: 'SpaceGrotesk-Variable.woff2', sha256: 'cb48953e20ccd61690a20f1d910d333aa3a352e62ac18d3ffc4e0264a3c4aaa4' },
    { family: 'Khala JetBrains Mono', file: 'JetBrainsMono-Variable.woff2', sha256: '11038e282dd7cb983dfc4e565017f37a91041c073c8929771fb6e64d27814396' },
  ];

  for (const { family, file, sha256: expected } of cases) {
    test(`${file} matches the recorded SOURCES.md digest`, () => {
      const path = `${dir}fonts/${file}`;
      expect(existsSync(path)).toBe(true);
      expect(sha256(path)).toBe(expected);
    });

    test(`fonts.css declares @font-face for ${family}`, () => {
      expect(fonts).toContain(`font-family: '${family}'`);
    });
  }

  test('every vendored font ships its unmodified OFL notice', () => {
    for (const notice of ['Bungee-OFL.txt', 'SpaceGrotesk-OFL.txt', 'JetBrainsMono-OFL.txt']) {
      const text = readFileSync(`${dir}fonts/${notice}`, 'utf8');
      expect(text).toContain('SIL OPEN FONT LICENSE');
    }
  });
});
