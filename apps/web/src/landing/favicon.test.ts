import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

// The channel pages show the splash page's favicon: the same files, bundled by Vite.
const ICONS = ['favicon.ico', 'favicon-32x32.png', 'favicon-16x16.png', 'apple-touch-icon.png'];
const SHELLS = [['hosted app shell', '../../index.html'], ['local app shell', '../../local.html']] as const;

describe('channel page favicon', () => {
  for (const [name, path] of SHELLS) {
    test(`the ${name} links every splash favicon`, () => {
      const html = readFileSync(new URL(path, import.meta.url), 'utf8');
      for (const icon of ICONS) {
        expect(html).toContain(`href="/src/landing/public/${icon}"`);
        expect(existsSync(new URL(`./public/${icon}`, import.meta.url))).toBe(true);
      }
    });
  }
});
