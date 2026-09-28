import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { build, preview, type PreviewServer } from 'vite';
import { chromium, type Browser, type Page } from '@playwright/test';
import type { ApprovalCommand, PolicySetCommand } from '@khala/contracts/delivery/index';

declare global { interface Window {
  __roomReviewCommand: () => ApprovalCommand | null;
  __allowReviewTrust: () => void;
  __reviewLookupCount: () => number;
  __releaseOldLookup: () => void;
  __oldLookupReturned: () => boolean;
  __setReviewBinding: (kind: 'new' | 'replacement') => void;
  __releaseOldTrust: () => void;
  __oldTrustReturned: () => boolean;
  __releaseReplacementTrust: () => void;
  __switchReviewAccount: () => void;
  __releaseAccountTrust: () => void;
  __controlCommands: () => readonly PolicySetCommand[];
  __releaseOldStatus: () => void;
  __oldStatusReturned: () => boolean;
} }

async function withRoomPage(path: string, run: (page: Page) => Promise<void>): Promise<void> {
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
    await page.goto(server.resolvedUrls!.local[0]! + path);
    await run(page);
  } finally {
    await browser?.close();
    if (server) await new Promise<void>(resolve => server!.httpServer!.close(() => resolve()));
    await rm(scratch, { recursive: true, force: true });
  }
}

test('mounted human room reviews only the selected event for its active binding', { timeout: 90_000 }, async () => {
  await withRoomPage('review-room.html', async page => {
    await page.getByText('Waiting for verified agent device trust.').waitFor();
    assert.equal(await page.getByRole('list', { name: 'Pending messages' }).count(), 0);
    await page.evaluate(() => window.__allowReviewTrust());
    await page.getByRole('list', { name: 'Pending messages' }).getByText('Withheld A').waitFor();
    await page.getByRole('list', { name: 'Pending messages' }).getByText('Approved B').waitFor();
    await page.locator('[data-event-id="event_b"] input[type="checkbox"]').check();
    await page.getByRole('button', { name: 'Release 1 selected' }).click();
    await page.getByText('Released', { exact: true }).waitFor();
    const sent = await page.evaluate(() => window.__roomReviewCommand());
    assert.equal(sent?.bindingId, 'binding_1');
    assert.deepEqual(sent?.selection.map(value => value.eventId), ['event_b']);
    assert.equal(await page.getByRole('list', { name: 'Pending messages' }).getByText('Withheld A').count(), 1);
  });
});

test('new binding and account stay current after older trust finishes out of order', { timeout: 90_000 }, async () => {
  await withRoomPage('review-room.html?race=1', async page => {
    await page.getByText('Waiting for verified agent device trust.').waitFor();
    await page.evaluate(() => window.__setReviewBinding('new'));
    await page.getByText('To: New agent').waitFor();
    await page.evaluate(() => window.__releaseOldTrust());
    await page.waitForFunction(() => window.__oldTrustReturned());
    assert.equal(await page.getByText('To: Old agent').count(), 0);
    assert.equal(await page.getByText('To: New agent').count(), 1);

    // A participant replacement under the same binding/generation/device must
    // lose the prior trust cache entry and wait for its own verification.
    await page.evaluate(() => window.__setReviewBinding('replacement'));
    await page.getByText('Waiting for verified agent device trust.').waitFor();
    assert.equal(await page.getByText('To: New agent').count(), 0);
    await page.evaluate(() => window.__releaseReplacementTrust());
    await page.getByText('To: Replaced identity').waitFor();

    // Route/account replacement discards the old route lease and trust cache.
    await page.evaluate(() => window.__switchReviewAccount());
    await page.getByText('Waiting for verified agent device trust.').waitFor();
    assert.equal(await page.getByText('To: Replaced identity').count(), 0);
    await page.evaluate(() => window.__releaseAccountTrust());
    await page.getByText('To: Other account agent').waitFor();
  });
});

test('an older binding lookup cannot restore its recipient after a newer lookup', { timeout: 90_000 }, async () => {
  await withRoomPage('review-room.html?race=1&lookup=1', async page => {
    await page.waitForFunction(() => window.__reviewLookupCount() >= 1);
    await page.evaluate(() => window.__setReviewBinding('new'));
    await page.getByText('To: New agent').waitFor();
    await page.evaluate(() => window.__releaseOldLookup());
    await page.waitForFunction(() => window.__oldLookupReturned());
    assert.equal(await page.getByText('To: Old agent').count(), 0);
    assert.equal(await page.getByText('To: New agent').count(), 1);
  });
});

test('mounted owner controls use the discovered binding and show the connector acknowledgement', { timeout: 90_000 }, async () => {
  await withRoomPage('review-room.html?controls=1', async page => {
    await page.getByRole('button', { name: 'Request pause' }).waitFor();
    await page.getByRole('button', { name: 'Request pause' }).click();
    await page.getByText('review, pause requested (v4) — confirmed').waitFor();
    const commands = await page.evaluate(() => window.__controlCommands());
    assert.equal(commands.length, 1);
    assert.equal(commands[0]?.bindingId, 'binding_1');
    assert.equal(commands[0]?.expectedBindingGeneration, 0);
    assert.equal(commands[0]?.expectedPolicyVersion, 3);
    assert.equal(commands[0]?.mode, 'review');
    assert.equal(commands[0]?.paused, true);
  });
});

test('mounted controls discard an old generation and account while their status answer is delayed', { timeout: 90_000 }, async () => {
  await withRoomPage('review-room.html?controls=1&race=1&status-race=1', async page => {
    await page.getByRole('heading', { name: 'Agent delivery controls' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Request pause' }).isDisabled(), true);
    await page.evaluate(() => window.__setReviewBinding('new'));
    await page.getByText('New agent', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Request pause' }).waitFor();
    await page.evaluate(() => window.__releaseOldStatus());
    await page.waitForFunction(() => window.__oldStatusReturned());
    assert.equal(await page.getByText('Old agent').count(), 0);
    await page.getByRole('button', { name: 'Request pause' }).click();
    const first = await page.evaluate(() => window.__controlCommands());
    assert.equal(first[0]?.expectedBindingGeneration, 1);
    await page.evaluate(() => window.__switchReviewAccount());
    await page.getByText('Other account agent').waitFor();
    await page.getByRole('button', { name: 'Request pause' }).waitFor();
    await page.getByRole('button', { name: 'Request pause' }).click();
    const all = await page.evaluate(() => window.__controlCommands());
    assert.equal(all[1]?.expectedBindingGeneration, 1);
    assert.equal(all[1]?.expectedPolicyVersion, 3);
  });
});
