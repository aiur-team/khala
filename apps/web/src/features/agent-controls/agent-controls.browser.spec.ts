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
    await page.getByText('room-harness').waitFor();

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
