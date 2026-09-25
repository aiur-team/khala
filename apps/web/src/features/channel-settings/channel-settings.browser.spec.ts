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

const OTHER_OWNER_SESSION = { ownerId: 'owner-b', principal: 'principal-peer' };
const OWN_SESSION = { ownerId: 'owner-a', principal: 'principal-own' };

const listFor = (page: Page, requester: { ownerId: string; principal: string }) =>
  page.evaluate(r => window.__channelSettingsHarness.listFor(r).length, requester);

// Browser-verified against the production ChannelSettingsPanel with the
// in-memory catalog from fakes.ts (see browser-harness/main.tsx): no
// network calls, credentials, or real channels.
test('ChannelSettingsPanel keeps a dismissed increase secret, confirms increases by keyboard, and announces every outcome', { timeout: 90_000 }, async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'khala-channel-settings-dist-'));
  const chromiumProfileRoot = await mkdtemp(join('/tmp', 'khala-channel-settings-profile-'));
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

    const status = page.locator('.channel-settings__status[role="status"]');
    await status.waitFor({ state: 'attached' });
    await page.getByText('Currently Secret').waitFor();
    assert.equal(await page.getByRole('radio', { name: /Secret/ }).isChecked(), true, 'a new external channel is secret');

    // Wrong-implementation test (RD3A): select public by keyboard, dismiss
    // the confirmation with Escape, and the channel stays secret and absent
    // from another eligible session's listing.
    const secret = page.getByRole('radio', { name: /Secret/ });
    await secret.focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.getByRole('radio', { name: /Public/ }).isChecked(), true);
    await page.locator('.channel-settings__projection').getByText('public').waitFor();
    await page.getByRole('button', { name: 'Save visibility' }).press('Enter');
    const dialog = page.getByRole('alertdialog', { name: 'Make this channel public?' });
    await dialog.waitFor();
    assert.equal(
      await page.getByRole('button', { name: 'Keep secret' }).evaluate(node => node === document.activeElement),
      true,
      'focus starts on the keep-current choice',
    );
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => window.__channelSettingsHarness.setVisibilityCalls()), 0, 'dismissal sends nothing');
    assert.equal(await secret.isChecked(), true, 'the draft returns to secret');
    assert.equal(await secret.evaluate(node => node === document.activeElement), true, 'focus returns to the selected visibility');
    assert.equal(await listFor(page, OTHER_OWNER_SESSION), 0, 'another eligible session still lists nothing');
    await page.getByText('Currently Secret').waitFor();

    // Confirmed increase to private, entirely by keyboard, announced through the live region.
    await secret.focus();
    await page.keyboard.press('ArrowDown');
    await page.getByRole('button', { name: 'Save visibility' }).press('Enter');
    await page.getByRole('alertdialog', { name: 'Make this channel private?' }).waitFor();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    await status.getByText('Saving: changing visibility to private…').waitFor();
    assert.equal(await page.getByRole('radio', { name: /Private/ }).isDisabled(), true, 'controls lock while submitting');
    await status.getByText('Saved. This channel is now private.').waitFor();
    assert.equal(await listFor(page, OWN_SESSION), 1, 'the owner’s own session can list a private channel');
    assert.equal(await listFor(page, OTHER_OWNER_SESSION), 0, 'an unallowed agent still cannot');

    // The picker leads with verified fingerprints and never offers free-text search.
    assert.equal(await page.locator('input[type="search"], [role="searchbox"], [role="combobox"]').count(), 0);
    await page.getByText('Your agent (trusted)').waitFor();
    await page.getByRole('button', { name: 'Allow agent SHA256:peer-9Xb1' }).click();
    await status.getByText('Saved. Agent SHA256:peer-9Xb1 can now see this channel’s listing.').waitFor();
    assert.equal(await listFor(page, OTHER_OWNER_SESSION), 1, 'the allowed agent can now list it');

    // A retryable failure keeps the pending edit and never claims success.
    await page.evaluate(() => window.__channelSettingsHarness.failNext('unavailable'));
    await page.getByRole('button', { name: 'Remove agent SHA256:peer-9Xb1' }).click();
    const retryAlert = page.locator('.channel-settings__retry[role="alert"]');
    await retryAlert.getByText(/Nothing was saved\. Your change is still pending\./).waitFor();
    assert.equal(await listFor(page, OTHER_OWNER_SESSION), 1, 'the failed revoke did not apply');
    await retryAlert.getByRole('button', { name: 'Retry' }).click();
    await status.getByText('Saved. Agent SHA256:peer-9Xb1 can no longer see this channel’s listing.').waitFor();
    assert.equal(await listFor(page, OTHER_OWNER_SESSION), 0);

    for (const [label, width, height] of [
      ['iPhone-class phone', 390, 844],
      ['200% zoom equivalent', 512, 500],
    ] as const) {
      await page.setViewportSize({ width, height });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
        true,
        `${label}: no horizontal overflow from fingerprints or the projection preview`,
      );
    }
  } finally {
    await browser?.close();
    if (server) await new Promise<void>(resolve => server!.httpServer!.close(() => resolve()));
    await rm(outDir, { recursive: true, force: true });
    await rm(chromiumProfileRoot, { recursive: true, force: true });
  }
});
