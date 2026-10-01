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
  __trustCalls: () => number;
  __leaveRoom: () => void;
  __rerenderRoom: () => void;
  __releaseReplacementTrust: () => void;
  __switchReviewAccount: () => void;
  __releaseAccountTrust: () => void;
  __controlCommands: () => readonly PolicySetCommand[];
  __releaseOldStatus: () => void;
  __oldStatusReturned: () => boolean;
} }

test('normal conversation registers owner proof and trusts each admitted agent once', { timeout: 90_000 }, async () => {
  await withRoomPage('review-room.html?proof', async page => {
    const requests: string[] = [];
    const registrationBodies: unknown[] = [];
    await page.route('**/api/human/owner-device-proof/**', async route => {
      requests.push(new URL(route.request().url()).pathname);
      if (route.request().url().includes('/register')) registrationBodies.push(route.request().postDataJSON());
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(
        route.request().url().includes('/challenge') ? { v: 1, nonce: 'n'.repeat(43) } : { v: 1, kind: 'pinned' }) });
    });
    await page.reload();
    await page.waitForFunction(() => window.__trustCalls() === 2);
    assert.equal(await page.getByRole('heading', { name: 'Channel care' }).count(), 0);
    // StrictMode may start a challenge for a mount it immediately cancels.
    // Only completed registrations must be one per admitted agent.
    assert.ok(requests.filter(path => path.endsWith('/challenge')).length >= 2);
    assert.equal(requests.filter(path => path.endsWith('/register')).length, 2);
    assert.deepEqual(registrationBodies.map(body => (body as { matrixAccessToken: string }).matrixAccessToken),
      ['transient-token', 'transient-token']);
    assert.equal(requests.some(path => path.includes('transient-token')), false);
    const requestsBeforeRerender = requests.length;
    await page.evaluate(() => window.__rerenderRoom());
    await page.waitForTimeout(250);
    assert.equal(await page.evaluate(() => window.__trustCalls()), 2);
    assert.equal(requests.length, requestsBeforeRerender, 'rerender does not register again');
  });
});

test('leaving the normal conversation cancels proof before registration', { timeout: 90_000 }, async () => {
  await withRoomPage('review-room.html?proof', async page => {
    let releaseChallenge: (() => void) | undefined;
    const held = new Promise<void>(resolve => { releaseChallenge = resolve; });
    let challengeSeen: (() => void) | undefined;
    const seen = new Promise<void>(resolve => { challengeSeen = resolve; });
    let registerCount = 0;
    await page.route('**/api/human/owner-device-proof/**', async route => {
      if (route.request().url().includes('/challenge')) {
        challengeSeen?.();
        await held;
        try { await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ v: 1, nonce: 'n'.repeat(43) }) }); }
        catch { /* Aborted route. */ }
      } else { registerCount += 1; await route.fulfill({ status: 200, contentType: 'application/json', body: '{"v":1,"kind":"pinned"}' }); }
    });
    await page.reload();
    await seen;
    await page.evaluate(() => window.__leaveRoom());
    await page.getByText('Outside the channel').waitFor();
    releaseChallenge?.();
    await page.waitForTimeout(250);
    assert.equal(registerCount, 0);
    assert.equal(await page.evaluate(() => window.__trustCalls()), 0);
  });
});

test('created channel page has one share action that copies a working link', { timeout: 90_000 }, async () => {
  await withRoomPage('review-room.html', async page => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    const header = page.locator('.channel-toolbar__actions');
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

test('legacy direct route keeps recipient review and pause controls without conversation settings actions', { timeout: 90_000 }, async () => {
  await withRoomPage('review-room.html?tools', async page => {
    const care = page.getByRole('main', { name: 'Recipient review route' });
    await care.getByRole('heading', { name: 'Recipient review' }).first().waitFor();
    assert.equal(await care.getByRole('heading', { name: 'Recipient review' }).first().evaluate(node => node === document.activeElement), true);
    await care.getByRole('heading', { name: 'Recipient review' }).first().waitFor();
    assert.equal(await care.getByRole('heading', { name: 'Recovery and channel access' }).count(), 0);
    const screenshotDir = process.env.KHALA_SCREENSHOT_DIR;
    if (screenshotDir) {
      await mkdir(screenshotDir, { recursive: true });
      await page.screenshot({ path: join(screenshotDir, 'human-channel-care-desktop.png'), fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: join(screenshotDir, 'human-channel-care-mobile.png'), fullPage: true });
    }
  });
});

test('hosted selected conversation places one settings control beside Share', { timeout: 90_000 }, async () => {
  await withRoomPage('review-room.html?settings', async page => {
    const toolbar = page.locator('#khala-channel-toolbar');
    const settings = toolbar.locator('details.conversation-settings > summary');
    await settings.waitFor();
    assert.equal(await toolbar.locator('details.conversation-settings').count(), 1);
    assert.equal(await toolbar.locator('.channel-share').count(), 1);
    assert.equal(await page.locator('.khala-sidebar__channel-tools').count(), 0);
    assert.equal(await page.locator('.conversation-thread__head').count(), 0);
    await toolbar.locator('.channel-participants__chip[title="Agent · agent"]').waitFor();
    assert.equal(await toolbar.getByText('proof-key:abc123').count(), 0);
    assert.equal(await toolbar.getByText('Unavailable', { exact: true }).count(), 0);
    await settings.focus();
    await settings.press('Enter');
    await page.getByRole('heading', { name: 'Recovery and channel access' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Close channel' }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Delete conversation' }).count(), 0);
    await settings.press('Escape');
    assert.equal(await toolbar.locator('details.conversation-settings').getAttribute('open'), null);
    assert.equal(await settings.evaluate(node => document.activeElement === node), true);
    await settings.click();
    await page.getByRole('heading', { name: 'Recovery and channel access' }).waitFor();
    await page.locator('.conversation-thread').click({ position: { x: 20, y: 20 } });
    assert.equal(await toolbar.locator('details.conversation-settings').getAttribute('open'), null);
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await settings.isVisible(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await toolbar.locator('.channel-roster > summary').click();
    const agentDetail = toolbar.locator('.agent-presence__details').first();
    await agentDetail.locator('summary').click();
    assert.equal(await agentDetail.getByText('Connection unavailable').count(), 0);
    assert.equal(await agentDetail.getByText('proof-key:abc123').count(), 0);
    await toolbar.locator('.channel-roster > summary').click();
    await page.locator('[data-theme]').first().evaluate(node => node.setAttribute('data-theme', 'light'));
    await settings.click();
    await page.getByRole('heading', { name: 'Recovery and channel access' }).waitFor();
    await page.setViewportSize({ width: 320, height: 700 });
    assert.equal(await settings.isVisible(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  });
});

test('selected conversation exposes only pending recipient review and releases the sent event', { timeout: 90_000 }, async () => {
  await withRoomPage('review-room.html?selected-review', async page => {
    await page.evaluate(() => window.__allowReviewTrust());
    const review = page.locator('.recipient-review-disclosure');
    assert.equal(await review.isVisible(), false, 'zero pending adds no header action');
    const composer = page.getByRole('textbox', { name: 'Message' });
    await composer.fill('Message for my agent');
    await composer.press('Enter');
    await review.getByText('Review 1 pending').waitFor();
    const summary = review.locator('summary');
    await summary.focus();
    await summary.press('Enter');
    await summary.press('Escape');
    assert.equal(await review.getAttribute('open'), null);
    assert.equal(await summary.evaluate(node => node === document.activeElement), true);
    await summary.press('Enter');
    const row = review.getByRole('list', { name: 'Pending messages' }).getByText('Message for my agent');
    await row.waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true,
      'review fits the phone viewport');
    assert.equal(await review.locator('summary').isVisible(), true);
    await review.locator('[data-event-id] input[type="checkbox"]').check();
    assert.equal(await page.evaluate(() => window.__roomReviewCommand()), null, 'selection alone never releases');
    await review.getByRole('button', { name: 'Release 1 selected' }).click();
    await review.getByText('Released', { exact: true }).waitFor();
    const sent = await page.evaluate(() => window.__roomReviewCommand());
    assert.equal(sent?.bindingId, 'binding_1');
    assert.equal(sent?.expectedBindingGeneration, 0);
    assert.equal(sent?.selection.length, 1);
    await review.getByText('Recipient review', { exact: true }).waitFor();
    await review.locator('summary').press('Escape');
    assert.equal(await review.locator('summary').evaluate(node => node === document.activeElement), true);
    await page.keyboard.press('Tab');
    await review.waitFor({ state: 'hidden' });
  });
});

test('selected conversation queues one exact release from a known offline preview', { timeout: 90_000 }, async () => {
  await withRoomPage('review-room.html?selected-review&offline-review', async page => {
    await page.evaluate(() => window.__allowReviewTrust());
    const composer = page.getByRole('textbox', { name: 'Message' });
    await composer.fill('Message awaiting agent');
    await composer.press('Enter');
    const review = page.locator('.recipient-review-disclosure');
    await review.getByText('Review 1 pending').waitFor();
    await review.locator('summary').click();
    await review.getByText('Waiting for agent. Known pending messages remain available for review.').waitFor();
    await review.getByRole('list', { name: 'Pending messages' }).getByText('Message awaiting agent').waitFor();
    await review.locator('[data-event-id] input[type="checkbox"]').check();
    await review.getByRole('button', { name: 'Release 1 selected' }).click();
    await review.getByText('Release queued for agent').waitFor();
    const commands = await page.evaluate(() => window.__roomReviewCommands());
    assert.equal(commands.length, 1);
    assert.equal(commands[0]?.bindingId, 'binding_1');
    assert.equal(commands[0]?.expectedBindingGeneration, 0);
    assert.equal(commands[0]?.selection.length, 1);
    await page.waitForTimeout(300);
    assert.equal((await page.evaluate(() => window.__roomReviewCommands())).length, 1,
      'offline refresh must not retry the release');
  });
});

test('selected review separates two agents and clears on a room switch', { timeout: 90_000 }, async () => {
  await withRoomPage('review-room.html?selected-review&multi-review', async page => {
    await page.evaluate(() => window.__allowReviewTrust());
    const review = page.locator('.recipient-review-disclosure');
    await review.getByText('Review 1 pending').waitFor();
    const composer = page.getByRole('textbox', { name: 'Message' });
    await composer.fill('For the first agent only');
    await composer.press('Enter');
    await review.getByText('Review 2 pending').waitFor();
    await review.locator('summary').click();
    const sections = review.locator('.review');
    await sections.nth(1).waitFor();
    assert.equal(await sections.nth(0).getByText('For the first agent only').count(), 1);
    assert.equal(await sections.nth(1).getByText('For the first agent only').count(), 0);
    assert.equal(await sections.nth(0).getByText('Withheld A').count(), 0);
    assert.equal(await sections.nth(1).getByText('Withheld A').count(), 1);
    assert.equal(await sections.nth(1).getByText('To: agent_2').count(), 1);
    await sections.nth(1).locator('[data-event-id="event_a"] input[type="checkbox"]').check();
    await sections.nth(1).getByRole('button', { name: 'Release 1 selected' }).click();
    await sections.nth(1).getByText('Released', { exact: true }).waitFor();
    const command = await page.evaluate(() => window.__roomReviewCommand());
    assert.equal(command?.bindingId, 'binding_2');
    assert.deepEqual(command?.selection.map(ref => ref.eventId), ['event_a']);
    await review.getByText('Review 1 pending').waitFor();
    await page.evaluate(() => window.__switchReviewRoom());
    await page.getByRole('heading', { name: 'Other channel', level: 1 }).waitFor();
    assert.equal(await page.locator('.recipient-review-disclosure').count(), 0);
  });
});

test('unknown release keeps its reconciliation action after the pending queue clears', { timeout: 90_000 }, async () => {
  await withRoomPage('review-room.html?selected-review&unknown-review', async page => {
    await page.evaluate(() => window.__allowReviewTrust());
    const composer = page.getByRole('textbox', { name: 'Message' });
    await composer.fill('Review an uncertain release');
    await composer.press('Enter');
    const review = page.locator('.recipient-review-disclosure');
    await review.getByText('Review 1 pending').waitFor();
    await review.locator('summary').click();
    await review.locator('[data-event-id] input[type="checkbox"]').check();
    await review.getByRole('button', { name: 'Release 1 selected' }).click();
    await review.getByText('Release status unknown').waitFor();
    await review.locator('summary').press('Escape');
    await review.locator('summary').getByText('Check release status').waitFor();
    assert.equal((await page.evaluate(() => window.__roomReviewCommands())).length, 1,
      'an unknown outcome never triggers a second release automatically');
    await review.locator('summary').press('Enter');
    await review.getByRole('button', { name: 'Check release status' }).click();
    await review.getByText('Released', { exact: true }).waitFor();
    const commands = await page.evaluate(() => window.__roomReviewCommands());
    assert.equal(commands.length, 2);
    assert.deepEqual(commands[1], commands[0], 'reconciliation uses the exact original command');
  });
});

test('selected review follows a replacement binding generation', { timeout: 90_000 }, async () => {
  await withRoomPage('review-room.html?selected-review&race', async page => {
    await page.evaluate(() => window.__releaseOldTrust());
    const composer = page.getByRole('textbox', { name: 'Message' });
    await composer.fill('Message for replacement agent');
    await composer.press('Enter');
    const review = page.locator('.recipient-review-disclosure');
    await review.getByText('Review 1 pending').waitFor();
    await page.evaluate(() => window.__setReviewBinding('new'));
    await review.locator('summary').click();
    await review.getByText('To: New agent').waitFor();
    assert.equal(await review.getByText('To: agent_1').count(), 0);
    await review.locator('[data-event-id] input[type="checkbox"]').check();
    await review.getByRole('button', { name: 'Release 1 selected' }).click();
    await review.getByText('Released', { exact: true }).waitFor();
    const command = await page.evaluate(() => window.__roomReviewCommand());
    assert.equal(command?.bindingId, 'binding_1');
    assert.equal(command?.expectedBindingGeneration, 1);
  });
});

test('invited human cannot see another owner’s recipient review', { timeout: 90_000 }, async () => {
  await withRoomPage('review-room.html?selected-review&invited-review', async page => {
    await page.evaluate(() => window.__allowReviewTrust());
    const composer = page.getByRole('textbox', { name: 'Message' });
    await composer.fill('A peer message');
    await composer.press('Enter');
    await page.locator('.timeline').getByText('A peer message').waitFor();
    assert.equal(await page.locator('.recipient-review-disclosure').count(), 0);
    assert.equal(await page.getByRole('heading', { name: 'Pending release' }).count(), 0);
  });
});

test('owner review stays available when the participant roster is temporarily unavailable', { timeout: 90_000 }, async () => {
  await withRoomPage('review-room.html?selected-review&roster-failure', async page => {
    await page.evaluate(() => window.__allowReviewTrust());
    const composer = page.getByRole('textbox', { name: 'Message' });
    await composer.fill('Review despite roster outage');
    await composer.press('Enter');
    const review = page.locator('.recipient-review-disclosure');
    await review.getByText('Review 1 pending').waitFor();
    await review.locator('summary').click();
    await review.getByRole('list', { name: 'Pending messages' }).getByText('Review despite roster outage').waitFor();
  });
});

for (const failure of ['unavailable', 'denied'] as const) {
  test(`share offers a keyboard-selectable link when clipboard is ${failure}`, { timeout: 90_000 }, async () => {
    await withRoomPage('review-room.html', async page => {
      await page.evaluate(kind => Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: kind === 'unavailable' ? undefined : { writeText: Function('return Promise.reject(new DOMException("Denied", "NotAllowedError"))') },
      }), failure);
      const header = page.locator('.channel-toolbar__actions');
      const before = await header.boundingBox();
      assert.equal(await page.getByRole('textbox', { name: 'Channel link', exact: true }).count(), 0);
      const button = page.getByRole('button', { name: 'Copy channel invite link' });
      await button.focus();
      await page.keyboard.press('Enter');
      await page.getByRole('alert').getByText('Copy failed. Select and copy the link below.').waitFor();
      const input = page.getByRole('textbox', { name: 'Channel link', exact: true });
      assert.equal(await input.inputValue(), 'https://khala.example/join/invite_1');
      assert.equal(await input.evaluate(node => node === document.activeElement), true);
      assert.deepEqual(await input.evaluate(node => [(node as HTMLInputElement).selectionStart, (node as HTMLInputElement).selectionEnd]), [0, 'https://khala.example/join/invite_1'.length]);
      assert.equal((await header.boundingBox())?.height, before?.height, 'manual copying does not resize the header');
      await page.keyboard.press('Shift+Tab');
      assert.equal(await button.evaluate(node => node === document.activeElement), true);
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      const box = await input.boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= 390, 'manual link stays within the phone viewport');
      await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: Function('return Promise.resolve()') } }));
      await button.press('Enter');
      await page.getByRole('status').getByText('Copied').waitFor();
      assert.equal(await input.count(), 0, 'successful retry removes the fallback');
      assert.equal((await page.evaluate(() => window.__shareRequests())).length, 1, 'retry uses the same link');
    });
  });
}

async function withRoomPage(path: string, run: (page: Page) => Promise<void>, beforeNavigate?: (page: Page) => Promise<void>): Promise<void> {
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
    await beforeNavigate?.(page);
    await page.goto(server.resolvedUrls!.local[0]! + path);
    await run(page);
  } finally {
    await browser?.close();
    if (server) await new Promise<void>(resolve => server!.httpServer!.close(() => resolve()));
    await rm(scratch, { recursive: true, force: true });
    await rm(chromiumProfileRoot, { recursive: true, force: true });
  }
}

test('conversation identity timing fixture', { timeout: 90_000 }, async () => {
  await withRoomPage('review-room.html?identity-timing', async page => {
    const title = page.locator('.channel-roster summary').getByText('Test channel');
    await title.waitFor();
    const titleMs = await page.evaluate(() => performance.now());
    await page.locator('.channel-participants__chip[title*="agent"]').waitFor();
    const connectionMs = await page.evaluate(() => performance.now());
    await page.locator('.channel-participants__chip').getByText('Verified agent').waitFor();
    await page.locator('.channel-participants__chip').getByText('Peer owner').waitFor();
    const nameMs = await page.evaluate(() => performance.now());
    console.log('identity timing ms', JSON.stringify({ title: Math.round(titleMs), connection: Math.round(connectionMs), name: Math.round(nameMs) }));
    assert.ok(titleMs < nameMs);
  }, async page => {
    await page.route('**/api/fixture/participants', async route => {
      await new Promise(resolve => setTimeout(resolve, 250));
      await route.fulfill({ status: 200, body: '{}' });
    });
    await page.route('**/api/fixture/history', async route => {
      await new Promise(resolve => setTimeout(resolve, 800));
      await route.fulfill({ status: 200, body: '{}' });
    });
  });
});

test('conversation agent controls wait for the selected owner binding and verified device', { timeout: 90_000 }, async () => {
  await withRoomPage('review-room.html?identity-timing&controls=1', async page => {
    await page.locator('.channel-roster > summary').click();
    const agent = page.locator('.agent-presence__details').first();
    await agent.locator('summary').click();
    await agent.getByText('Verify this agent’s session to choose a listening mode.').waitFor();
    for (const mode of ['steer', 'sync', 'async']) assert.equal(await agent.locator(`input[type="radio"][value="${mode}"]`).isDisabled(), true);
    await page.evaluate(() => window.__allowReviewTrust());
    await agent.locator('.agent-controls__compact').waitFor();
    await agent.getByRole('heading', { name: 'Listening mode' }).waitFor();
    await agent.getByText('This agent has not confirmed mode support. Check its connection and try again.').waitFor();
    for (const mode of ['steer', 'sync', 'async']) assert.equal(await agent.locator(`input[type="radio"][value="${mode}"]`).isDisabled(), true);
    assert.equal(await agent.getByRole('button', { name: 'Apply listening mode' }).count(), 0);
    assert.equal(await agent.getByRole('button', { name: 'Edit name for Renamed agent' }).count(), 1);
  }, async page => {
    await page.route('**/api/fixture/participants', route => route.fulfill({ status: 200, body: '{}' }));
    await page.route('**/api/fixture/history', route => route.fulfill({ status: 200, body: '{}' }));
  });
});

test('hosted conversation uses one stable top row and an accessible title disclosure', { timeout: 90_000 }, async () => {
  await withRoomPage('review-room.html?identity-timing', async page => {
    const title = page.locator('.channel-roster > summary');
    const row = page.locator('.khala-content-actions');
    await title.getByText('Test channel').waitFor();
    const composer = page.getByRole('textbox', { name: 'Message' });
    await composer.waitFor();
    const before = await composer.boundingBox();
    await page.locator('.channel-participants__chip').getByText('Verified agent').waitFor();
    const after = await composer.boundingBox();
    assert.equal(after?.y, before?.y, 'identity updates do not move the composer');
    await page.locator('.channel-participants__chip').getByText('Renamed agent').waitFor();
    assert.equal((await composer.boundingBox())?.y, before?.y, 'fresh name history does not move the composer');
    assert.equal(await page.locator('.conversation-thread__head').count(), 0);
    assert.equal(await page.locator('.channel-roster > summary').count(), 1);
    assert.equal(await page.getByRole('button', { name: 'Copy channel invite link' }).count(), 1);
    await title.focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('.channel-roster[open]').count(), 1);
    assert.equal(await page.locator('.channel-roster__panel').getByText('Peer owner').count(), 1);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.channel-roster[open]').count(), 0);
    assert.equal(await title.evaluate(node => document.activeElement === node), true);
    await page.keyboard.press('Space');
    assert.equal(await page.locator('.channel-roster[open]').count(), 1);
    await composer.click();
    assert.equal(await page.locator('.channel-roster[open]').count(), 0);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 844 });
      const titleBox = await title.boundingBox();
      const rowBox = await row.boundingBox();
      assert.ok(titleBox && rowBox && titleBox.y >= rowBox.y && titleBox.y < rowBox.y + rowBox.height);
      assert.equal(await page.locator('.khala-mobile-bar').count(), 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    }
  }, identityFixtureRoutes);
});

test('late participant evidence cannot cross an account switch or leave', { timeout: 90_000 }, async () => {
  await withRoomPage('review-room.html?identity-timing', async page => {
    await page.locator('.channel-roster > summary').waitFor();
    await page.evaluate(() => window.__switchReviewAccount());
    await page.getByText('Other verified agent').waitFor();
    await page.waitForTimeout(300);
    assert.equal(await page.getByText('Verified agent', { exact: true }).count(), 0);
    await page.evaluate(() => window.__leaveRoom());
    await page.getByText('Outside the channel').waitFor();
    assert.equal(await page.locator('.channel-roster').count(), 0);
  }, identityFixtureRoutes);
});

test('title deletion confirms owner-view closure once; unauthorized owners cannot invoke it', { timeout: 90_000 }, async () => {
  await withRoomPage('review-room.html?identity-timing', async page => {
    await page.locator('.channel-roster > summary').click();
    const action = page.getByRole('button', { name: 'Delete conversation' });
    await action.waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('.recovery-panel__closure-action > button')?.disabled);
    await action.click();
    await page.getByRole('heading', { name: 'Close this conversation?' }).waitFor();
    assert.equal(await page.getByText('Copies already delivered to participants or models cannot be recalled.').count(), 1);
    assert.deepEqual(await page.evaluate(() => window.__closureCalls()), []);
    await page.getByRole('textbox', { name: 'Message' }).click();
    await page.locator('.recovery-panel__confirmation').waitFor({ state: 'detached' });
    await page.locator('.channel-roster > summary').click();
    assert.equal(await page.getByRole('button', { name: 'Confirm channel closure' }).count(), 0,
      'outside close requires a new Delete conversation click');
    await action.click();
    await page.getByRole('button', { name: 'Confirm channel closure' }).waitFor();
    await page.keyboard.press('Escape');
    await page.locator('.recovery-panel__confirmation').waitFor({ state: 'detached' });
    await page.locator('.channel-roster > summary').click();
    assert.equal(await page.getByRole('button', { name: 'Confirm channel closure' }).count(), 0,
      'Escape requires a new Delete conversation click');
    assert.deepEqual(await page.evaluate(() => window.__closureCalls()), []);
    await action.click();
    await page.getByRole('button', { name: 'Cancel' }).click();
    await page.waitForFunction(() => document.activeElement?.textContent === 'Delete conversation');
    assert.equal(await action.evaluate(node => document.activeElement === node), true);
    assert.deepEqual(await page.evaluate(() => window.__closureCalls()), []);
    await action.click();
    await page.getByRole('button', { name: 'Confirm channel closure' }).click();
    await page.waitForFunction(() => window.__closureCalls().length === 1);
    assert.deepEqual(await page.evaluate(() => window.__navigations()), ['/conversations']);
  }, identityFixtureRoutes);
  await withRoomPage('review-room.html?identity-timing&closure-denied', async page => {
    await page.locator('.channel-roster > summary').click();
    const action = page.getByRole('button', { name: 'Delete conversation' });
    await action.waitFor({ state: 'visible' });
    assert.equal(await action.isDisabled(), true);
    assert.deepEqual(await page.evaluate(() => window.__closureCalls()), []);
  }, identityFixtureRoutes);
  await withRoomPage('review-room.html?identity-timing&closure-unknown', async page => {
    await page.locator('.channel-roster > summary').click();
    const action = page.getByRole('button', { name: 'Delete conversation' });
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('.recovery-panel__closure-action > button')?.disabled);
    await action.click();
    await page.getByRole('button', { name: 'Confirm channel closure' }).click();
    await page.getByText('Closure outcome unknown').waitFor();
    assert.deepEqual(await page.evaluate(() => window.__navigations()), []);
    assert.equal((await page.evaluate(() => window.__closureCalls())).length, 1);
    assert.equal(await page.getByRole('button', { name: 'Inspect operation' }).count(), 1);
  }, identityFixtureRoutes);
});

async function identityFixtureRoutes(page: Page): Promise<void> {
  await page.route('**/api/fixture/participants', async route => {
    await new Promise(resolve => setTimeout(resolve, 250));
    await route.fulfill({ status: 200, body: '{}' });
  });
  await page.route('**/api/fixture/history', async route => {
    await new Promise(resolve => setTimeout(resolve, 800));
    await route.fulfill({ status: 200, body: '{}' });
  });
}

test('mounted human room reviews only the selected event for its active binding', { timeout: 90_000 }, async () => {
  await withRoomPage('review-room.html', async page => {
    const care = page.getByRole('complementary', { name: 'Channel care route' });
    await care.getByText('Waiting for verified agent device trust.').waitFor();
    assert.equal(await care.getByRole('list', { name: 'Pending messages' }).count(), 0);
    await page.evaluate(() => window.__allowReviewTrust());
    await care.getByRole('list', { name: 'Pending messages' }).getByText('Withheld A').waitFor();
    await care.getByRole('list', { name: 'Pending messages' }).getByText('Approved B').waitFor();
    await care.locator('[data-event-id="event_b"] input[type="checkbox"]').check();
    await care.getByRole('button', { name: 'Release 1 selected' }).click();
    await care.getByText('Released', { exact: true }).waitFor();
    const sent = await page.evaluate(() => window.__roomReviewCommand());
    assert.equal(sent?.bindingId, 'binding_1');
    assert.deepEqual(sent?.selection.map(value => value.eventId), ['event_b']);
    assert.equal(await care.getByRole('list', { name: 'Pending messages' }).getByText('Withheld A').count(), 1);
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
    const care = page.getByRole('complementary', { name: 'Channel care route' });
    await care.getByText('Waiting for verified agent device trust.').waitFor();
    await page.evaluate(() => window.__setReviewBinding('new'));
    await care.getByText('To: New agent').waitFor();
    await page.evaluate(() => window.__releaseOldTrust());
    await page.waitForFunction(() => window.__oldTrustReturned());
    assert.equal(await care.getByText('To: Old agent').count(), 0);
    assert.equal(await care.getByText('To: New agent').count(), 1);

    // A participant replacement under the same binding/generation/device must
    // lose the prior trust cache entry and wait for its own verification.
    await page.evaluate(() => window.__setReviewBinding('replacement'));
    await care.getByText('Waiting for verified agent device trust.').waitFor();
    assert.equal(await care.getByText('To: New agent').count(), 0);
    await page.evaluate(() => window.__releaseReplacementTrust());
    await care.getByText('To: Replaced identity').waitFor();

    // Route/account replacement discards the old route lease and trust cache.
    await page.evaluate(() => window.__switchReviewAccount());
    await care.getByText('Waiting for verified agent device trust.').waitFor();
    assert.equal(await care.getByText('To: Replaced identity').count(), 0);
    await page.evaluate(() => window.__releaseAccountTrust());
    await care.getByText('To: Other account agent').waitFor();
  });
});

test('an older binding lookup cannot restore its recipient after a newer lookup', { timeout: 90_000 }, async () => {
  await withRoomPage('review-room.html?race=1&lookup=1', async page => {
    const care = page.getByRole('complementary', { name: 'Channel care route' });
    await page.waitForFunction(() => window.__reviewLookupCount() >= 1);
    await page.evaluate(() => window.__setReviewBinding('new'));
    await care.getByText('To: New agent').waitFor();
    await page.evaluate(() => window.__releaseOldLookup());
    await page.waitForFunction(() => window.__oldLookupReturned());
    assert.equal(await care.getByText('To: Old agent').count(), 0);
    assert.equal(await care.getByText('To: New agent').count(), 1);
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
