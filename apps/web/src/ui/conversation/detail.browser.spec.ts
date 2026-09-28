import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { build, preview, type PreviewServer } from 'vite';
import { chromium, type Browser } from '@playwright/test';

test('details overlay traps keyboard focus and returns it to the opener', { timeout: 90_000 }, async () => {
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
    await page.getByRole('button', { name: /Khala design/ }).click();
    const opener = page.getByRole('button', { name: 'Conversation details' });
    await opener.click();
    const close = page.getByRole('button', { name: 'Close details' });
    assert.equal(await page.getByRole('dialog', { name: 'Conversation details' }).getAttribute('aria-modal'), 'true');
    assert.equal(await close.evaluate(element => document.activeElement === element), true);
    await page.keyboard.press('Tab');
    assert.equal(await close.evaluate(element => document.activeElement === element), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.equal(await opener.evaluate(element => document.activeElement === element), true);
  } finally {
    await browser?.close();
    if (server) await new Promise<void>(resolve => server!.httpServer!.close(() => resolve()));
    await rm(scratch, { recursive: true, force: true });
  }
});
