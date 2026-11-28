import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { build, preview, type PreviewServer } from 'vite';
import { chromium, type Browser } from '@playwright/test';

test('locked history action never covers timeline text on desktop or mobile', { timeout: 90_000 }, async () => {
  const scratch = await mkdtemp(join(process.env.TMPDIR ?? '/tmp', 'khala-device-link-'));
  const profile = await mkdtemp(join('/tmp', 'khala-dl-'));
  let server: PreviewServer | null = null;
  let browser: Browser | null = null;
  try {
    await build({ root: join(import.meta.dirname, 'browser-harness'),
      build: { outDir: join(scratch, 'dist'), emptyOutDir: true,
        rollupOptions: { input: join(import.meta.dirname, 'browser-harness/device-link.html') } }, logLevel: 'error' });
    server = await preview({ root: join(import.meta.dirname, 'browser-harness'),
      build: { outDir: join(scratch, 'dist') }, preview: { host: '127.0.0.1', port: 0 } });
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
      headless: true, args: ['--no-sandbox'], env: { ...process.env, TMPDIR: profile } });
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await page.goto(server.resolvedUrls!.local[0]! + 'device-link.html');
      const prompt = page.locator('.kh-devlink');
      const text = page.locator('.message-text');
      await prompt.waitFor({ state: 'attached', timeout: 5_000 }).catch(async error => {
        throw new Error(`device prompt did not mount; errors: ${errors.join(' | ')}; body: ${await page.locator('body').innerText()}`, { cause: error });
      });
      const [promptBox, textBox] = await Promise.all([prompt.boundingBox(), text.boundingBox()]);
      assert.ok(promptBox && textBox);
      const intersects = promptBox.x < textBox.x + textBox.width && promptBox.x + promptBox.width > textBox.x
        && promptBox.y < textBox.y + textBox.height && promptBox.y + promptBox.height > textBox.y;
      assert.equal(intersects, false, `device prompt covers timeline text at ${viewport.width}px`);
      assert.equal(await prompt.getByRole('button', { name: 'Not now' }).isVisible(), true);
    }
  } finally {
    await browser?.close();
    if (server) await new Promise<void>(resolve => server!.httpServer!.close(() => resolve()));
    await rm(scratch, { recursive: true, force: true });
    await rm(profile, { recursive: true, force: true });
  }
});
