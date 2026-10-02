import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { build, preview, type PreviewServer } from 'vite';
import { chromium, type Browser } from '@playwright/test';

test('details trap focus only as an overlay, stay nonmodal on desktop and carry the §11 fixes', { timeout: 90_000 }, async () => {
  const scratch = await mkdtemp(join(process.env.TMPDIR ?? '/tmp', 'khala-conversation-detail-'));
  const root = join(import.meta.dirname, '../../..');
  let server: PreviewServer | null = null;
  let browser: Browser | null = null;
  try {
    await build({ root, build: { outDir: join(scratch, 'dist'), emptyOutDir: true,
      rollupOptions: { input: join(root, 'conversation-fixture.html') } }, logLevel: 'error' });
    server = await preview({ root, build: { outDir: join(scratch, 'dist') },
      preview: { host: '127.0.0.1', port: 0 } });
    browser = await chromium.launch({ ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
      headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 760, height: 900 } });
    await page.goto(server.resolvedUrls!.local[0]! + 'conversation-fixture.html');
    // Maya's avatar in the channel header opens her detail.
    const opener = page.locator('.kh-head .kh-stack').getByRole('button', { name: 'Maya Chen' });
    await opener.click();
    const close = page.getByRole('button', { name: 'Close details' });
    const dialog = page.getByRole('dialog', { name: 'Maya Chen’s details' });
    assert.equal(await dialog.getAttribute('aria-modal'), 'true');
    assert.equal(await close.evaluate(element => document.activeElement === element), true);
    for (let step = 0; step < 4; step += 1) {
      await page.keyboard.press('Tab');
      assert.equal(await dialog.evaluate(element => element.contains(document.activeElement)), true, 'focus stays in the dialog');
    }
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.equal(await opener.evaluate(element => document.activeElement === element), true);

    await page.setViewportSize({ width: 1440, height: 900 });
    await opener.click();
    const desktopDetail = page.getByRole('complementary', { name: 'Maya Chen’s details' });
    assert.equal(await desktopDetail.count(), 1);
    assert.equal(await desktopDetail.getAttribute('aria-modal'), null);
    assert.equal(await opener.evaluate(element => document.activeElement === element), true);
    // D5: the static agent avatar stays a 32px circle.
    const avatar = await page.locator('.kh-d-agent > .kh-av').first().boundingBox();
    assert.ok(avatar && Math.round(avatar.width) === 32 && Math.round(avatar.height) === 32, `agent avatar is 32×32, got ${JSON.stringify(avatar)}`);
    // D3: the owner pill on Maya's agent keeps its own .78rem text.
    await page.locator('.kh-d-agent').first().click();
    for (const part of ['.kh-d-owner b', '.kh-d-owner > span']) {
      assert.equal(await page.locator(part).evaluate(element => getComputedStyle(element).fontSize), '12.48px', `${part} is .78rem`);
    }
    await page.getByRole('button', { name: 'Close details' }).click();

    // D2: a closed sheet leaves no visible strip on a phone.
    await page.setViewportSize({ width: 390, height: 844 });
    const pane = page.locator('.kh-detail');
    // Visibility follows the .25s slide-out.
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.kh-detail')!).visibility === 'hidden', undefined, { timeout: 2000 });
    assert.equal(await pane.isVisible(), false);
  } finally {
    await browser?.close();
    if (server) await new Promise<void>(resolve => server!.httpServer!.close(() => resolve()));
    await rm(scratch, { recursive: true, force: true });
  }
});
