import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { build, preview, type PreviewServer } from 'vite';
import { chromium, type Browser } from '@playwright/test';

declare global { interface Window {
  __lossHarness: {
    setDevice(next: 'lost' | 'ready' | 'revoked', reason?: import('@khala/contracts/messaging/index').DeviceView['reason']): void;
    switchAccount(): void;
    activationCount(): number;
    inboxCount(): number;
  };
} }

test('mounted owner screen fences lost keys and resets on account switch', { timeout: 90_000 }, async () => {
  const scratch = await mkdtemp(join(process.env.TMPDIR ?? '/tmp', 'khala-device-loss-'));
  let server: PreviewServer | null = null;
  let browser: Browser | null = null;
  try {
    await build({ root: join(import.meta.dirname, 'browser-harness'),
      build: { outDir: join(scratch, 'dist'), emptyOutDir: true,
        rollupOptions: { input: join(import.meta.dirname, 'browser-harness/device-loss.html') } }, logLevel: 'error' });
    server = await preview({ root: join(import.meta.dirname, 'browser-harness'),
      build: { outDir: join(scratch, 'dist') }, preview: { host: '127.0.0.1', port: 0 } });
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
      headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(server.resolvedUrls!.local[0]! + 'device-loss.html');
    try {
      await page.getByRole('heading', { name: "This device's keys are unavailable" }).waitFor({ timeout: 5_000 });
    } catch (error) {
      throw new Error(`Lost state did not mount; page errors: ${errors.join(' | ')}; body: ${await page.locator('body').innerText()}`, { cause: error });
    }
    assert.equal(await page.getByTestId('live-room').count(), 0);
    assert.equal(await page.evaluate(() => window.__lossHarness.inboxCount()), 0);
    assert.equal(await page.getByRole('button', { name: 'Check retained keys again' }).count(), 0);

    // A retained profile is a fresh application lifecycle, not a retry of the
    // sticky lost service instance above.
    await page.goto(server.resolvedUrls!.local[0]! + 'device-loss.html?state=ready');
    await page.getByTestId('live-room').getByText('Room for owner_alice').waitFor();
    assert.equal(await page.getByRole('heading', { name: "This device's keys are unavailable" }).count(), 0);
    await page.evaluate(() => window.__lossHarness.setDevice('revoked'));
    await page.getByText('revoked_by_owner').waitFor();
    assert.equal(await page.getByTestId('live-room').count(), 0);
    assert.equal(await page.getByRole('heading', { name: "This device's keys are unavailable" }).count(), 0);

    await page.evaluate(() => window.__lossHarness.switchAccount());
    await page.getByRole('heading', { name: "This device's keys are unavailable" }).waitFor();
    assert.equal(await page.getByTestId('live-room').count(), 0);
    assert.equal(await page.evaluate(() => window.__lossHarness.inboxCount()), 1);
  } finally {
    await browser?.close();
    if (server) await new Promise<void>(resolve => server!.httpServer!.close(() => resolve()));
    await rm(scratch, { recursive: true, force: true });
  }
});
