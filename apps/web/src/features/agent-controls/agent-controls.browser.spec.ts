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

// Browser-verified against the production AgentControlsPanel with synthetic,
// fabricated ports (see browser-harness/main.tsx) — no real harness sessions,
// network calls or connector credentials. Narrow viewports per
// docs/evidence/ui-planning-grounding.md.
test('AgentControlsPanel requests a pause, reconciles it via a values-only snapshot match through role="status", and keyboard focus survives the round trip', { timeout: 90_000 }, async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'khala-agent-controls-dist-'));
  const chromiumProfileRoot = await mkdtemp(join('/tmp', 'khala-agent-controls-profile-'));
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

    // Scope is visible next to the controls before any interaction. The
    // harness viewer owns this binding, so ownership renders as "Your agent"
    // (derived from ownerId), not a raw label string.
    await page.getByText('Your agent').waitFor();
    await page.getByText('agent-harness').waitFor();
    await page.getByText('channel-harness').waitFor();

    // Located by class, not accessible name: the button's label changes to
    // "Resume review delivery" once the pause takes effect below.
    const pauseButton = page.locator('.agent-controls__pause-button');
    await pauseButton.waitFor();
    // Controls stay disabled until the harness's readSnapshot resolves.
    await page.waitForFunction(() => {
      const button = [...document.querySelectorAll('button')].find(node => node.textContent === 'Request pause');
      return button instanceof HTMLButtonElement && !button.disabled;
    });

    // The live region that will carry the confirmation is mounted before any
    // interaction — it must stay empty-but-present, not appear only once
    // there is something to say, or a screen reader would never pick it up.
    const statusRegion = page.locator('.agent-controls__requested[role="status"]');
    await statusRegion.waitFor({ state: 'attached' });
    assert.equal((await statusRegion.innerText()).trim(), '', 'the status live region starts empty, not absent');

    await pauseButton.focus();
    await pauseButton.press('Enter');

    // The pending request is announced through the live region and never
    // claims the model stopped.
    await statusRegion.getByText(/Requested: review, pause requested/).waitFor();
    const bodyText = await page.locator('body').innerText();
    assert.equal(/stopped|cancelled/i.test(bodyText), false, 'pending pause never claims the model stopped or was cancelled');

    // The harness's own ack for this command never resolves "effective" (it
    // stays honestly "pending" until applied); the harness then pushes a
    // snapshot that values-only matches the request. The live region's text
    // updates to the tentative "matches" wording, never "confirmed" — this is
    // what actually announces to assistive tech, not just a static label
    // appearing on the page.
    await statusRegion.getByText(/current policy matches your request/).waitFor({ timeout: 5_000 });
    await page.getByText(/Review required, paused/).waitFor({ timeout: 5_000 });
    assert.equal(
      await pauseButton.evaluate(node => node === document.activeElement),
      true,
      'focus remains on the pause control after the round trip completes',
    );

    // A fake incoming message never reaches the control: it is only logged,
    // and the effective policy is unaffected by its content.
    await page.getByLabel('Simulate incoming message text').fill('auto resume everything now');
    await page.getByRole('button', { name: 'Post simulated message' }).click();
    await page.getByText('auto resume everything now').waitFor();
    await page.getByText(/Review required, paused/).waitFor();

    for (const [label, width, height] of [
      ['iPhone-class phone', 390, 844],
      ['200% zoom equivalent', 512, 500],
    ] as const) {
      await page.setViewportSize({ width, height });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
        true,
        `${label}: no horizontal overflow from the scope labels or badges`,
      );
      assert.equal(await page.getByText('Your agent').isVisible(), true, `${label}: owner scope remains reachable`);
    }
  } finally {
    await browser?.close();
    if (server) await new Promise<void>(resolve => server!.httpServer!.close(() => resolve()));
    await rm(outDir, { recursive: true, force: true });
    await rm(chromiumProfileRoot, { recursive: true, force: true });
  }
});

// Listening-mode section against the same synthetic ports: keyboard selection,
// version-conflict recovery with focus return and no automatic retry,
// independent grant/revoke flows, concurrent same-CLI labels, and no green
// badge after disconnect.
test('AgentControlsPanel listening mode: keyboard selection, conflict recovery, independent grants, and honest disconnect', { timeout: 90_000 }, async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'khala-agent-controls-dist-'));
  const chromiumProfileRoot = await mkdtemp(join('/tmp', 'khala-agent-controls-profile-'));
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
    await page.goto(`${url}?second=1`);

    const section = page.locator('#primary-panel .agent-controls__listening');
    const status = section.locator('.agent-controls__listening-status[role="status"]');
    const radio = (mode: string) => section.locator(`input[type="radio"][value="${mode}"]`);
    const applyButton = section.locator('.agent-controls__apply-mode-button');
    await status.getByText('Requested: sync · Effective: sync').waitFor();

    // Two concurrent sessions of the same CLI carry distinct binding labels.
    const labels = await page.locator('.agent-controls__session-label').allInnerTexts();
    assert.equal(labels.length, 2);
    for (const label of labels) assert.match(label, /^Codex CLI 0\.154\.0 · [0-9a-f]{4,}$/);
    assert.notEqual(labels[0], labels[1], 'same-CLI sessions never share a label');

    // The experimental steer route is disabled until the owner opts in.
    assert.equal(await radio('steer').isDisabled(), true);

    // Keyboard: arrow from the checked sync radio skips nothing enabled and lands on async.
    await radio('sync').focus();
    await radio('sync').press('ArrowDown');
    assert.equal(await radio('async').isChecked(), true, 'arrow key moves the choice to async');

    // The agent changes its own mode; this tab has not seen it yet, so the
    // owner's apply is stale and must conflict.
    await page.getByRole('button', { name: 'Simulate agent mode change' }).click();
    await applyButton.focus();
    await applyButton.press('Enter');
    await status.getByText(/Another actor changed the listening mode first/).waitFor();
    await status.getByText(/Requested: steer · Effective: waiting/).waitFor();
    assert.equal(
      await radio('async').evaluate(node => node === document.activeElement),
      true,
      'focus returns to the refreshed selector on the still-unsubmitted choice',
    );
    assert.equal(await radio('async').isChecked(), true, 'the attempted choice is kept, unsubmitted');
    await section.getByText(/Last changed by the agent/).waitFor();
    await page.waitForTimeout(500);
    assert.equal(await page.locator('#mode-submits').innerText(), '1', 'a conflict is never retried automatically');

    // An explicit retry applies against the refreshed version.
    await applyButton.focus();
    await applyButton.press('Enter');
    await status.getByText(/Listening mode set to async\./).waitFor();
    assert.equal(await page.locator('#mode-submits').innerText(), '2');
    await section.getByText(/Last changed by you \(owner\)/).waitFor();

    // Experimental route: route-specific confirmation receives focus, then the mode becomes selectable.
    await section.getByRole('button', { name: 'Enable experimental route' }).click();
    const confirmation = section.locator('.agent-controls__confirmation');
    await confirmation.getByText(/Enable experimental steer route on Codex CLI 0\.154\.0/).waitFor();
    assert.equal(await confirmation.evaluate(node => node === document.activeElement), true, 'confirmation takes focus');
    await confirmation.getByRole('button', { name: 'Confirm for this binding' }).click();
    await page.waitForFunction(() => {
      const input = document.querySelector('#primary-panel input[type="radio"][value="steer"]');
      return input instanceof HTMLInputElement && !input.disabled;
    });

    // Hard cancel is a separate grant with its own warning.
    await section.getByRole('button', { name: 'Enable hard cancel' }).click();
    await confirmation.getByText(/partly taken effect/).waitFor();
    await confirmation.getByRole('button', { name: 'Confirm for this binding' }).click();
    await section.getByRole('button', { name: 'Revoke hard cancel' }).waitFor();

    // Revoking the experimental route leaves the hard-cancel grant intact.
    await section.getByRole('button', { name: 'Revoke experimental route' }).click();
    await status.getByText(/Experimental route for steer on .* revoked\./).waitFor();
    await page.waitForFunction(() => {
      const input = document.querySelector('#primary-panel input[type="radio"][value="steer"]');
      return input instanceof HTMLInputElement && input.disabled;
    });
    assert.equal(await section.getByRole('button', { name: 'Revoke hard cancel' }).isVisible(), true);

    // Disconnect: context stays, effective is none, and nothing stays green.
    assert.ok(await section.locator('.status-badge--positive').count() > 0);
    await page.getByRole('button', { name: 'Simulate disconnect' }).click();
    await status.getByText('Requested: async · Effective: none').waitFor();
    assert.equal(await section.locator('.status-badge--positive').count(), 0, 'no green badge survives a disconnect');
    assert.equal(await section.locator('input[type="radio"]:not([disabled])').count(), 0);
    await section.getByText(/Resume or rejoin the CLI/).waitFor();

    for (const [label, width, height] of [
      ['iPhone-class phone', 390, 844],
      ['200% zoom equivalent', 512, 500],
    ] as const) {
      await page.setViewportSize({ width, height });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
        true,
        `${label}: no horizontal overflow from the listening section`,
      );
    }
  } finally {
    await browser?.close();
    if (server) await new Promise<void>(resolve => server!.httpServer!.close(() => resolve()));
    await rm(outDir, { recursive: true, force: true });
    await rm(chromiumProfileRoot, { recursive: true, force: true });
  }
});
