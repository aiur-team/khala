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
// message-renderer, driven by a synthetic in-memory ChannelPort (no real
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
    // each row is labeled by its own author's kind and ownership — Alice's
    // row (a human, not owned by the harness viewer... the harness viewer
    // *is* Alice, so her own rows read "You") and the release agent's row
    // (owned by Alice, the viewer) read "Your agent", scoped to that row.
    await page.getByTestId('review-recent_1').waitFor();
    const welcomeRow = page.locator('[data-event-id="recent_1"]');
    await welcomeRow.getByText('You', { exact: true }).waitFor();
    const agentRow = page.locator('[data-event-id="recent_2"]');
    await agentRow.getByText('Your agent', { exact: true }).waitFor();

    // Send + reconcile: composing and sending a human message shows exactly
    // one row for it once accepted (no duplicate local-echo row survives).
    const composer = page.getByRole('textbox', { name: 'Message' });
    await composer.fill('a fresh reply from the browser test');
    await page.getByRole('button', { name: 'Send' }).click();
    await page.getByText('a fresh reply from the browser test').waitFor();
    assert.equal(await page.getByText('a fresh reply from the browser test').count(), 1, 'exactly one row for the reconciled send');

    // A draft is sent trimmed, but its acceptance is recognized against the
    // reader's untrimmed text too: trailing whitespace alone must not leave a
    // stale draft behind once that exact send has reconciled.
    await composer.fill('a padded reply   ');
    await page.getByRole('button', { name: 'Send' }).click();
    await page.getByText('a padded reply').waitFor();
    assert.strictEqual(await composer.inputValue(), '', 'trailing whitespace does not block the draft from clearing on reconciliation');

    // outcome_unknown resolves through the same transaction, not a fresh send.
    // The draft is kept (not cleared) until the send is durably accepted, and
    // the row is labeled "Delivery unknown" — its own label, not just the
    // count of subsequent rows, is asserted here.
    await composer.fill('__outcome_unknown please confirm');
    await page.getByRole('button', { name: 'Send' }).click();
    await page.getByText('Delivery unknown').waitFor();
    assert.strictEqual(await composer.inputValue(), '__outcome_unknown please confirm', 'the draft is kept while the send is unresolved');
    await page.getByRole('button', { name: 'Check delivery' }).waitFor();
    // While the send is unresolved, Send stays disabled — the reader cannot
    // submit a fresh, differently-identified send of the same or new text
    // underneath an outcome that may already have landed (AE2).
    await composer.fill('a different message typed while unresolved');
    assert.equal(await page.getByRole('button', { name: 'Send' }).isDisabled(), true, 'Send is disabled while a send is outcome_unknown');
    await composer.fill('');
    await page.getByRole('button', { name: 'Check delivery' }).click();
    await page.getByText('__outcome_unknown please confirm').waitFor();
    assert.equal(await page.getByText('__outcome_unknown please confirm').count(), 1, 'resolving outcome_unknown does not duplicate the message');

    // A definite failure shows "Not delivered" with a Retry action that
    // resolves through the same transaction; the draft is not lost and a
    // second, independently pending send is not silently dropped by it.
    await composer.fill('__fail_once please retry');
    await page.getByRole('button', { name: 'Send' }).click();
    await page.getByText('Not delivered').waitFor();
    // Send stays disabled for the same reason: only Retry (same clientTxnId)
    // may resolve a definite failure, never a fresh Send with new bytes.
    assert.equal(await page.getByRole('button', { name: 'Send' }).isDisabled(), true, 'Send is disabled while a send has failed');
    await page.getByRole('button', { name: 'Retry' }).click();
    await page.getByText('__fail_once please retry').waitFor();
    assert.equal(await page.getByText('__fail_once please retry').count(), 1, 'retrying a failed send does not duplicate the message');
    assert.equal(await page.getByText('Not delivered').count(), 0, 'the failed row clears once the retry is accepted');
    await composer.fill('a new message once everything is resolved');
    assert.equal(await page.getByRole('button', { name: 'Send' }).isDisabled(), false, 'Send re-enables once every send is resolved');

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

    // A revoked membership shows an explicit state and disables the composer;
    // it never leaves the reader typing into a room they can no longer reach.
    await page.evaluate(() => (window as unknown as { __timelineHarness: { revokeMembership: () => void } }).__timelineHarness.revokeMembership());
    await page.getByText('no longer have access').waitFor();
    assert.equal(await composer.isDisabled(), true, 'the composer is disabled once membership is revoked');
  } finally {
    await browser?.close();
    if (server) await new Promise<void>(resolve => server!.httpServer!.close(() => resolve()));
    await rm(outDir, { recursive: true, force: true });
    await rm(chromiumProfileRoot, { recursive: true, force: true });
  }
});
