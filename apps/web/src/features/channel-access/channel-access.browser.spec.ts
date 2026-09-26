import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { build, preview, type PreviewServer } from 'vite';
import { chromium, type Browser, type Page } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const harnessRoot = join(here, 'browser-harness');

type Input = { kind: 'access' | 'create'; title: string; fingerprint: string; displayLabel?: string | null; workspaceLabel?: string | null };
const submit = (page: Page, input: Input) => page.evaluate(i => window.__channelAccessHarness.submit(i)!, input);
const activeId = (page: Page) => page.evaluate(() => document.activeElement?.id ?? document.activeElement?.tagName ?? '');
const dialogCount = (page: Page) => page.locator('[role="dialog"]').count();
const insideDialog = (page: Page) => page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')));
const row = (page: Page, handle: string) => page.locator(`[id="channel-request-${handle}"]`);

async function smallestTarget(page: Page, scope: string): Promise<{ width: number; height: number; name: string }> {
  return page.evaluate(selector => {
    let smallest = { width: Infinity, height: Infinity, name: '' };
    for (const element of document.querySelectorAll<HTMLElement>(`${selector} button, ${selector} a[href]`)) {
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      if (Math.min(box.width, box.height) < Math.min(smallest.width, smallest.height)) {
        smallest = { width: box.width, height: box.height, name: element.textContent ?? '' };
      }
    }
    return smallest;
  }, scope);
}

// Browser-verified against the production ChannelRequestsInbox and
// ChannelRequestsNavEntry with the in-memory journal from fakes.ts (see
// browser-harness/main.tsx): no network calls, credentials, or real channels.
test('channel requests stay in the inbox, never auto-open, and keep focus where the owner put it', { timeout: 120_000 }, async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'khala-channel-access-dist-'));
  const chromiumProfileRoot = await mkdtemp(join('/tmp', 'khala-channel-access-profile-'));
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
    await page.goto(url);

    const status = page.locator('.channel-requests__status[role="status"]');
    const nav = page.getByRole('link', { name: /Channel requests/ });
    await page.getByText('Waiting for you (0)').waitFor();
    assert.equal(await nav.getAttribute('href'), '#/channel-requests');
    await nav.getByText(', 0 pending').waitFor({ state: 'attached' });

    // Wrong-implementation test (RD4B): enqueue two requests. Neither opens
    // on arrival, and closing the first never opens the second or moves focus to it.
    const first = await submit(page, { kind: 'access', title: 'Release planning', fingerprint: 'agent-one', displayLabel: 'build bot' });
    const second = await submit(page, { kind: 'access', title: 'Release planning', fingerprint: 'agent-two', displayLabel: 'build bot', workspaceLabel: 'Verified: ~/src/khala' });
    await page.getByText('Waiting for you (2)').waitFor();
    await nav.getByText(', 2 pending').waitFor({ state: 'attached' });
    assert.equal(await dialogCount(page), 0, 'queued requests never auto-open');
    assert.equal(await page.locator('.channel-requests__notice').count(), 2, 'each request raises a non-modal notice');
    assert.equal(await page.evaluate(() => document.activeElement === document.body), true, 'arrivals do not take focus');

    const firstReview = row(page, first).getByRole('button', { name: 'Review request' });
    await firstReview.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Let this agent session join “Release planning”?' });
    await dialog.waitFor();
    assert.equal(await insideDialog(page), true, 'focus moves into the dialog');
    for (let index = 0; index < 8; index += 1) {
      await page.keyboard.press('Tab');
      assert.equal(await insideDialog(page), true, `Tab ${index + 1} stays inside the dialog`);
    }
    await page.keyboard.press('Shift+Tab');
    assert.equal(await insideDialog(page), true, 'Shift+Tab stays inside the dialog');
    await dialog.getByRole('button', { name: 'Approve access' }).click();
    await dialog.locator('.decision-dialog__status').getByText(/^Approved\./).waitFor();
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    await page.waitForTimeout(400);
    assert.equal(await dialogCount(page), 0, 'the second request never auto-opens after the first closes');
    assert.equal(await activeId(page), `channel-request-${first}`, 'focus returns to the decided request, not the next one');
    await nav.getByText(', 1 pending').waitFor({ state: 'attached' });
    await row(page, first).getByText('Waiting for the agent’s connector to pick up your approval').waitFor();

    // Dismissing without deciding returns focus to the opener, and the row stays pending.
    const secondReview = row(page, second).getByRole('button', { name: 'Review request' });
    await secondReview.click();
    await page.getByRole('dialog').waitFor();
    await page.getByText('Workspace (unverified)').waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    assert.equal(await secondReview.evaluate(node => node === document.activeElement), true, 'focus returns to the opener');
    await page.getByText('Waiting for you (1)').waitFor();

    // Notification selection and direct navigation reach the same row, without opening it.
    const third = await submit(page, { kind: 'create', title: 'Scratch room', fingerprint: 'agent-three' });
    const thirdNotice = page.locator('.channel-requests__notice').last();
    await thirdNotice.getByText('New channel request').waitFor();
    await page.locator('.channel-requests__notice').first().getByRole('button', { name: 'Dismiss notification' }).click();
    await page.locator('.channel-requests__notice').first().getByRole('button', { name: 'Dismiss notification' }).click();
    await page.locator('.channel-requests__notice').getByRole('button', { name: 'Show in inbox' }).click();
    assert.equal(await activeId(page), `channel-request-${third}`, 'the notice lands on its row');
    assert.equal(await dialogCount(page), 0);
    await secondReview.focus();
    await page.evaluate(handle => { window.location.hash = `#/channel-requests/${handle}`; }, third);
    await page.waitForFunction(id => document.activeElement?.id === id, `channel-request-${third}`);
    assert.equal(await dialogCount(page), 0, 'direct navigation does not open the request either');

    // A retryable failure keeps the dialog and its facts, announces, and retries the same operation.
    await page.evaluate(() => window.__channelAccessHarness.failNextDecide('unavailable'));
    await row(page, third).getByRole('button', { name: 'Review request' }).click();
    const createDialog = page.getByRole('dialog', { name: 'Create a secret channel for this agent session?' });
    await createDialog.waitFor();
    await createDialog.getByText('Approving creates exactly one secret channel and authorizes admission only for the requesting session.', { exact: false }).waitFor();
    await createDialog.getByRole('button', { name: 'Approve and create' }).click();
    await createDialog.locator('[role="alert"]').getByText(/Could not confirm your decision/).waitFor();
    assert.equal(await createDialog.getByText('Session fingerprint').count(), 1, 'the safe projection is still shown');
    await createDialog.getByRole('button', { name: 'Retry: Approve and create' }).click();
    await createDialog.locator('.decision-dialog__status').getByText(/^Approved\./).waitFor();
    const operations = await page.evaluate(() => window.__channelAccessHarness.decideOperations().slice(-2));
    assert.equal(operations[0], operations[1], 'the retry reuses the operation ID');
    await page.keyboard.press('Escape');
    await createDialog.waitFor({ state: 'detached' });

    // Mute is operation-specific and announced.
    await row(page, second).getByRole('button', { name: 'Mute this agent’s requests for this channel' }).click();
    await status.getByText('Muted. This agent’s new requests for this channel will not reach you.').waitFor();

    // Connector readiness is shown apart from the owner's decision.
    await page.evaluate(handle => { window.__channelAccessHarness.advance(handle, 'repair_required'); window.__channelAccessHarness.refresh(); }, first);
    await row(page, first).getByText('Repair required on the agent’s connector').waitFor();
    await row(page, first).getByText('Approved', { exact: true }).waitFor();

    // Narrow layout: collapsed-menu access, single column, scrollable details, sticky actions, 44px targets.
    for (const [label, width, height] of [
      ['iPhone-class phone', 390, 600],
      ['200% zoom equivalent', 512, 480],
    ] as const) {
      await page.setViewportSize({ width, height });
      assert.equal(await nav.isVisible(), false, `${label}: the entry is behind the collapsed menu`);
      await page.getByRole('button', { name: 'Menu' }).click();
      await nav.waitFor();
      const navBox = (await nav.boundingBox())!;
      assert.ok(navBox.height >= 44, `${label}: nav entry is at least 44px tall`);
      await page.getByRole('button', { name: 'Menu' }).click();
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
        true,
        `${label}: no horizontal overflow`,
      );
      const target = await smallestTarget(page, '.channel-requests__list');
      assert.ok(target.width >= 44 && target.height >= 44, `${label}: row target "${target.name}" is ${target.width}x${target.height}`);

      await row(page, second).getByRole('button', { name: 'Review request' }).click();
      const narrow = page.getByRole('dialog');
      await narrow.waitFor();
      const body = narrow.locator('.decision-dialog__body');
      assert.equal(await body.evaluate(node => getComputedStyle(node).overflowY), 'auto', `${label}: details scroll`);
      assert.equal(await body.evaluate(node => node.scrollHeight > node.clientHeight), true, `${label}: details overflow into a scroll area`);
      const approve = narrow.getByRole('button', { name: 'Approve access' });
      const box = (await approve.boundingBox())!;
      assert.ok(box.y + box.height <= height, `${label}: the actions stay on screen`);
      const dialogTarget = await smallestTarget(page, '[role="dialog"]');
      assert.ok(dialogTarget.width >= 44 && dialogTarget.height >= 44, `${label}: dialog target "${dialogTarget.name}" is ${dialogTarget.width}x${dialogTarget.height}`);
      await page.keyboard.press('Escape');
      await narrow.waitFor({ state: 'detached' });
    }

    // Lost authority: a binding or discovery capability cannot decide.
    await page.setViewportSize({ width: 1024, height: 900 });
    await page.evaluate(() => window.__channelAccessHarness.setCaller('binding_capability'));
    await row(page, second).getByRole('button', { name: 'Review request' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Approve access' }).click();
    await page.getByRole('dialog').getByText('You can no longer decide this request.', { exact: false }).waitFor();
    assert.equal(await page.getByRole('dialog').getByRole('button', { name: 'Approve access' }).count(), 0);
  } finally {
    await browser?.close();
    if (server) await new Promise<void>(resolve => server!.httpServer!.close(() => resolve()));
    await rm(outDir, { recursive: true, force: true });
    await rm(chromiumProfileRoot, { recursive: true, force: true });
  }
});
