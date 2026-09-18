import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { build, preview, type PreviewServer } from 'vite';
import { chromium, type Browser } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const harnessRoot = join(here, 'browser-harness');

async function isMobileLayout(page: import('@playwright/test').Page): Promise<boolean> {
  return page.evaluate(() => getComputedStyle(document.querySelector('.aiur-shell__nav')!).flexDirection === 'row');
}

// Real desktop and phone viewports plus the source-derived 960px breakpoint,
// browser-verified per docs/evidence/ui-planning-grounding.md. This harness
// renders the production AiurShell/KhalaPageFrame/Panel/StatusBadge
// components with synthetic content; it is not a full-page or full-product
// integration test.
test('AiurShell layout survives desktop, phone and breakpoint viewports', { timeout: 90_000 }, async () => {
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
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto(url);

    // Desktop: exactly one topbar/nav/main, long nav label visible, count badge shown.
    await page.getByRole('navigation', { name: 'Main navigation' }).waitFor();
    assert.equal(await page.getByRole('navigation').count(), 1);
    assert.equal(await page.getByRole('main').count(), 1);
    assert.equal(await page.getByText('2', { exact: true }).count(), 1);
    assert.equal(await page.getByRole('link', { name: /Conversations/ }).count(), 1);

    // Collapse: focus does not move to a hidden element, and every nav link
    // keeps an accessible name (the visible label text is hidden, not removed
    // from the accessibility tree).
    const collapseToggle = page.locator('.aiur-shell__nav-toggle');
    const navWidthBefore = await page.locator('.aiur-shell__nav').evaluate(node => node.getBoundingClientRect().width);
    await collapseToggle.focus();
    assert.equal(await collapseToggle.innerText(), 'Collapse navigation');
    await collapseToggle.click();
    assert.equal(await collapseToggle.innerText(), 'Expand navigation');
    assert.equal(await collapseToggle.evaluate(node => node === document.activeElement), true);
    assert.equal(await collapseToggle.isVisible(), true);
    const navWidthAfter = await page.locator('.aiur-shell__nav').evaluate(node => node.getBoundingClientRect().width);
    assert.ok(navWidthAfter < navWidthBefore, `collapsed rail (${navWidthAfter}px) should be narrower than expanded (${navWidthBefore}px)`);
    assert.equal(await page.getByRole('link', { name: /Conversations/ }).count(), 1, 'nav link keeps its accessible name while collapsed');
    assert.equal(
      await page.getByRole('link', { name: /A rather long navigation destination name/ }).count(),
      1,
      'long nav link keeps its accessible name while collapsed',
    );
    await collapseToggle.click();

    // Theme swap changes tokens without breaking legibility or focus.
    const themeToggle = page.locator('.aiur-shell__theme-toggle');
    await themeToggle.focus();
    assert.equal(await themeToggle.innerText(), 'Use light theme');
    await themeToggle.click();
    assert.equal(await themeToggle.innerText(), 'Use dark theme');
    assert.equal(await page.evaluate(() => document.querySelector('.aiur-shell')!.getAttribute('data-theme')), 'light');
    await themeToggle.click();

    // Keyboard reaches the review control and it stays visible.
    const review = page.getByRole('button', { name: 'Review selected batch' });
    await review.focus();
    assert.equal(await review.evaluate(node => node === document.activeElement), true);
    assert.equal(await review.isVisible(), true);

    // The source breakpoint is min-width: 960px desktop; 959px is mobile.
    await page.setViewportSize({ width: 960, height: 900 });
    assert.equal(await isMobileLayout(page), false, '960px is the desktop side of the breakpoint');
    await page.setViewportSize({ width: 959, height: 900 });
    assert.equal(await isMobileLayout(page), true, '959px is the mobile side of the breakpoint');

    for (const [label, width, height] of [
      ['960px breakpoint (desktop side)', 960, 900],
      ['959px breakpoint (mobile side)', 959, 900],
      ['iPhone-class phone', 390, 844],
      ['small-android-class phone', 360, 780],
      ['landscape phone', 844, 390],
    ] as const) {
      await page.setViewportSize({ width, height });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
        true,
        `${label}: no horizontal overflow from the long nav label or wrapped message`,
      );
      assert.equal(await page.getByRole('navigation').count(), 1, `${label}: still exactly one navigation landmark`);
      assert.equal(await review.isVisible(), true, `${label}: review control remains reachable`);
    }

    // 200% zoom (approximated by device scale factor) keeps content legible and non-overflowing.
    await page.setViewportSize({ width: 720, height: 500 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, '200% zoom equivalent viewport: no overflow');
    assert.equal(await review.isVisible(), true, '200% zoom equivalent viewport: review control remains visible');

    // Hosted-content mode: no shell chrome is rendered, and the brand tokens
    // still resolve on the content root the host mounted, not just .aiur-shell.
    const hostedPage = await browser.newPage({ viewport: { width: 1024, height: 800 } });
    await hostedPage.goto(`${url}?mode=hosted`);
    await hostedPage.locator('.panel').first().waitFor();
    assert.equal(await hostedPage.getByRole('navigation').count(), 0, 'hosted mode renders no shell navigation landmark');
    assert.equal(await hostedPage.locator('.aiur-shell__topbar').count(), 0, 'hosted mode renders no shell topbar');
    const resolvedFill = await hostedPage
      .locator('.panel')
      .first()
      .evaluate(node => getComputedStyle(node).backgroundColor);
    assert.notEqual(resolvedFill, 'rgba(0, 0, 0, 0)', 'panel background resolves to a real color under hosted-content mode');
    await hostedPage.close();
  } finally {
    await browser?.close();
    if (server) await new Promise<void>(resolve => server!.httpServer!.close(() => resolve()));
    await rm(outDir, { recursive: true, force: true });
    await rm(chromiumProfileRoot, { recursive: true, force: true });
  }
});
