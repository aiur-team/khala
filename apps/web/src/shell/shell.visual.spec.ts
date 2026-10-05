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

// Both selected combinations alongside unread, read and hover, on desktop and phone.
for (const theme of THEMES) {
  for (const width of [390, 1280]) {
    for (const selected of ['launch', 'design']) {
      test(`${theme} row states at ${width}, selected ${selected}`, async ({ page }) => {
        await page.setViewportSize({ width, height: 844 });
        await page.goto(`${url}?view=list&theme=${theme}&selected=${selected}${selected === 'launch' ? '&singleUnread' : ''}`);
        await page.locator('.kh-cv').first().waitFor();
        await page.locator(`[data-kh-convo="${selected === 'launch' ? 'design' : 'launch'}"]`).hover();
        await settle(page);
        const badge = page.locator('.kh-cv-unread');
        const placements = await badge.evaluateAll(dots => dots.map(dot => {
          const badgeBox = dot.getBoundingClientRect();
          const row = dot.closest('.kh-cv')!.getBoundingClientRect();
          const avatar = dot.closest('.kh-cv-av')!.querySelector('.kh-av')!.getBoundingClientRect();
          const fillRadius = badgeBox.width / 2 - parseFloat(getComputedStyle(dot).borderLeftWidth);
          const distance = Math.hypot(
            badgeBox.left + badgeBox.width / 2 - (avatar.left + avatar.width / 2),
            badgeBox.top + badgeBox.height / 2 - (avatar.top + avatar.height / 2),
          );
          return badgeBox.left >= row.left && badgeBox.top >= row.top
            && badgeBox.right <= row.right && badgeBox.bottom <= row.bottom
            && Math.abs(distance - avatar.width / 2) <= fillRadius;
        }));
        expect(placements.length).toBe(selected === 'launch' ? 2 : 1);
        expect(placements.every(Boolean)).toBe(true);
        await expect(page.locator('.kh-list')).toHaveScreenshot(`${theme}-rows-${width}-${selected}.png`);
      });
    }
  }
}
