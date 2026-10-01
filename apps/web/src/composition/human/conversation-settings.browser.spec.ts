import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from '@playwright/test';
import { build, preview, type PreviewServer } from 'vite';

const harnessRoot = join(dirname(fileURLToPath(import.meta.url)), 'settings-browser-harness');

test('selected conversation settings close and discard old room authority', { timeout: 90_000 }, async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'khala-conversation-settings-dist-'));
  const profileRoot = await mkdtemp('/tmp/khala-conversation-settings-profile-');
  let server: PreviewServer | undefined;
  let browser: Browser | undefined;
  try {
    await build({ root: harnessRoot, build: { outDir, emptyOutDir: true }, logLevel: 'error' });
    server = await preview({ root: harnessRoot, build: { outDir }, preview: { host: '127.0.0.1', port: 0 } });
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true,
      args: ['--no-sandbox'], env: { ...process.env, TMPDIR: profileRoot } });
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    await page.goto(server.resolvedUrls!.local[0]!);
    const settings = page.getByLabel('Conversation settings').first();
    assert.equal(await settings.locator('.conversation-settings__label').isVisible(), false,
      'the accessible label does not spill outside the circular header button');
    await settings.focus();
    await settings.press('Enter');
    await page.getByRole('button', { name: 'Revoke device device_a' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Close channel' }).count(), 0);
    await settings.press('Escape');
    assert.equal(await page.locator('.conversation-settings').getAttribute('open'), null);
    assert.equal(await settings.evaluate(element => document.activeElement === element), true);
    await settings.press(' ');
    await page.getByRole('button', { name: 'Outside target' }).click();
    assert.equal(await page.locator('.conversation-settings').getAttribute('open'), null);
    await settings.click();
    await page.getByRole('button', { name: 'Switch conversation' }).evaluate(node => (node as HTMLButtonElement).click());
    assert.equal(await page.locator('.conversation-settings').getAttribute('open'), null);
    await settings.click();
    assert.equal(await page.getByRole('button', { name: 'Revoke device device_a' }).count(), 0);
    await page.getByRole('button', { name: 'Revoke device device_b' }).click();
    await page.getByRole('button', { name: 'Confirm revocation' }).click();
    await page.getByText('owner_b:room_b:device_b').waitFor();
    await page.locator('summary').filter({ hasText: 'Title' }).click();
    assert.equal(await page.getByRole('button', { name: 'Delete conversation' }).isDisabled(), true,
      'a pending settings operation blocks title closure on the shared controller');
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await page.locator('.khala-content-root').evaluate(node => node.setAttribute('data-theme', 'light'));
    assert.equal(await settings.isVisible(), true);
    await page.reload();
    await page.locator('summary').filter({ hasText: 'Title' }).click();
    await page.getByRole('button', { name: 'Delete conversation' }).click();
    await page.getByRole('button', { name: 'Confirm channel closure' }).click();
    await page.getByLabel('Conversation settings').first().click();
    const settingsPanel = page.locator('.conversation-settings__popover');
    await settingsPanel.getByRole('heading', { name: 'Recovery and channel access' }).waitFor();
    assert.equal(await settingsPanel.getByRole('button', { name: 'Close channel' }).count(), 0);
    assert.equal(await settingsPanel.getByRole('button', { name: 'Delete conversation' }).count(), 0);
    assert.equal(await settingsPanel.getByText('Close channel room_a?', { exact: true }).count(), 0);
  } finally {
    await browser?.close();
    if (server) await new Promise<void>(resolve => server!.httpServer!.close(() => resolve()));
    await rm(outDir, { recursive: true, force: true });
    await rm(profileRoot, { recursive: true, force: true });
  }
});
