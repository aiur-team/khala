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

// Browser-verified against the production PairingApproval panel: the opener,
// focus return, and the panel's own live region.
test('the pairing panel opens, restores focus, and announces the decision', { timeout: 90_000 }, async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'khala-pairing-dist-'));
  const chromiumProfileRoot = await mkdtemp(join('/tmp', 'khala-pairing-profile-'));
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

    const panelStatus = page.locator('.pairing__status');
    assert.equal(await panelStatus.getAttribute('role'), 'status');

    const opener = page.getByRole('button', { name: 'Review pairing' });
    const dialog = page.getByRole('dialog', { name: 'Pair this agent session with your channel?' });
    const focusedOpenerOrHeading = () => page.evaluate(() => {
      const active = document.activeElement;
      return active?.matches('.pairing__heading') === true || active?.matches('.pairing > button') === true;
    });

    await opener.focus();
    await page.keyboard.press('Enter');
    await dialog.waitFor();
    assert.equal(await panelStatus.getAttribute('aria-live'), 'off', 'the open dialog is the only live region');
    assert.match(await dialog.innerText(), /Expires\s+\w{3} \d{1,2}, \d{4}, \d{1,2}:\d{2}\s[AP]M/, 'expiry reads as a time');

    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    assert.equal(await focusedOpenerOrHeading(), true, 'Escape returns focus to the opener or heading');
    assert.equal(await panelStatus.getAttribute('aria-live'), 'polite');

    await opener.click();
    await dialog.getByRole('button', { name: 'Approve pairing' }).click();
    await dialog.getByRole('button', { name: 'Close' }).click();
    await dialog.waitFor({ state: 'detached' });
    assert.equal(await focusedOpenerOrHeading(), true, 'Close returns focus to the opener or heading');
    await panelStatus.getByText('Pairing approved.').waitFor();
    assert.deepEqual(await page.evaluate(() => window.__pairingHarness.decisions), ['approve']);
  } finally {
    await browser?.close();
    if (server) await new Promise<void>(resolve => server!.httpServer!.close(() => resolve()));
    await rm(outDir, { recursive: true, force: true });
    await rm(chromiumProfileRoot, { recursive: true, force: true });
  }
});
