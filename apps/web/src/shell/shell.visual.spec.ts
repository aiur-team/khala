import { expect, test, type Page } from '@playwright/test';
import { SHELL_PORT } from '../../playwright.visual.config';

// Screenshot baselines for the edge-to-edge Khala frame, rendered by the
// synthetic browser harness (src/shell/browser-harness). Run with
// `pnpm --filter @khala/web test:visual` inside the pinned Playwright image;
// see playwright.visual.config.ts.

const url = `http://127.0.0.1:${SHELL_PORT}/`;
const THEMES = ['light', 'dark'] as const;
type Theme = (typeof THEMES)[number];

async function settle(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function open(page: Page, theme: Theme, viewport: { width: number; height: number }, view: 'list' | 'thread'): Promise<void> {
  await page.setViewportSize(viewport);
  // A phone thread view hides the brand row's toggle, so the theme is a query parameter.
  await page.goto(`${url}?view=${view}&theme=${theme}`);
  await page.locator('.kh-card').waitFor();
  await expect(page.locator('.khala-app')).toHaveAttribute('data-theme', theme);
  await page.mouse.move(0, 0);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await settle(page);
}

for (const theme of THEMES) {
  test.describe(theme, () => {
    test('frame at 1440', async ({ page }) => {
      await open(page, theme, { width: 1440, height: 900 }, 'thread');
      await expect(page).toHaveScreenshot(`${theme}-frame-1440.png`);
    });

    test('frame at 1100', async ({ page }) => {
      await open(page, theme, { width: 1100, height: 800 }, 'thread');
      await expect(page).toHaveScreenshot(`${theme}-frame-1100.png`);
    });

    test('phone list', async ({ page }) => {
      await open(page, theme, { width: 390, height: 844 }, 'list');
      await expect(page).toHaveScreenshot(`${theme}-phone-list.png`);
    });

    test('phone thread', async ({ page }) => {
      await open(page, theme, { width: 390, height: 844 }, 'thread');
      await expect(page).toHaveScreenshot(`${theme}-phone-thread.png`);
    });
  });
}
