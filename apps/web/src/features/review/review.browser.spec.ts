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

// Real headless Chromium against the production ReviewScreen/controller,
// driven by a synthetic in-memory ReviewUiPort (no real network, credentials,
// owner authority or endpoints). Named `.browser.spec.ts` (not
// `.browser.test.ts`) to stay outside vitest's `*.test.{ts,tsx}` glob, same
// convention as `timeline.browser.spec.ts`.
test('Review renders full inert preview, keeps selection exact across arrivals, and shows truthful release/receipt feedback', { timeout: 90_000 }, async () => {
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
    const page = await browser.newPage({ viewport: { width: 1024, height: 900 } });
    await page.goto(url);
    await page.locator('section.review').waitFor();

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

    type ReviewHarness = { pushLiveArrival: (body: string) => void; revoke: () => void };

    // A live arrival during selection never joins it (R2) and does not steal focus.
    await page.evaluate(
      body => (window as unknown as { __reviewHarness: ReviewHarness }).__reviewHarness.pushLiveArrival(body),
      'a brand new pending message',
    );
    await page.getByText('a brand new pending message').waitFor();
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

    // A revoked facade clears preview and disables submission, and shows why (R4, AE2).
    await page.evaluate(() => window.__reviewHarness.revoke());
    await page.getByText('no longer have authority').waitFor();
    assert.equal(await page.getByRole('button', { name: /^Release/ }).isDisabled(), true, 'submission is disabled once access is revoked');
  } finally {
    await browser?.close();
    if (server) await new Promise<void>(resolve => server!.httpServer!.close(() => resolve()));
    await rm(outDir, { recursive: true, force: true });
    await rm(chromiumProfileRoot, { recursive: true, force: true });
  }
});
