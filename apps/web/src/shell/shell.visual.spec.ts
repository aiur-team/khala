import { expect, test, type Page } from '@playwright/test';
import { SHELL_PORT } from '../../playwright.visual.config';

// Screenshot baselines for the React shell, rendered by the synthetic browser
// harness (src/shell/browser-harness). Run with `pnpm --filter @khala/web
// test:visual` inside the pinned Playwright image; see playwright.visual.config.ts.

const url = `http://127.0.0.1:${SHELL_PORT}/`;
const THEMES = ['light', 'dark'] as const;
type Theme = (typeof THEMES)[number];

async function settle(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function openStandalone(page: Page, theme: Theme, viewport = { width: 1280, height: 800 }): Promise<void> {
  await page.setViewportSize(viewport);
  await page.goto(url);
  await page.getByRole('navigation', { name: 'Main navigation' }).waitFor();
  // The harness starts dark; light is one click on the shell's own toggle.
  if (theme === 'light') await page.getByRole('button', { name: 'Use light theme' }).click();
  await expect(page.locator('.aiur-shell')).toHaveAttribute('data-theme', theme);
  await page.mouse.move(0, 0);
  await settle(page);
}

for (const theme of THEMES) {
  test.describe(theme, () => {
    test('standalone expanded', async ({ page }) => {
      await openStandalone(page, theme);
      await expect(page).toHaveScreenshot(`${theme}-standalone-expanded.png`);
    });

    test('standalone collapsed', async ({ page }) => {
      await openStandalone(page, theme);
      await page.getByRole('button', { name: 'Collapse navigation' }).click();
      await expect(page.locator('.aiur-shell')).toHaveClass(/aiur-shell--collapsed/);
      await page.mouse.move(0, 0);
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await expect(page).toHaveScreenshot(`${theme}-standalone-collapsed.png`);
    });

    test('standalone at 959px', async ({ page }) => {
      await openStandalone(page, theme, { width: 959, height: 900 });
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await expect(page).toHaveScreenshot(`${theme}-standalone-959.png`);
    });

    test('hosted-content', async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.goto(`${url}?mode=hosted`);
      const root = page.locator('.khala-content-root');
      await root.waitFor();
      // Hosted mode has no theme toggle; the host decides the theme, which the
      // harness renders as data-theme on the content root.
      if (theme === 'light') await root.evaluate(node => node.setAttribute('data-theme', 'light'));
      await expect(root).toHaveAttribute('data-theme', theme);
      await settle(page);
      await expect(page).toHaveScreenshot(`${theme}-hosted-content.png`);
    });
  });
}
