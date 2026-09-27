import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { build, preview, type PreviewServer } from 'vite';
import { chromium, type Browser } from '@playwright/test';
import type { ApprovalCommand } from '@khala/contracts/delivery/index';

declare global { interface Window { __roomReviewCommand: () => ApprovalCommand | null } }

test('mounted human room reviews only the selected event for its active binding', { timeout: 90_000 }, async () => {
  const scratch = await mkdtemp(join(process.env.TMPDIR ?? '/tmp', 'khala-review-room-'));
  let server: PreviewServer | null = null;
  let browser: Browser | null = null;
  try {
    await build({ root: join(import.meta.dirname, 'browser-harness'),
      build: { outDir: join(scratch, 'dist'), emptyOutDir: true, rollupOptions: { input: join(import.meta.dirname, 'browser-harness/review-room.html') } },
      logLevel: 'error' });
    server = await preview({ root: join(import.meta.dirname, 'browser-harness'),
      build: { outDir: join(scratch, 'dist') }, preview: { host: '127.0.0.1', port: 0 } });
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
      headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    await page.goto(server.resolvedUrls!.local[0]! + 'review-room.html');
    await page.getByRole('list', { name: 'Pending messages' }).getByText('Withheld A').waitFor();
    await page.getByRole('list', { name: 'Pending messages' }).getByText('Approved B').waitFor();
    await page.locator('[data-event-id="event_b"] input[type="checkbox"]').check();
    await page.getByRole('button', { name: 'Release 1 selected' }).click();
    await page.getByText('Released', { exact: true }).waitFor();
    const sent = await page.evaluate(() => window.__roomReviewCommand());
    assert.equal(sent?.bindingId, 'binding_1');
    assert.deepEqual(sent?.selection.map(value => value.eventId), ['event_b']);
    assert.equal(await page.getByRole('list', { name: 'Pending messages' }).getByText('Withheld A').count(), 1);
  } finally {
    await browser?.close();
    if (server) await new Promise<void>(resolve => server!.httpServer!.close(() => resolve()));
    await rm(scratch, { recursive: true, force: true });
  }
});
