import { test, expect } from '@playwright/test';
import { TIMELINE_PORT } from '../../../playwright.visual.config';

for (const theme of ['light', 'dark']) {
  for (const width of [390, 1280]) {
    test(`${theme} timeline at ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`http://127.0.0.1:${TIMELINE_PORT}/?theme=${theme}&empty`);
      await expect(page.getByText('No messages yet', { exact: true })).toBeVisible();
      await expect(page.locator('section.timeline')).toHaveScreenshot(`${theme}-${width}-empty.png`);
      await page.goto(`http://127.0.0.1:${TIMELINE_PORT}/?theme=${theme}`);
      await expect(page.getByText('Historical message 39', { exact: true })).toBeAttached();
      await page.evaluate(() => window.__timelineHarness.delayHistory());
      await page.locator('.timeline__list').evaluate(node => {
        node.scrollTop = 40;
        node.dispatchEvent(new Event('scroll'));
      });
      await expect(page.getByRole('status', { name: 'Loading earlier messages' })).toBeVisible();
      await expect(page.locator('section.timeline')).toHaveScreenshot(`${theme}-${width}-back-scroll.png`);
    });
  }
}
