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

// Browser-verified against the production CreateChannelScreen with synthetic,
// fabricated ports (see browser-harness/main.tsx) — no real Matrix credentials,
// network calls or decrypted content. Narrow viewports per
// docs/evidence/ui-planning-grounding.md.
test('CreateChannelScreen completes an unnamed channel with two intros and keeps submit/copy reachable at narrow viewports', { timeout: 90_000 }, async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'khala-create-channel-dist-'));
  const chromiumProfileRoot = await mkdtemp(join('/tmp', 'khala-create-channel-profile-'));
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

    // Title is optional and every field carries a real accessible name.
    const titleField = page.getByLabel('Channel name (optional)');
    await titleField.waitFor();
    await titleField.focus();

    // The non-default choice is carried through the screen and controller to
    // the injected admission implementation without translation.
    await page.getByLabel('Anyone with the link can read messages sent before they joined').check();

    // Add two introduction messages, in order.
    const addIntro = page.getByRole('button', { name: 'Add introduction message' });
    await addIntro.click();
    await page.getByLabel('Message 1').fill('Hello there.');
    await addIntro.click();
    await page.getByLabel('Message 2').fill('Second message.');

    // Move-up on the first row and move-down on the last row are disabled.
    assert.equal(await page.getByRole('button', { name: 'Move message 1 up' }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Move message 2 down' }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Move message 1 down' }).isDisabled(), false);

    // Removing the first row moves focus to the remaining row's remove control, not to the void.
    await page.getByRole('button', { name: 'Remove message 1' }).click();
    await page.getByLabel('Message 1').waitFor();
    assert.equal(await page.getByLabel('Message 1').inputValue(), 'Second message.');
    assert.equal(
      await page.getByRole('button', { name: 'Remove message 1' }).evaluate(node => node === document.activeElement),
      true,
      'focus lands on the remaining row after removing a neighbor',
    );

    // Restore two messages for the full flow.
    await addIntro.click();
    await page.getByLabel('Message 2').fill('Third message.');

    const submit = page.getByRole('button', { name: 'Create channel' });
    await submit.waitFor();
    await page.waitForFunction(() => {
      const button = [...document.querySelectorAll('button')].find(node => node.textContent === 'Create channel');
      return button instanceof HTMLButtonElement && !button.disabled;
    });
    await submit.click();

    // Busy phases announce progress and the form is no longer editable.
    await page.getByText('Creating the channel…').waitFor();
    assert.equal(await titleField.isDisabled(), true);

    // The share link appears once the operation journal reaches "ready".
    const shareUrlField = page.getByLabel('Channel link');
    await shareUrlField.waitFor({ timeout: 10_000 });
    assert.equal(await shareUrlField.inputValue(), 'https://khala.aiur.team/i/harness');
    assert.equal(await page.locator('#policy-log').textContent(), JSON.stringify({ v: 1, kind: 'link', history: 'full' }));

    const copyButton = page.getByRole('button', { name: 'Copy link' });
    await copyButton.click();
    await page.getByText('Link copied.').waitFor();
    assert.equal(await page.locator('#copy-log').innerText(), 'https://khala.aiur.team/i/harness');

    for (const [label, width, height] of [
      ['iPhone-class phone', 390, 844],
      ['200% zoom equivalent', 512, 500],
    ] as const) {
      await page.setViewportSize({ width, height });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
        true,
        `${label}: no horizontal overflow from the share URL or panel`,
      );
      assert.equal(await shareUrlField.isVisible(), true, `${label}: share field remains reachable`);
      assert.equal(await copyButton.isVisible(), true, `${label}: copy control remains reachable`);
    }

    // Simulating a sign-out swaps the injected ports; the previous controller's
    // share link must not linger under the new (signed-out) session.
    await page.setViewportSize({ width: 1024, height: 900 });
    await page.getByRole('button', { name: 'Simulate sign-out' }).click();
    await page.getByText('Sign in to create a channel.').waitFor();
    assert.equal(await page.getByLabel('Channel link').count(), 0, 'the prior share link is cleared, not left stale, after a session change');
  } finally {
    await browser?.close();
    if (server) await new Promise<void>(resolve => server!.httpServer!.close(() => resolve()));
    await rm(outDir, { recursive: true, force: true });
    await rm(chromiumProfileRoot, { recursive: true, force: true });
  }
});

test('CreateChannelScreen signed out at mount blocks submission with a reason and no stray share link', { timeout: 90_000 }, async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'khala-create-channel-dist-'));
  const chromiumProfileRoot = await mkdtemp(join('/tmp', 'khala-create-channel-profile-'));
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
    await page.goto(`${url}?mode=signed-out`);

    await page.getByText('Sign in to create a channel.').waitFor();
    assert.equal(await page.getByRole('button', { name: 'Create channel' }).isDisabled(), true, 'submit stays disabled while signed out');
    assert.equal(await page.getByLabel('Channel link').count(), 0, 'no share link leaks while signed out');
  } finally {
    await browser?.close();
    if (server) await new Promise<void>(resolve => server!.httpServer!.close(() => resolve()));
    await rm(outDir, { recursive: true, force: true });
    await rm(chromiumProfileRoot, { recursive: true, force: true });
  }
});
