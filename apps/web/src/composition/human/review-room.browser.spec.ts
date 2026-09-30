import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { build, preview, type PreviewServer } from 'vite';
import { chromium, type Browser, type Page } from '@playwright/test';
import type { ApprovalCommand, PolicySetCommand } from '@khala/contracts/delivery/index';

declare global { interface Window {
  __shareRequests: () => readonly { roomId: string; policy: { kind: string; email?: string } }[];
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

test('created channel page has one share action that copies a working link', { timeout: 90_000 }, async () => {
  await withRoomPage('review-room.html', async page => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    const header = page.locator('.conversation-thread__actions');
    const before = await header.boundingBox();
    assert.ok(before);
    assert.equal(await header.getByText('Test channel').count(), 0);
    assert.equal(await header.locator('input, .channel-share__hint').count(), 0);
    await page.getByRole('button', { name: 'Copy channel invite link' }).click();
    await page.getByRole('status').getByText('Copied').waitFor();
    const after = await header.boundingBox();
    assert.equal(after?.height, before.height, 'copy feedback does not resize the header');
    assert.equal(await header.locator('input, .channel-share__hint').count(), 0);
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'https://khala.example/join/invite_1');
    assert.equal(await page.locator('.channel-share button').count(), 1);
    assert.equal(await page.locator('.channel-share__more').count(), 0);
    assert.deepEqual(await page.evaluate(() => window.__shareRequests()), [
      { roomId: 'room_1', policy: { v: 1, kind: 'link', history: 'none' } },
    ]);
    const screenshotDir = process.env.KHALA_SCREENSHOT_DIR;
    if (screenshotDir) {
      await mkdir(screenshotDir, { recursive: true });
      for (const theme of ['dark', 'light']) {
        await page.locator('[data-theme]').first().evaluate((element, value) => element.setAttribute('data-theme', value), theme);
        await page.screenshot({ path: join(screenshotDir, `channel-header-${theme}-desktop.png`) });
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await header.locator('input, .channel-share__hint').count(), 0);
    if (screenshotDir) {
      for (const theme of ['dark', 'light']) {
        await page.locator('[data-theme]').first().evaluate((element, value) => element.setAttribute('data-theme', value), theme);
        await page.screenshot({ path: join(screenshotDir, `channel-header-${theme}-phone.png`) });
      }
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true,
      'room sharing stays within the phone viewport');
  });
});

test('channel care route mounts recipient review and recovery outside the chat', { timeout: 90_000 }, async () => {
  await withRoomPage('review-room.html?tools', async page => {
    const care = page.getByRole('main', { name: 'Channel care route' });
    await care.getByRole('heading', { name: 'Channel care' }).waitFor();
    assert.equal(await care.getByRole('heading', { name: 'Channel care' }).evaluate(node => node === document.activeElement), true);
    await care.getByRole('heading', { name: 'Recipient review' }).waitFor();
    await care.getByRole('heading', { name: 'Recovery and channel access' }).waitFor();
    assert.equal(await page.locator('.conversation-thread__actions').getByRole('button', { name: 'Channel settings' }).count(), 0);
    const screenshotDir = process.env.KHALA_SCREENSHOT_DIR;
    if (screenshotDir) {
      await mkdir(screenshotDir, { recursive: true });
      await page.screenshot({ path: join(screenshotDir, 'human-channel-care-desktop.png'), fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: join(screenshotDir, 'human-channel-care-mobile.png'), fullPage: true });
    }
  });
});

test('share reports clipboard denial without exposing the link', { timeout: 90_000 }, async () => {
  await withRoomPage('review-room.html', async page => {
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined }));
    await page.getByRole('button', { name: 'Copy channel invite link' }).click();
    await page.getByRole('alert').getByText('Copy failed. Try again.').waitFor();
    assert.equal(await page.locator('.channel-share input').count(), 0);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  });
});

async function withRoomPage(path: string, run: (page: Page) => Promise<void>): Promise<void> {
  const scratch = await mkdtemp(join(process.env.TMPDIR ?? '/tmp', 'khala-review-room-'));
  const chromiumProfileRoot = await mkdtemp(join('/tmp', 'khala-review-room-profile-'));
  let server: PreviewServer | null = null;
  let browser: Browser | null = null;
  try {
    await build({ root: join(import.meta.dirname, 'browser-harness'),
      build: { outDir: join(scratch, 'dist'), emptyOutDir: true, rollupOptions: { input: join(import.meta.dirname, 'browser-harness/review-room.html') } },
      logLevel: 'error' });
    server = await preview({ root: join(import.meta.dirname, 'browser-harness'),
      build: { outDir: join(scratch, 'dist') }, preview: { host: '127.0.0.1', port: 0 } });
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
      headless: true, args: ['--no-sandbox'], env: { ...process.env, TMPDIR: chromiumProfileRoot } });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(server.resolvedUrls!.local[0]! + path);
    await run(page);
  } finally {
    await browser?.close();
    if (server) await new Promise<void>(resolve => server!.httpServer!.close(() => resolve()));
    await rm(scratch, { recursive: true, force: true });
    await rm(chromiumProfileRoot, { recursive: true, force: true });
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

test('mounted human room restores an in-flight send after reload and reconciles one row', { timeout: 90_000 }, async () => {
  await withRoomPage('review-room.html', async page => {
    await page.getByRole('textbox', { name: 'Message' }).fill('__reload_pending room send');
    await page.getByRole('button', { name: 'Send' }).click();
    await page.locator('.timeline__row--pending', { hasText: '__reload_pending room send' }).getByText('Sending…').waitFor();
    const transaction = await page.evaluate(() => sessionStorage.getItem('khala.test.send.pending-txn'));
    assert.ok(transaction);
    await page.reload();
    const restored = page.locator('.timeline__row--pending', { hasText: '__reload_pending room send' });
    await restored.getByText('Delivery unknown').waitFor();
    await restored.getByRole('button', { name: 'Check delivery' }).click();
    await page.locator('.timeline__row:not(.timeline__row--pending)', { hasText: '__reload_pending room send' }).waitFor();
    assert.equal(await page.locator('.timeline__row', { hasText: '__reload_pending room send' }).count(), 1);
    assert.equal(await page.evaluate(() => sessionStorage.getItem('khala.test.send.pending-txn')), transaction);
    await page.reload();
    await page.locator('.timeline__row:not(.timeline__row--pending)', { hasText: '__reload_pending room send' }).waitFor();
    assert.equal(await page.locator('.timeline__row', { hasText: '__reload_pending room send' }).count(), 1);
  });
});

test('mounted human room keeps one confirmed message after reload', { timeout: 90_000 }, async () => {
  await withRoomPage('review-room.html', async page => {
    await page.getByRole('textbox', { name: 'Message' }).fill('confirmed before reload');
    await page.getByRole('button', { name: 'Send' }).click();
    await page.locator('.timeline__row:not(.timeline__row--pending)', { hasText: 'confirmed before reload' }).waitFor();
    assert.equal(await page.locator('.timeline__row', { hasText: 'confirmed before reload' }).count(), 1);
    await page.reload();
    await page.locator('.timeline__row:not(.timeline__row--pending)', { hasText: 'confirmed before reload' }).waitFor();
    assert.equal(await page.locator('.timeline__row', { hasText: 'confirmed before reload' }).count(), 1);
  });
});

test('mounted human room reconciles an acknowledged send after reload when sync omits its transaction', { timeout: 90_000 }, async () => {
  await withRoomPage('review-room.html', async page => {
    await page.getByRole('textbox', { name: 'Message' }).fill('__defer_sync acknowledged before reload');
    await page.getByRole('button', { name: 'Send' }).click();
    await page.locator('.timeline__row--pending', { hasText: '__defer_sync acknowledged before reload' }).getByText('Sent').waitFor();
    await page.waitForFunction(() => Object.keys(sessionStorage).some(key => key.startsWith('khala.pending-send.v2:')
      && sessionStorage.getItem(key)?.includes('eventId')));
    await page.reload();
    await page.locator('.timeline__row:not(.timeline__row--pending)', { hasText: '__defer_sync acknowledged before reload' }).waitFor();
    await page.locator('.timeline__row--pending', { hasText: '__defer_sync acknowledged before reload' }).waitFor({ state: 'detached' });
    assert.equal(await page.locator('.timeline__row', { hasText: '__defer_sync acknowledged before reload' }).count(), 1);
  });
});

test('replacement device cannot see or retry the prior device pending send', { timeout: 90_000 }, async () => {
  await withRoomPage('review-room.html', async page => {
    await page.getByRole('textbox', { name: 'Message' }).fill('__reload_pending prior device');
    await page.getByRole('button', { name: 'Send' }).click();
    await page.locator('.timeline__row--pending', { hasText: '__reload_pending prior device' }).getByText('Sending…').waitFor();
    await page.evaluate(() => window.__switchReviewDevice());
    await page.locator('.timeline__row--pending', { hasText: '__reload_pending prior device' }).waitFor({ state: 'detached' });
    assert.equal(await page.getByRole('button', { name: 'Check delivery' }).count(), 0);
    await page.getByRole('textbox', { name: 'Message' }).fill('new device draft');
    assert.equal(await page.getByRole('button', { name: 'Send' }).isDisabled(), false);
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
