import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { build, preview, type PreviewServer } from 'vite';
import { chromium, type Browser, type Page } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const harnessRoot = join(here, 'browser-harness');

const fontOf = (page: Page, selector: string) =>
  page.locator(selector).first().evaluate(node => getComputedStyle(node).fontFamily);
const styleOf = <K extends keyof CSSStyleDeclaration>(page: Page, selector: string, keys: readonly K[]) =>
  page.locator(selector).first().evaluate((node, names) => {
    const style = getComputedStyle(node);
    return Object.fromEntries(names.map(name => [name, String(style[name as keyof CSSStyleDeclaration])]));
  }, keys as readonly string[]);
const box = (page: Page, selector: string) =>
  page.locator(selector).first().evaluate(node => new Promise<{ width: number; height: number }>(resolve =>
    // Reduced motion still leaves a 0.01ms grid transition; measure after it lands.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const rect = node.getBoundingClientRect();
      resolve({ width: rect.width, height: rect.height });
    }))));

// The edge-to-edge Khala frame (ui/khala/KhalaApp) rendered with today's list
// and thread components and synthetic content; not a full-product test.
test('KhalaApp fills the viewport, keeps fonts per the design and swaps panes on a phone', { timeout: 90_000 }, async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'khala-shell-dist-'));
  // Chromium's process-singleton lock is a unix-domain socket, capped at
  // ~104 bytes of path; a workspace-scoped TMPDIR can exceed that, so the
  // browser profile alone uses the system tmp root (uniquely suffixed by
  // mkdtemp, so concurrent runs cannot collide).
  const chromiumProfileRoot = await mkdtemp(join('/tmp', 'khala-shell-profile-'));
  let server: PreviewServer | undefined;
  let browser: Browser | undefined;
  try {
    await build({ root: harnessRoot, build: { outDir, emptyOutDir: true }, logLevel: 'error' });
    server = await preview({ root: harnessRoot, build: { outDir }, preview: { host: '127.0.0.1', port: 0 } });
    const url = server.resolvedUrls!.local[0]!;

    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
      headless: true,
      args: ['--no-sandbox'],
      env: { ...process.env, TMPDIR: chromiumProfileRoot },
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    await page.goto(url);
    await page.locator('.kh-card').waitFor();

    // Desktop: one full-viewport card, 300px list, no legacy chrome.
    assert.deepEqual(await box(page, '.kh-card'), { width: 1440, height: 900 });
    assert.equal((await box(page, '.kh-list')).width, 300);
    assert.equal(await page.locator('.aiur-shell__topbar').count(), 0);
    assert.equal(await page.locator('nav').count(), 0);
    assert.equal(await page.getByRole('main').count(), 1, 'the thread pane is the one main landmark');
    assert.equal(await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight), true, 'the page never scrolls');

    // Fonts: the UI font everywhere, the logo font on the wordmark only.
    for (const selector of ['body', '.khala-app', '.kh-list-head b', '.kh-cv']) {
      assert.match(await fontOf(page, selector), /^"Space Grotesk"/u, `${selector} uses the UI font`);
    }
    // The scoped base rules keep the design's (0,0,1) weight, so component rules win.
    assert.match(await fontOf(page, '.kh-brand-actions .tool-btn'), /^"JetBrains Mono"/u, '.tool-btn is a mono element (§2.1)');
    assert.deepEqual(await styleOf(page, '.kh-brand .brand-live', ['fontSize', 'paddingTop', 'paddingLeft', 'minHeight']),
      { fontSize: '10.88px', paddingTop: '2.56px', paddingLeft: '8px', minHeight: '0px' }, 'the Live badge keeps its §1.4 size');
    assert.match(await fontOf(page, '.kh-brand .wm'), /^Bungee/u);
    assert.equal(await page.locator('.kh-brand .wm').innerText(), 'KHALA');
    const bungee = await page.evaluate(() => [...document.querySelectorAll('body *')]
      .filter(node => getComputedStyle(node).fontFamily.startsWith('Bungee'))
      .map(node => node.className));
    assert.deepEqual(bungee, ['wm'], 'no element other than the wordmark is set in Bungee');

    // The theme toggle lives in the brand actions and swaps the tokens.
    const toggle = page.locator('.kh-brand-actions').getByRole('button', { name: 'Toggle color theme' });
    // Reduced motion leaves a 0.01ms transition on every property; let it land.
    const surface = () => page.locator('.kh-list').evaluate(node => new Promise<string>(resolve =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve(getComputedStyle(node).backgroundColor)))));
    assert.equal(await surface(), 'rgb(30, 32, 37)');
    assert.equal(await page.locator('.toggle-icon .sun').isVisible(), true);
    await toggle.click();
    assert.equal(await page.locator('.khala-app').getAttribute('data-theme'), 'light');
    assert.equal(await surface(), 'rgb(244, 236, 217)');
    assert.equal(await page.locator('.toggle-icon .moon').isVisible(), true);
    await toggle.click();
    assert.equal(await page.locator('.kh-brand-actions').getByRole('button', { name: 'Log out' }).count(), 1);

    // An interactive (button) human avatar keeps its own font over `button { font: inherit }`.
    await page.goto(`${url}?probe`);
    await page.locator('.kh-detail .kh-hav').waitFor();
    assert.deepEqual(await styleOf(page, '.kh-detail .kh-hav', ['fontSize', 'fontWeight']), { fontSize: '11.52px', fontWeight: '700' });
    await page.goto(url);
    await page.locator('.kh-card').waitFor();

    // ≤1100px narrows the list to 260px.
    await page.setViewportSize({ width: 1100, height: 900 });
    assert.equal((await box(page, '.kh-list')).width, 260);

    // Phone: the list view shows the brand row; the thread view hides the list.
    await page.setViewportSize({ width: 390, height: 844 });
    assert.deepEqual(await box(page, '.kh-card'), { width: 390, height: 844 });
    assert.equal(await page.locator('.kh-brand').isVisible(), true);
    assert.equal(await page.locator('.kh-main').isVisible(), false);
    await page.getByRole('button', { name: /Release retro/u }).click();
    assert.match(await page.locator('.kh-card').getAttribute('class') ?? '', /\bin-thread\b/u);
    assert.equal(await page.locator('.kh-list').isVisible(), false);
    assert.equal(await page.locator('.kh-main').isVisible(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no horizontal overflow on a phone');
  } finally {
    await browser?.close();
    if (server) await new Promise<void>(resolve => server!.httpServer!.close(() => resolve()));
    await rm(outDir, { recursive: true, force: true });
    await rm(chromiumProfileRoot, { recursive: true, force: true });
  }
});
