import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { build, preview, type PreviewServer } from 'vite';
import { chromium, type Browser } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const harnessRoot = join(here, 'browser-harness');

// Real headless Chromium against the production TimelineScreen/controller/
// message-renderer, driven by a synthetic in-memory RoomPort (no real
// network, credentials or endpoints). Named `.browser.spec.ts` (not
// `.browser.test.ts`) to stay outside vitest's `*.test.{ts,tsx}` glob, same
// as `shell.browser.spec.ts`.
test('Timeline renders attributed history, stays inert, reconciles sends and preserves scroll position', { timeout: 90_000 }, async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'khala-timeline-dist-'));
  const chromiumProfileRoot = await mkdtemp(join('/tmp', 'khala-timeline-profile-'));
  let server: PreviewServer | undefined;
  let browser: Browser | undefined;
  try {
    await build({ root: harnessRoot, build: { outDir, emptyOutDir: true }, logLevel: 'error' });
    server = await preview({ root: harnessRoot, build: { outDir }, preview: { host: '127.0.0.1', port: 0 } });
    const url = server.resolvedUrls!.local[0]!;

    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
      headless: true,
      args: ['--no-sandbox'],
      env: { ...process.env, TMPDIR: chromiumProfileRoot },
    });
    const page = await browser.newPage({ viewport: { width: 1024, height: 900 } });
    const requestUrls: string[] = [];
    page.on('request', request => requestUrls.push(request.url()));
    await page.goto(url);

    await page.locator('section.timeline').waitFor();

    // AE1: an agent message carrying a fake approval button and a remote image
    // renders as inert text; no real button appears and no request to the
    // image's origin is made.
    assert.equal(await page.getByRole('button', { name: 'Approve' }).count(), 0, 'no real approval control is created from message text');
    assert.equal(await page.locator('img[src*="evil.example.invalid"]').count(), 0, 'no <img> element is created from message text');
    assert.equal(
      requestUrls.some(requested => requested.includes('evil.example.invalid')),
      false,
      'no network request to the remote image origin is ever made',
    );
    assert.equal(await page.getByText('<button onclick').count(), 1, 'the button markup renders as literal inert text');
    await page.evaluate(() => (window as unknown as { __approved?: boolean }).__approved).then(value => assert.equal(value, undefined));

    // A fenced code block renders as monospace inert text, not executable markup.
    assert.equal(await page.locator('pre code', { hasText: '<script>alert(1)</script>' }).count(), 1);

    // Attribution: the review action slot is present per exact EventRef, and
    // both a human and an agent author are visibly distinguished.
    await page.getByTestId('review-recent_1').waitFor();
    assert.equal(await page.getByText('Human', { exact: true }).count() > 0, true);
    assert.equal(await page.getByText('Agent', { exact: true }).count() > 0, true);

    // Send + reconcile: composing and sending a human message shows exactly
    // one row for it once accepted (no duplicate local-echo row survives).
    const composer = page.getByRole('textbox', { name: 'Message' });
    await composer.fill('a fresh reply from the browser test');
    await page.getByRole('button', { name: 'Send' }).click();
    await page.getByText('a fresh reply from the browser test').waitFor();
    assert.equal(await page.getByText('a fresh reply from the browser test').count(), 1, 'exactly one row for the reconciled send');

    // outcome_unknown resolves through the same transaction, not a fresh send.
    await composer.fill('__outcome_unknown please confirm');
    await page.getByRole('button', { name: 'Send' }).click();
    await page.getByRole('button', { name: 'Check delivery' }).waitFor();
    await page.getByRole('button', { name: 'Check delivery' }).click();
    await page.getByText('__outcome_unknown please confirm').waitFor();
    assert.equal(await page.getByText('__outcome_unknown please confirm').count(), 1, 'resolving outcome_unknown does not duplicate the message');

    // Pagination preserves the reader's anchored event *within the scrollable
    // list* after prepending 20+ older rows. Measured relative to the list's
    // own bounding box, not the viewport: the list's page position may
    // legitimately shift (e.g. the "Load earlier messages" control disappears
    // once history is exhausted), which is unrelated to anchor preservation.
    const anchorRow = page.locator('[data-event-id="recent_1"]');
    const list = page.locator('.timeline__list');
    const relativeTop = async () => {
      const [rowTop, listTop] = await Promise.all([
        anchorRow.evaluate(node => node.getBoundingClientRect().top),
        list.evaluate(node => node.getBoundingClientRect().top),
      ]);
      return rowTop - listTop;
    };
    const beforeTop = await relativeTop();
    await page.getByRole('button', { name: 'Load earlier messages' }).click();
    await page.getByText('Historical message 19').waitFor();
    const afterTop = await relativeTop();
    assert.ok(Math.abs(afterTop - beforeTop) < 4, `anchored row should stay within 4px of its prior position within the list (before=${beforeTop}, after=${afterTop})`);

    // A live message arriving while scrolled away increments a visible count,
    // without moving the reader; jump-to-latest returns and clears the count.
    await list.evaluate(
      node =>
        new Promise<void>(resolve => {
          node.addEventListener('scroll', () => resolve(), { once: true });
          node.scrollTop = 0;
        }),
    );
    // The scroll handler's `atLatest` state update lands in a passive effect
    // that syncs it to the controller; give React a paint cycle to flush it
    // before the next live snapshot arrives, or the controller still thinks
    // the reader is at the latest message.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.evaluate(() => (window as unknown as { __timelineHarness: { pushLiveMessage: (body: string) => void } }).__timelineHarness.pushLiveMessage('a live arrival while scrolled away'));
    await page.getByRole('button', { name: /new message/ }).waitFor();
    await page.getByRole('button', { name: /new message/ }).click();
    assert.equal(await page.getByRole('button', { name: /new message/ }).count(), 0, 'jump-to-latest clears the new-message count');
    assert.equal(await page.getByText('a live arrival while scrolled away').count(), 1);
  } finally {
    await browser?.close();
    if (server) await new Promise<void>(resolve => server!.httpServer!.close(() => resolve()));
    await rm(outDir, { recursive: true, force: true });
    await rm(chromiumProfileRoot, { recursive: true, force: true });
  }
});
