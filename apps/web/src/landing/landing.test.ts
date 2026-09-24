import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { AGENT_PROMPT, copyText } from './copy-prompt';
import { THEME_STORAGE_KEY, effectiveTheme, readStoredTheme, storeTheme } from './theme';
import { bannerWasDismissed } from './banner';

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('./landing.css', import.meta.url), 'utf8');
const themeInit = readFileSync(new URL('./public/theme-init.js', import.meta.url), 'utf8');
const bannerInit = readFileSync(new URL('./public/banner-init.js', import.meta.url), 'utf8');

const EXACT_PROMPT = "I'd like to connect you with another agent. Open a channel: https://khala.aiur.team";
const FEATURE_TITLES = [
  'Multiplayer',
  'End-to-end encrypted',
  'Listening modes',
  'Internal chat',
  'Weigh in',
  'Aiur-native',
];
const LISTENING_MODES_COPY = '<code>steer</code> interrupts on every new message. <code>sync</code> (the default) takes new messages after the current turn or tool. <code>async</code> lets the agent check when it chooses.';

function luminance(hex: string): number {
  const channels = [1, 3, 5].map(index => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
  const [r, g, b] = channels.map(value => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

function token(name: string): string {
  const match = css.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i'));
  if (!match?.[1]) throw new Error(`missing token --${name}`);
  return match[1];
}

describe('splash page prompt', () => {
  test('the hero prompt reads exactly as specified, in the page and in code', () => {
    expect(AGENT_PROMPT).toBe(EXACT_PROMPT);
    const line = html.match(/<span class="cmd" id="agentPrompt">([^<]*)<\/span>/);
    expect(line?.[1]).toBe(EXACT_PROMPT);
  });

  test('copyText writes the exact text and reports the outcome honestly', async () => {
    const written: string[] = [];
    expect(await copyText(AGENT_PROMPT, async text => void written.push(text))).toBe('copied');
    expect(written).toEqual([EXACT_PROMPT]);
    expect(await copyText(AGENT_PROMPT, async () => Promise.reject(new Error('denied')))).toBe('denied');
    expect(await copyText(AGENT_PROMPT, null)).toBe('unavailable');
  });
});

describe('splash page constraints', () => {
  test('presents the six concise feature cards in order', () => {
    const featureSection = html.match(/<section[^>]+id="features"[\s\S]*?<\/section>/)?.[0] ?? '';
    const titles = [...featureSection.matchAll(/<h3>([^<]+)<\/h3>/g)].map(([, title]) => title);
    expect(titles).toEqual(FEATURE_TITLES);
    expect(featureSection.match(/class="feature-card/g)).toHaveLength(6);
    expect(featureSection.match(/class="coming-soon"/g)).toHaveLength(2);
    expect(featureSection).toContain(LISTENING_MODES_COPY);
  });

  test('uses the required subtext and highlights open', () => {
    expect(html).toMatch(/Hailing frequencies\s+<span class="open">open<\/span>\./);
    expect(html).toContain('Encrypted chat for both humans and their agents.');
    expect(css).toMatch(/\.features-intro \.open\s*\{[^}]*color:\s*var\(--accent\)/);
    expect(contrast('#1f57c4', '#e7d6b2')).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#2f86ff', '#1a1b1e')).toBeGreaterThanOrEqual(4.5);
  });

  test('removes the legacy sections', () => {
    expect(html).not.toContain('Built around');
    expect(html).not.toContain('Plain limits');
    expect(html).not.toContain('How it works');
  });

  test('declares only local Aiur favicon assets', () => {
    expect(html).toContain('<link rel="icon" href="/landing/favicon.ico" sizes="any" />');
    expect(html).toContain('<link rel="icon" type="image/png" sizes="32x32" href="/landing/favicon-32x32.png" />');
    expect(html).toContain('<link rel="icon" type="image/png" sizes="16x16" href="/landing/favicon-16x16.png" />');
    expect(html).toContain('<link rel="apple-touch-icon" sizes="180x180" href="/landing/apple-touch-icon.png" />');
  });

  test('uses inline decorative SVGs and the Archon footer text', () => {
    const featureSection = html.match(/<section[^>]+id="features"[\s\S]*?<\/section>/)?.[0] ?? '';
    expect(featureSection.match(/<svg\b/g)).toHaveLength(6);
    expect(featureSection.match(/aria-hidden="true"/g)).toHaveLength(6);
    expect(html).toMatch(/<footer[^>]*>[\s\S]*built with <a href="https:\/\/aiur\.team">Aiur<\/a>[\s\S]*<\/footer>/);
  });

  test('advertises both agent-readable guides from the document head', () => {
    expect(html).toMatch(/<link rel="alternate" type="text\/plain" href="\/llms\.txt"/);
    expect(html).toMatch(/<link rel="alternate" type="text\/markdown" href="\/AGENTS\.md"/);
  });

  test('loads no script or stylesheet from another origin', () => {
    for (const [, src] of html.matchAll(/<script[^>]*\bsrc="([^"]+)"/g)) expect(src).toMatch(/^\.?\//);
    expect(html).not.toMatch(/<link[^>]+rel="stylesheet"[^>]+href="https?:/);
    expect(css).not.toMatch(/@import\s+url\(\s*['"]?https?:/);
  });

  test('every button and button-styled link carries the shared button class', () => {
    for (const [tag] of html.matchAll(/<button\b[^>]*>/g)) expect(tag).toMatch(/class="button\b/);
    for (const [tag] of html.matchAll(/<a\b[^>]*class="[^"]*\b(?:cta|docs)\b[^"]*"[^>]*>/g)) expect(tag).toMatch(/class="button\b/);
  });

  test('buttons are white on archon blue with at least AA text contrast', () => {
    expect(token('button-bg')).toBe('#1f57c4');
    expect(token('button-fg')).toBe('#ffffff');
    expect(contrast(token('button-fg'), token('button-bg'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token('button-fg'), token('button-bg-hover'))).toBeGreaterThanOrEqual(4.5);
  });

  test('buttons have a focus-visible style', () => {
    expect(css).toMatch(/\.button:focus-visible\s*\{[^}]*outline:\s*2px solid/);
  });
});

describe('splash page theme', () => {
  test('an explicit choice wins over the system preference', () => {
    expect(effectiveTheme(null, true)).toBe('dark');
    expect(effectiveTheme(null, false)).toBe('light');
    expect(effectiveTheme('light', true)).toBe('light');
    expect(effectiveTheme('dark', false)).toBe('dark');
    expect(effectiveTheme('sepia', false)).toBe('light');
  });

  test('blocked or throwing storage never breaks the page', () => {
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readStoredTheme(throwing)).toBeNull();
    expect(() => storeTheme(throwing, 'dark')).not.toThrow();
    expect(readStoredTheme(null)).toBeNull();
  });

  test('stores and reads back only known values', () => {
    const map = new Map<string, string>();
    const storage = { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => void map.set(key, value) };
    storeTheme(storage, 'dark');
    expect(readStoredTheme(storage)).toBe('dark');
    map.set(THEME_STORAGE_KEY, 'neon');
    expect(readStoredTheme(storage)).toBeNull();
  });

  test('the pre-paint script uses the same storage key as the toggle', () => {
    expect(themeInit).toContain(`'${THEME_STORAGE_KEY}'`);
    expect(html).toMatch(/<head>[\s\S]*<script src="\/landing\/theme-init\.js"><\/script>[\s\S]*<\/head>/);
  });
});

describe('Aiur announcement banner', () => {
  test('resolves persisted dismissal before first paint', () => {
    expect(bannerInit).toContain(`'khala.aiur-banner.dismissed'`);
    expect(html).toMatch(/<head>[\s\S]*<script src="\/landing\/banner-init\.js"><\/script>[\s\S]*<\/head>/);
    expect(html).toMatch(/<aside class="banner" id="aiurBanner" aria-label="Project announcement">/);
  });

  test('recognises only the persisted dismissal value', () => {
    expect(bannerWasDismissed({ getItem: () => '1', setItem: () => undefined })).toBe(true);
    expect(bannerWasDismissed({ getItem: () => '0', setItem: () => undefined })).toBe(false);
    expect(bannerWasDismissed(null)).toBe(false);
  });

  test('blocked storage leaves the banner available', () => {
    const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
    expect(bannerWasDismissed(blocked)).toBe(false);
  });
});
