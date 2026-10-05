import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { build, preview, type PreviewServer } from 'vite';
import { chromium, type Browser, type Locator, type Page } from '@playwright/test';

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
    await page.goto(`${url}?empty`);
    await page.getByText('No messages yet', { exact: true }).waitFor();
    assert.equal(await page.getByRole('status', { name: 'Loading earlier messages' }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Load earlier messages' }).count(), 0);
    // A sparse first page must auto-fill without any possible scroll gesture.
    // Resizing taller then exhausts the remaining history, once per raw page.
    await page.goto(`${url}?sparse`);
    await page.waitForFunction(() => {
      const list = document.querySelector('.timeline__list')!;
      return list.scrollHeight > list.clientHeight + 80;
    });
    const sparseCalls = await page.evaluate(() => window.__timelineHarness.historyCalls());
    assert.ok(sparseCalls > 1 && sparseCalls < 40);
    assert.equal(await page.getByRole('button', { name: 'Load earlier messages' }).count(), 0);
    await page.setViewportSize({ width: 1024, height: 10000 });
    await page.getByText('Historical message 0', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.__timelineHarness.historyCalls()), 40);
    assert.equal(await page.getByRole('status', { name: 'Loading earlier messages' }).count(), 0);
    // Real name scanning caches older pages; auto-fill reveals those pages too.
    await page.goto(`${url}?cached`);
    await page.getByText('Historical message 0', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.__timelineHarness.historyCalls()), 2);
    await page.setViewportSize({ width: 1024, height: 900 });
    await page.goto(url);

    await page.locator('section.timeline').waitFor();
    await page.waitForFunction(() => window.__timelineHarness.readEvents.includes('recent_3'));
    assert.equal(await page.evaluate(() => window.__timelineHarness.readEvents.filter(id => id === 'recent_3').length), 1, 'opening and seeing latest marks it once');

    await page.evaluate(() => window.__timelineHarness.showUnavailable());
    const unavailable = page.locator('[data-event-id="encrypted"]');
    await unavailable.getByText('Message unavailable on this device.', { exact: true }).waitFor();
    assert.equal(await unavailable.locator('button,time').count(), 0);
    assert.equal(await unavailable.getByText('untrusted-author').count(), 0);
    assert.deepEqual(await page.locator('[data-event-id]').evaluateAll(rows => rows.slice(-4).map(row => row.getAttribute('data-event-id'))),
      ['recent_1', 'encrypted', 'recent_2', 'recent_3']);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await unavailable.evaluate(row => row.scrollWidth <= row.clientWidth), true);
    await page.evaluate(() => window.__timelineHarness.decryptUnavailable());
    await unavailable.getByText('Recovered message', { exact: true }).waitFor();
    assert.equal(await unavailable.count(), 1);
    assert.equal(await page.getByText('Message unavailable on this device.', { exact: true }).count(), 0);
    await page.setViewportSize({ width: 1024, height: 900 });

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
    // each row is marked by its own author's kind and ownership. The harness
    // viewer *is* Alice, so her rows are `.me` bubbles with no name line; the
    // release agent's row (owned by Alice) is an ordinary agent row marked
    // `.agent.yours` with no machine tag, scoped to that row.
    await page.getByTestId('review-recent_1').waitFor();
    const welcomeRow = page.locator('[data-event-id="recent_1"]');
    assert.equal(await welcomeRow.evaluate(row => row.classList.contains('me')), true);
    assert.equal(await welcomeRow.locator('.kh-name, .kh-av').count(), 0);
    const agentRow = page.locator('[data-event-id="recent_2"]');
    await agentRow.locator('.kh-name').waitFor();
    assert.equal(await agentRow.evaluate(row => row.classList.contains('me')), false);
    assert.equal(await agentRow.evaluate(row => row.classList.contains('agent') && row.classList.contains('yours')), true);
    assert.equal(await agentRow.getByText(/machine/u).count(), 0);
    assert.match(await agentRow.locator('.kh-name').getAttribute('aria-label') ?? '', /, your agent, /);

    // Send + reconcile: composing and sending a human message shows exactly
    // one row for it once accepted (no duplicate local-echo row survives).
    const composer = page.getByRole('combobox', { name: 'Message' });
    // Hold the adapter outcome until explicitly released: clearing must happen
    // with the optimistic row, and even an identical newly typed draft survives.
    for (const prefix of ['', '__fail_once ', '__outcome_unknown ']) {
      const body = `${prefix}delayed composer regression`;
      await page.evaluate(() => window.__timelineHarness.delayNextSend());
      await composer.fill(`${body}   `);
      await composer.press('Shift+Enter');
      assert.equal(await composer.inputValue(), `${body}   \n`, 'Shift+Enter inserts a newline');
      assert.equal(await page.locator('.timeline__row--pending').count(), 0, 'Shift+Enter does not submit');
      if (prefix === '__fail_once ') await page.getByRole('button', { name: 'Send' }).click();
      else await composer.press('Enter');
      await page.locator('.timeline__row--pending', { hasText: body }).waitFor();
      assert.equal(await composer.inputValue(), '', 'optimistic send clears before adapter outcome');
      await composer.fill(body);
      await composer.press('Enter');
      assert.equal(await page.locator('.timeline__row--pending').count(), 1, 'Enter cannot duplicate an unresolved send');
      assert.equal(await page.getByRole('button', { name: 'Send' }).isDisabled(), true);
      await page.evaluate(() => window.__timelineHarness.releaseDelayedSend());
      if (prefix) {
        await page.getByText(prefix === '__fail_once ' ? 'Not sent' : 'Delivery unknown').waitFor();
        assert.equal(await composer.inputValue(), body, 'late failure preserves newer draft');
        await composer.fill('different newer draft');
        await page.getByRole('button', { name: prefix === '__fail_once ' ? 'Retry' : 'Check delivery' }).click();
      }
      await page.locator('.timeline__row--pending', { hasText: body }).waitFor({ state: 'detached' });
      assert.equal(await composer.inputValue(), prefix ? 'different newer draft' : body, 'late reconciliation preserves newer draft, including identical bytes');
      assert.equal(await page.locator('.timeline__row', { hasText: body }).count(), 1, 'retry retains submitted body and transaction');
    }
    await composer.fill('a fresh reply from the browser test');
    await page.getByRole('button', { name: 'Send' }).click();
    await page.locator('.timeline__row', { hasText: 'a fresh reply from the browser test' }).first().waitFor();
    await page.locator('.timeline__row--pending', { hasText: 'a fresh reply from the browser test' }).waitFor({ state: 'detached' });
    assert.equal(await page.locator('.timeline__row', { hasText: 'a fresh reply from the browser test' }).count(), 1, 'exactly one row for the reconciled send');

    // Two deliberate sends with identical bytes have distinct transactions
    // and events. Neither may be collapsed by matching message content.
    await composer.fill('a deliberate repeat');
    await page.getByRole('button', { name: 'Send' }).click();
    await page.locator('.timeline__row--pending', { hasText: 'a deliberate repeat' }).waitFor({ state: 'detached' });
    await composer.fill('a deliberate repeat');
    await page.getByRole('button', { name: 'Send' }).click();
    await page.locator('.timeline__row--pending', { hasText: 'a deliberate repeat' }).waitFor({ state: 'detached' });
    assert.equal(await page.locator('.timeline__row', { hasText: 'a deliberate repeat' }).count(), 2);

    // Acknowledgment can precede sync. Two identical accepted sends must keep
    // separate local rows until each exact event arrives, without a txn ID.
    await composer.fill('__defer_sync repeated text');
    await page.getByRole('button', { name: 'Send' }).click();
    await page.locator('.timeline__row--pending + .kh-rcpt', { hasText: 'Delivered' }).waitFor();
    await composer.fill('__defer_sync repeated text');
    await page.getByRole('button', { name: 'Send' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.timeline__row--pending').length === 2);
    await page.evaluate(() => (window as unknown as { __timelineHarness: { releaseNextSend: () => void } }).__timelineHarness.releaseNextSend());
    await page.waitForFunction(() => document.querySelectorAll('.timeline__row--pending').length === 1);
    assert.equal(await page.locator('.timeline__row', { hasText: '__defer_sync repeated text' }).count(), 2,
      'the second accepted local echo survives the first identical event');
    await page.evaluate(() => (window as unknown as { __timelineHarness: { releaseNextSend: () => void } }).__timelineHarness.releaseNextSend());
    await page.waitForFunction(() => document.querySelectorAll('.timeline__row--pending').length === 0);
    assert.equal(await page.locator('.timeline__row:not(.timeline__row--pending)', { hasText: '__defer_sync repeated text' }).count(), 2);

    // Whitespace is trimmed in the send and cleared along with the draft.
    await composer.fill('a padded reply   ');
    await page.getByRole('button', { name: 'Send' }).click();
    await page.locator('.timeline__row--pending', { hasText: 'a padded reply' }).waitFor({ state: 'detached' });
    await page.waitForFunction(() => (document.querySelector('#kh-input') as HTMLTextAreaElement)?.value === '');
    assert.strictEqual(await composer.inputValue(), '', 'trailing whitespace clears with the submitted draft');

    // outcome_unknown resolves through the same transaction, not a fresh send.
    // The submitted body stays in the pending row until accepted, and
    // the row is labeled "Delivery unknown" — its own label, not just the
    // count of subsequent rows, is asserted here.
    await composer.fill('__outcome_unknown please confirm');
    await page.getByRole('button', { name: 'Send' }).click();
    await page.getByText('Delivery unknown').waitFor();
    assert.strictEqual(await composer.inputValue(), '', 'submitted text lives in the pending row while unresolved');
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

    // A definite failure shows "Not sent" with a Retry action that
    // resolves through the same transaction; the draft is not lost and a
    // second, independently pending send is not silently dropped by it.
    await composer.fill('__fail_once please retry');
    await page.getByRole('button', { name: 'Send' }).click();
    await page.getByText('Not sent').waitFor();
    // Send stays disabled for the same reason: only Retry (same clientTxnId)
    // may resolve a definite failure, never a fresh Send with new bytes.
    assert.equal(await page.getByRole('button', { name: 'Send' }).isDisabled(), true, 'Send is disabled while a send has failed');
    await page.getByRole('button', { name: 'Retry' }).click();
    await page.locator('.timeline__row--pending', { hasText: '__fail_once please retry' }).waitFor({ state: 'detached' });
    assert.equal(await page.locator('.timeline__row', { hasText: '__fail_once please retry' }).count(), 1, 'retrying a failed send does not duplicate the message');
    assert.equal(await page.getByText('Not sent').count(), 0, 'the failed row clears once the retry is accepted');
    await composer.fill('a new message once everything is resolved');
    assert.equal(await page.getByRole('button', { name: 'Send' }).isDisabled(), false, 'Send re-enables once every send is resolved');

    // Pagination preserves the reader's anchored event *within the scrollable
    // list* after prepending 20+ older rows. Measured relative to the list's
    // own bounding box, not the viewport: the list's page position may
    // change independently of anchor preservation.
    const anchorRow = page.locator('[data-event-id="recent_1"]');
    const list = page.locator('.timeline__list');
    const relativeTop = async () => {
      const [rowTop, listTop] = await Promise.all([
        anchorRow.evaluate(node => node.getBoundingClientRect().top),
        list.evaluate(node => node.getBoundingClientRect().top),
      ]);
      return rowTop - listTop;
    };
    assert.equal(await page.getByRole('button', { name: 'Load earlier messages' }).count(), 0);
    await page.evaluate(() => window.__timelineHarness.delayHistory());
    const callsBefore = await page.evaluate(() => window.__timelineHarness.historyCalls());
    await list.evaluate(node => { node.scrollTop = 80; });
    const beforeTop = await relativeTop();
    await list.evaluate(node => node.dispatchEvent(new Event('scroll')));
    await page.getByRole('status', { name: 'Loading earlier messages' }).waitFor();
    await list.evaluate(node => { for (let i = 0; i < 5; i++) node.dispatchEvent(new Event('scroll')); });
    assert.equal(await page.evaluate(() => window.__timelineHarness.historyCalls()), callsBefore + 1);
    await page.evaluate(() => window.__timelineHarness.releaseHistory());
    await page.getByText('Historical message 19').waitFor();
    await page.getByRole('status', { name: 'Loading earlier messages' }).waitFor({ state: 'detached' });
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
    const readsBeforeArrival = await page.evaluate(() => window.__timelineHarness.readEvents.length);
    await page.evaluate(() => window.__timelineHarness.pushLiveMessage('a live arrival while scrolled away'));
    await page.getByRole('button', { name: /new message/ }).waitFor();
    await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 400)));
    assert.equal(await list.evaluate(node => node.scrollTop), 0, 'another participant\'s arrival never moves a reader who scrolled away');
    assert.equal(await page.evaluate(() => window.__timelineHarness.readEvents.length), readsBeforeArrival, 'scrolled-up arrival remains unread');
    await page.getByRole('button', { name: /new message/ }).click();
    await page.waitForFunction(count => window.__timelineHarness.readEvents.length === count + 1, readsBeforeArrival);
    assert.equal(await page.getByRole('button', { name: /new message/ }).count(), 0, 'jump-to-latest clears the new-message count');
    assert.equal(await page.getByText('a live arrival while scrolled away').count(), 1);

    // The viewer's own send glides the list to its end, even from history and
    // with a multi-line composer; reduced motion lands there without the glide.
    const atEnd = () => list.evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight < 2);
    const sentRowVisible = (body: string) => page.locator('.timeline__row', { hasText: body }).last().evaluate(row => {
      const box = row.getBoundingClientRect();
      const frame = row.closest('.timeline__list')!.getBoundingClientRect();
      return box.top >= frame.top - 1 && box.bottom <= frame.bottom + 1;
    });
    for (const width of [1024, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await list.evaluate(node => { node.scrollTop = 0; });
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const body = `sent from history at ${width}`;
      await composer.fill(`${body}\nsecond line\nthird line`);
      await composer.press('Enter');
      await page.waitForFunction(() => {
        const node = document.querySelector('.timeline__list')!;
        return node.scrollHeight - node.scrollTop - node.clientHeight < 2;
      });
      await page.locator('.timeline__row--pending', { hasText: body }).waitFor({ state: 'detached' });
      await page.evaluate(() => new Promise(resolve => setTimeout(resolve, 400)));
      assert.equal(await atEnd(), true, `the list ends at the bottom after sending at ${width}`);
      assert.equal(await sentRowVisible(body), true, `the sent row is fully visible at ${width}`);
    }
    await page.setViewportSize({ width: 1024, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await list.evaluate(node => { node.scrollTop = 0; });
    await page.evaluate(() => window.__timelineHarness.delayNextSend());
    await composer.fill('sent with reduced motion');
    await composer.press('Enter');
    await page.locator('.timeline__row--pending', { hasText: 'sent with reduced motion' }).waitFor();
    assert.equal(await atEnd(), true, 'reduced motion jumps straight to the end');
    await page.evaluate(() => window.__timelineHarness.releaseDelayedSend());
    await page.locator('.timeline__row--pending', { hasText: 'sent with reduced motion' }).waitFor({ state: 'detached' });
    await page.emulateMedia({ reducedMotion: null });

    // Stick to bottom: a reader at (or within 80px of) latest stays pinned as
    // another participant's message arrives. A reader in history is never
    // moved; a fixed, centred pill counts the arrivals instead, and either
    // clicking it or scrolling down to latest hides it.
    const settle = (ms = 400) => page.evaluate(wait => new Promise(resolve => setTimeout(resolve, wait)), ms);
    const frames = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const pushLive = (body: string) => page.evaluate(text => window.__timelineHarness.pushLiveMessage(text), body);
    const scrollToOffset = async (fromEnd: number) => {
      await list.evaluate((node, offset) => { node.scrollTop = node.scrollHeight - node.clientHeight - offset; }, fromEnd);
      await frames();
    };
    const pill = page.locator('.timeline__jump-latest');
    for (const width of [1024, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      for (const offset of [0, 40]) {
        await scrollToOffset(offset);
        const body = `incoming while at latest (${offset}px) at ${width}`;
        await pushLive(body);
        await page.locator('.timeline__row', { hasText: body }).waitFor();
        await settle();
        assert.equal(await atEnd(), true, `an arrival keeps a reader ${offset}px from the end pinned at ${width}`);
        assert.equal(await sentRowVisible(body), true, `the arrival is fully visible at ${width}`);
        assert.equal(await pill.count(), 0, 'no pill while at latest');
        const eventId = await page.locator('.timeline__row', { hasText: body }).getAttribute('data-event-id');
        await page.waitForFunction(id => window.__timelineHarness.readEvents.includes(id!), eventId);
        assert.equal(await page.evaluate(id => window.__timelineHarness.readEvents.filter(event => event === id).length, eventId), 1, 'new arrival at latest is marked once');
      }

      if (width === 1024) {
        // Headless Chromium keeps tabs focused; emulate only the focus input.
        await page.evaluate(() => {
          Object.defineProperty(document, 'hasFocus', { configurable: true, value: Boolean.bind(null, false) });
          window.dispatchEvent(new Event('blur'));
        });
        const before = await page.evaluate(() => window.__timelineHarness.readEvents.length);
        await pushLive('arrived in an unfocused tab');
        await page.locator('.timeline__row', { hasText: 'arrived in an unfocused tab' }).waitFor();
        await settle();
        assert.equal(await page.evaluate(() => window.__timelineHarness.readEvents.length), before, 'unfocused tab stays unread');
        const eventId = await page.locator('.timeline__row', { hasText: 'arrived in an unfocused tab' }).getAttribute('data-event-id');
        await page.evaluate(() => {
          Reflect.deleteProperty(document, 'hasFocus');
          window.dispatchEvent(new Event('focus'));
        });
        await page.waitForFunction(id => window.__timelineHarness.readEvents.includes(id!), eventId);
        assert.equal(await page.evaluate(id => window.__timelineHarness.readEvents.filter(event => event === id).length, eventId), 1);
      }
      await scrollToOffset(300);
      const readingAt = await list.evaluate(node => node.scrollTop);
      await pushLive(`first arrival while reading at ${width}`);
      await pill.waitFor();
      assert.equal(await pill.textContent(), '1 new message');
      assert.equal(await pill.evaluate(button => button.parentElement?.getAttribute('aria-live')), 'polite');
      await pushLive(`second arrival while reading at ${width}`);
      await page.getByRole('button', { name: '2 new messages' }).waitFor();
      await settle();
      assert.equal(await list.evaluate(node => node.scrollTop), readingAt, `arrivals never move a reader in history at ${width}`);
      const pillBox = async () => {
        const [box, frame] = await Promise.all([pill.boundingBox(), list.boundingBox()]);
        return { centre: box!.x + box!.width / 2 - (frame!.x + frame!.width / 2), gap: frame!.y + frame!.height - (box!.y + box!.height) };
      };
      const placed = await pillBox();
      assert.ok(Math.abs(placed.centre) < 2 && placed.gap > 0 && placed.gap < 40, `pill is centred at the list's foot at ${width}: ${JSON.stringify(placed)}`);
      await scrollToOffset(250);
      assert.deepEqual(await pillBox(), placed, 'the pill does not scroll with the rows');
      await pill.click();
      assert.equal(await pill.count(), 0, 'clicking the pill hides it');
      await page.waitForFunction(() => {
        const node = document.querySelector('.timeline__list')!;
        return node.scrollHeight - node.scrollTop - node.clientHeight < 2;
      });

      await scrollToOffset(300);
      await pushLive(`arrival before a manual return at ${width}`);
      await pill.waitFor();
      await scrollToOffset(0);
      await pill.waitFor({ state: 'detached' });
    }
    await page.setViewportSize({ width: 1024, height: 900 });

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

// The §7 thread inside the Khala frame against the design capture: colour,
// type size, padding and corner radii must match `computed-styles.json`.
test('Thread rows match the 1440 dark design computed styles', { timeout: 90_000 }, async () => {
  const reference = JSON.parse(await readFile(join(here, '../../../../../docs/design/khala-chat/reference/computed-styles.json'), 'utf8')) as
    Record<string, Record<string, Record<string, string>>>;
  const outDir = await mkdtemp(join(tmpdir(), 'khala-thread-dist-'));
  const chromiumProfileRoot = await mkdtemp(join('/tmp', 'khala-thread-profile-'));
  let server: PreviewServer | undefined;
  let browser: Browser | undefined;
  try {
    const root = join(here, 'thread-harness');
    await build({ root, build: { outDir, emptyOutDir: true }, logLevel: 'error' });
    server = await preview({ root, build: { outDir }, preview: { host: '127.0.0.1', port: 0 } });
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
      headless: true,
      args: ['--no-sandbox'],
      env: { ...process.env, TMPDIR: chromiumProfileRoot },
    });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    await page.goto(server.resolvedUrls!.local[0]!);
    await page.locator('.kh-rcpt').waitFor();
    for (const selector of ['.kh-row:not(.me):not(.human) .kh-b', '.kh-row.me .kh-b', '.kh-name b', '.kh-rcpt']) {
      const want = reference['1440-dark']![selector]!;
      const got = await page.locator(selector).first().evaluate(node => {
        const style = getComputedStyle(node);
        return { color: style.color, 'font-size': style.fontSize, padding: style.padding, 'border-radius': style.borderRadius };
      });
      // Operator request 2026-10-04: an agent's name takes its owner's colour, so the first (agent) name reads in
      // the owner's hue rather than the design's per-agent hue; everything else still matches the design.
      const color = selector === '.kh-name b' ? await page.locator('.kh-row.agent').first().evaluate(row => {
        const probe = document.createElement('b');
        probe.style.color = `hsl(${(row as HTMLElement).style.getPropertyValue('--oh')} 75% 72%)`;
        row.append(probe);
        const value = getComputedStyle(probe).color;
        probe.remove();
        return value;
      }) : want['color'];
      assert.deepEqual(got, { color, 'font-size': want['font-size'], padding: want['padding'], 'border-radius': want['border-radius'] }, selector);
    }
    assert.equal(await page.locator('.kh-rcpt').count(), 1, 'one receipt');
    assert.equal(await page.locator('.kh-rcpt').textContent(), 'Not sent');
    assert.equal(await page.getByRole('button', { name: 'Retry' }).count(), 1);
    assert.equal(await page.locator('.kh-thread').evaluate(node => getComputedStyle(node).backgroundColor),
      reference['1440-dark']!['.kh-thread']!['background-color']);
  } finally {
    await browser?.close();
    if (server) await new Promise<void>(resolve => server!.httpServer!.close(() => resolve()));
    await rm(outDir, { recursive: true, force: true });
    await rm(chromiumProfileRoot, { recursive: true, force: true });
  }
});

// Chosen initials replace the derived ones on a human's avatar and on their
// agent's owner badge, and the viewer's own replace `YO`. `KHALA_SHOTS` keeps screenshots.
test('Thread rows show chosen initials on avatars and owner badges', { timeout: 90_000 }, async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'khala-thread-dist-'));
  const chromiumProfileRoot = await mkdtemp(join('/tmp', 'khala-thread-profile-'));
  let server: PreviewServer | undefined;
  let browser: Browser | undefined;
  try {
    const root = join(here, 'thread-harness');
    await build({ root, build: { outDir, emptyOutDir: true }, logLevel: 'error' });
    server = await preview({ root, build: { outDir }, preview: { host: '127.0.0.1', port: 0 } });
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
      headless: true,
      args: ['--no-sandbox'],
      env: { ...process.env, TMPDIR: chromiumProfileRoot },
    });
    for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
      for (const theme of ['dark', 'light']) {
        const page: Page = await browser.newPage({ viewport, reducedMotion: 'reduce' });
        await page.goto(`${server.resolvedUrls!.local[0]!}?initials&theme=${theme}`);
        await page.locator('.kh-rcpt').waitFor();
        const row = (eventId: string): Locator => page.locator(`[data-event-id="${eventId}"]`);
        // Maya's avatar and her agent's badge read her chosen `ZZ`; the viewer's agent reads the viewer's `KV`.
        assert.equal(await row('E3').locator('.kh-hav').textContent(), 'ZZ');
        assert.equal(await row('E5').locator('.kh-own').textContent(), 'ZZ');
        assert.equal(await row('E1').locator('.kh-own').textContent(), 'KV');
        if (process.env.KHALA_SHOTS) {
          await page.screenshot({ path: join(process.env.KHALA_SHOTS, `initials-thread-${viewport.width}-${theme}.png`) });
        }
        await page.close();
      }
    }
  } finally {
    await browser?.close();
    if (server) await new Promise<void>(resolve => server!.httpServer!.close(() => resolve()));
    await rm(outDir, { recursive: true, force: true });
    await rm(chromiumProfileRoot, { recursive: true, force: true });
  }
});
