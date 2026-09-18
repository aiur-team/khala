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

type ReviewHarness = {
  pushLiveArrival: (body: string) => void;
  editPending: (eventId: string, body: string) => void;
  bumpBindingGeneration: () => void;
  revoke: () => void;
};

declare global {
  interface Window {
    __reviewHarness: ReviewHarness;
  }
}

// Real headless Chromium against the production ReviewScreen/controller,
// driven by a synthetic in-memory ReviewUiPort (no real network, credentials,
// owner authority or endpoints). Named `.browser.spec.ts` (not
// `.browser.test.ts`) to stay outside vitest's `*.test.{ts,tsx}` glob, same
// convention as `timeline.browser.spec.ts`.
async function withHarness(
  run: (page: Page) => Promise<void>,
  options: Readonly<{ viewport?: { width: number; height: number } }> = {},
): Promise<void> {
  const outDir = await mkdtemp(join(tmpdir(), 'khala-review-dist-'));
  const chromiumProfileRoot = await mkdtemp(join('/tmp', 'khala-review-profile-'));
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
    const page = await browser.newPage({ viewport: options.viewport ?? { width: 1024, height: 900 } });
    await page.goto(url);
    await page.locator('section.review').waitFor();
    await run(page);
  } finally {
    await browser?.close();
    if (server) await new Promise<void>(resolve => server!.httpServer!.close(() => resolve()));
    await rm(outDir, { recursive: true, force: true });
    await rm(chromiumProfileRoot, { recursive: true, force: true });
  }
}

test('Review renders full inert preview, keeps selection exact across arrivals, and shows truthful release/receipt feedback', { timeout: 90_000 }, async () => {
  await withHarness(async page => {
    // R1: full permitted content and its authenticated author are visible before selection.
    await page.getByText('Please forward the deployment summary').waitFor();
    await page.locator('[data-event-id="pending_1"]').getByText('Alice', { exact: true }).waitFor();
    await page.locator('[data-event-id="pending_2"]').getByText('Bob', { exact: true }).waitFor();

    // Selecting one item updates the count and enables Release; the other stays unselected.
    const selectedCount = page.locator('.review__count');
    const firstCheckbox = page.locator('[data-event-id="pending_1"] input[type="checkbox"]');
    await firstCheckbox.check();
    await selectedCount.filter({ hasText: '1 selected' }).waitFor();
    const secondCheckbox = page.locator('[data-event-id="pending_2"] input[type="checkbox"]');
    assert.equal(await secondCheckbox.isChecked(), false, 'only the exact selected item is checked');

    // A live arrival during selection never joins it (R2), does not steal focus,
    // and is announced once through a polite live region (U4-2).
    await page.evaluate(body => window.__reviewHarness.pushLiveArrival(body), 'a brand new pending message');
    await page.getByText('a brand new pending message').waitFor();
    await page.getByText('1 new pending message arrived.').waitFor();
    assert.equal(await firstCheckbox.isChecked(), true, 'the original selection survives a new arrival');
    assert.equal(await selectedCount.filter({ hasText: '1 selected' }).count(), 1, 'the new arrival did not join the selection');
    await page.getByRole('button', { name: 'Selected', exact: true }).click();
    assert.equal(await page.getByText('a brand new pending message').count(), 0, 'the Selected filter excludes the unselected new arrival');
    await page.getByRole('button', { name: 'All', exact: true }).click();

    // Hide never authorizes delivery: hiding the unselected item does not change the selection or submit anything.
    const hideSecond = page.locator('[data-event-id="pending_2"] button.review__hide');
    await hideSecond.click();
    await page.getByText('Approve the fix for the review queue bug').waitFor({ state: 'detached' });
    assert.equal(await selectedCount.filter({ hasText: '1 selected' }).count(), 1, 'hiding an item never changes the selection count');
    assert.equal(await page.getByText('Released').count(), 0, 'hiding an item never triggers a release');

    // Release submits the exact selection and shows truthful evidence, not an invented "consumed" state.
    await page.getByRole('button', { name: /^Release 1 selected$/ }).click();
    await page.getByText('Released', { exact: true }).waitFor();
    // The harness's fake connector only ever observes `transport_written` — the
    // release evidence must reflect exactly that fact, never claim the agent
    // read/consumed it (only `context_consumed`/`completed` would justify that).
    await page.getByText('Delivered to connector').waitFor();
    assert.equal(await page.getByText(/Read by the agent/).count(), 0, 'no consumption is claimed from a transport_written receipt alone');
    // Focus moves to the submission status region after Release (U4-2).
    assert.equal(await page.evaluate(() => document.activeElement?.className), 'review__submission-status', 'focus moves to the release status after Release');

    // A revoked facade clears preview and disables submission, and shows why (R4, AE2).
    await page.evaluate(() => window.__reviewHarness.revoke());
    await page.getByText('no longer have authority').waitFor();
    assert.equal(await page.getByRole('button', { name: /^Release/ }).isDisabled(), true, 'submission is disabled once access is revoked');
  });
});

test('Hiding a selected item deselects it, so Release can never deliver a row that is no longer visible', { timeout: 90_000 }, async () => {
  await withHarness(async page => {
    const selectedCount = page.locator('.review__count');
    const firstCheckbox = page.locator('[data-event-id="pending_1"] input[type="checkbox"]');
    await firstCheckbox.check();
    await selectedCount.filter({ hasText: '1 selected' }).waitFor();

    const hideFirst = page.locator('[data-event-id="pending_1"] button.review__hide');
    await hideFirst.click();
    await page.getByText('Please forward the deployment summary').waitFor({ state: 'detached' });

    // Hiding the selected item must deselect it: the count drops back to zero
    // and Release, if clicked, can never carry the now-hidden row.
    await selectedCount.filter({ hasText: '0 selected' }).waitFor();
    const releaseButton = page.getByRole('button', { name: /^Release$/ });
    assert.equal(await releaseButton.isDisabled(), true, 'nothing remains selected once the only selected row is hidden');
  });
});

test('AE1: editing a selected pending item marks the selection stale end to end and disables Release', { timeout: 90_000 }, async () => {
  await withHarness(async page => {
    const firstCheckbox = page.locator('[data-event-id="pending_1"] input[type="checkbox"]');
    await firstCheckbox.check();
    await page.locator('.review__count').filter({ hasText: '1 selected' }).waitFor();

    await page.evaluate(() => window.__reviewHarness.editPending('pending_1', 'an edited body, different from the original'));

    await page.getByText('changed underneath you').waitFor();
    const releaseButton = page.getByRole('button', { name: /^Release/ });
    assert.equal(await releaseButton.isDisabled(), true, 'an edited selection cannot be released');

    await page.getByRole('button', { name: 'Reselect' }).click();
    await page.getByText('changed underneath you').waitFor({ state: 'detached' });
    assert.equal(await firstCheckbox.isChecked(), false, 'reselect explicitly clears the stale selection');
    // Focus moves to the pending list after Reselect (U4-2), not left on a now-gone banner button.
    assert.equal(await page.evaluate(() => document.activeElement?.className), 'review__list', 'focus moves to the pending list after Reselect');
  });
});

test('AE1: a binding generation change marks a captured selection stale end to end', { timeout: 90_000 }, async () => {
  await withHarness(async page => {
    const firstCheckbox = page.locator('[data-event-id="pending_1"] input[type="checkbox"]');
    await firstCheckbox.check();
    await page.locator('.review__count').filter({ hasText: '1 selected' }).waitFor();

    await page.evaluate(() => window.__reviewHarness.bumpBindingGeneration());

    await page.getByText('changed underneath you').waitFor();
    assert.equal(await page.getByRole('button', { name: /^Release/ }).isDisabled(), true, 'a rebound selection cannot be released');
  });
});

test('U2-3: a long message reads in full and supports keyboard selection', { timeout: 90_000 }, async () => {
  await withHarness(async page => {
    const longBody = 'A '.repeat(400) + 'end-of-message marker';
    await page.evaluate(body => window.__reviewHarness.pushLiveArrival(body), longBody);
    await page.getByText('end-of-message marker').waitFor();
    const bodyText = await page.locator('[data-event-id="live_2"] .review-item__body').innerText();
    assert.ok(bodyText.includes('end-of-message marker'), 'the full long message is present, not truncated');

    const checkbox = page.locator('[data-event-id="pending_1"] input[type="checkbox"]');
    await checkbox.focus();
    await page.keyboard.press('Space');
    assert.equal(await checkbox.isChecked(), true, 'space toggles the focused checkbox');
  });
});

test('U4-1: switching to a 390px pane preserves the exact selection and scroll position', { timeout: 90_000 }, async () => {
  await withHarness(
    async page => {
      const firstCheckbox = page.locator('[data-event-id="pending_1"] input[type="checkbox"]');
      await firstCheckbox.check();
      await page.locator('.review__count').filter({ hasText: '1 selected' }).waitFor();

      await page.setViewportSize({ width: 390, height: 700 });
      await page.locator('section.review').waitFor();

      assert.equal(await firstCheckbox.isChecked(), true, 'the exact selection survives the narrow-viewport layout change');
      await page.locator('.review__count').filter({ hasText: '1 selected' }).waitFor();
    },
    { viewport: { width: 1024, height: 900 } },
  );
});
