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
const insideDialog = (page: Page) => page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')));

// Browser-verified against the production DecisionDialog with the pairing
// fixture adapter (see browser-harness/main.tsx): the same keyboard, focus,
// and status behavior the channel-access inbox relies on.
test('a pairing fixture runs through the shared decision shell', { timeout: 90_000 }, async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'khala-approval-decision-dist-'));
  const chromiumProfileRoot = await mkdtemp(join('/tmp', 'khala-approval-decision-profile-'));
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
    const page = await browser.newPage({ viewport: { width: 1024, height: 800 } });
    await page.goto(url);

    const opener = page.getByRole('button', { name: 'Review pairing' });
    await opener.focus();
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Pair this agent session with your channel?' });
    await dialog.waitFor();
    assert.equal(await insideDialog(page), true, 'focus moves into the dialog');
    await dialog.getByText('SHA256:pair-4Kd9').waitFor();
    for (let index = 0; index < 6; index += 1) {
      await page.keyboard.press('Tab');
      assert.equal(await insideDialog(page), true, `Tab ${index + 1} stays inside`);
    }
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    assert.equal(await opener.evaluate(node => node === document.activeElement), true, 'Escape returns focus to the opener');
    assert.deepEqual(await page.evaluate(() => window.__decisionHarness.decisions), [], 'dismissal decides nothing');

    await opener.click();
    await dialog.getByRole('button', { name: 'Approve pairing' }).click();
    await dialog.locator('[role="status"]').getByText('Pairing approved.').waitFor();
    assert.equal(await insideDialog(page), true, 'focus stays inside after the decision buttons go away');
    await dialog.getByRole('button', { name: 'Close' }).click();
    await dialog.waitFor({ state: 'detached' });
    assert.equal(await opener.evaluate(node => node === document.activeElement), true);
    assert.deepEqual(await page.evaluate(() => window.__decisionHarness.decisions), ['approve']);
  } finally {
    await browser?.close();
    if (server) await new Promise<void>(resolve => server!.httpServer!.close(() => resolve()));
    await rm(outDir, { recursive: true, force: true });
    await rm(chromiumProfileRoot, { recursive: true, force: true });
  }
});
