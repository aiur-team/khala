import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse } from 'smol-toml';
import { expect, test, type Page } from '@playwright/test';
import { LANDING_PORT, PRODUCTION_CSP } from '../../playwright.visual.config';

// Screenshot baselines for the splash, served from the production build under
// the production CSP. Run with `pnpm --filter @khala/web test:visual` inside the
// pinned Playwright image; see playwright.visual.config.ts.

const here = dirname(fileURLToPath(import.meta.url));
const url = `http://127.0.0.1:${LANDING_PORT}/landing/`;
const THEMES = ['light', 'dark'] as const;
const VIEWPORTS = [
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
  { width: 360, height: 780 },
] as const;
const ELEMENTS = [
  ['banner', '#aiurBanner'],
  ['topbar', '.topbar'],
  ['install-box', '.install-box'],
  ['features', '.features'],
  ['footer', 'footer'],
] as const;

type Theme = (typeof THEMES)[number];
type Viewport = (typeof VIEWPORTS)[number];

declare global {
  interface Window {
    __cspViolations?: string[];
  }
}

// Every page load records CSP violations; the check after each test fails the
// test on any. An inline <script> in index.html, for one, is a violation.
test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener('securitypolicyviolation', event => {
      window.__cspViolations!.push(`${event.violatedDirective} blocked ${event.blockedURI || 'inline'} (${event.sourceFile}:${event.lineNumber})`);
    });
  });
});

test.afterEach(async ({ page }) => {
  if (page.isClosed() || !page.url().startsWith('http')) return;
  expect(await page.evaluate(() => window.__cspViolations ?? []), 'no Content-Security-Policy violations').toEqual([]);
});

async function open(page: Page, theme: Theme, viewport: Viewport, { bannerDismissed = false } = {}): Promise<void> {
  await page.setViewportSize(viewport);
  await page.addInitScript(
    ({ theme, bannerDismissed }) => {
      localStorage.setItem('khala.theme', theme);
      if (bannerDismissed) localStorage.setItem('khala.aiur-banner.dismissed', '1');
      else localStorage.removeItem('khala.aiur-banner.dismissed');
    },
    { theme, bannerDismissed },
  );
  await page.goto(url);
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  // The line field draws once fonts are ready (reduced motion skips the reveal).
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => (document.querySelector<HTMLCanvasElement>('#field')?.width ?? 0) > 0);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

const key = (theme: Theme, viewport: Viewport) => `${theme}-${viewport.width}x${viewport.height}`;

test('serves the netlify.toml Content-Security-Policy', async ({ request }) => {
  const netlify = parse(readFileSync(join(here, '../../../../netlify.toml'), 'utf8')) as {
    headers: { for: string; values: Record<string, string> }[];
  };
  const siteWide = netlify.headers.find(entry => entry.for === '/*');
  expect(siteWide?.values['Content-Security-Policy']).toBe(PRODUCTION_CSP);
  const response = await request.get(url);
  expect(response.headers()['content-security-policy']).toBe(PRODUCTION_CSP);
});

for (const theme of THEMES) {
  for (const viewport of VIEWPORTS) {
    const name = key(theme, viewport);

    test.describe(name, () => {
      test('top', async ({ page }) => {
        await open(page, theme, viewport);
        await expect(page).toHaveScreenshot(`${name}-top.png`);
      });

      test('scrolled 900px', async ({ page }) => {
        await open(page, theme, viewport);
        await page.evaluate(() => window.scrollTo(0, 900));
        await expect(page.locator('#scrollcue')).toHaveClass(/\bgone\b/);
        await expect(page).toHaveScreenshot(`${name}-scrolled.png`);
      });

      test('banner dismissed', async ({ page }) => {
        await open(page, theme, viewport, { bannerDismissed: true });
        await expect(page.locator('#aiurBanner')).toBeHidden();
        await expect(page).toHaveScreenshot(`${name}-banner-dismissed.png`);
      });

      test('coming-soon prompt box', async ({ page }) => {
        await open(page, theme, viewport);
        await expect(page.locator('.prompt-frame')).toHaveScreenshot(`${name}-prompt-coming-soon.png`);
      });

      test('elements', async ({ page }) => {
        await open(page, theme, viewport);
        for (const [element, selector] of ELEMENTS) {
          await expect(page.locator(selector)).toHaveScreenshot(`${name}-element-${element}.png`);
        }
      });
    });
  }
}

// Proof the net catches a small regression: moving the banner dismiss by 2px
// must fail the banner baseline.
test('self-test: a 2px shift of the banner dismiss fails the banner baseline', async ({ page }, testInfo) => {
  const updating = testInfo.config.updateSnapshots === 'all' || testInfo.config.updateSnapshots === 'changed';
  test.skip(updating, 'never take a baseline from a deliberately wrong render');
  const viewport = VIEWPORTS[0];
  const baseline = `${key('light', viewport)}-element-banner.png`;
  expect(existsSync(testInfo.snapshotPath(baseline)), `baseline ${baseline} exists`).toBe(true);

  await open(page, 'light', viewport);
  const close = page.locator('.banner-close');
  const right = await close.evaluate(node => parseFloat(getComputedStyle(node).right));
  await page.addStyleTag({ content: `.banner-close { right: ${right + 2}px; }` });
  expect(await close.evaluate(node => parseFloat(getComputedStyle(node).right))).toBe(right + 2);

  await expect(expect(page.locator('#aiurBanner')).toHaveScreenshot(baseline, { timeout: 2_000 })).rejects.toThrow(
    /pixels \(ratio [\d.]+ of all image pixels\) are different/,
  );
});
