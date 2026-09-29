import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { build, preview, type PreviewServer } from 'vite';
import { chromium, type Browser } from '@playwright/test';

declare global { interface Window {
  __lossHarness: {
    setDevice(next: 'lost' | 'ready' | 'revoked', reason?: import('@khala/contracts/messaging/index').DeviceView['reason']): void;
    switchAccount(): void;
    activationCount(): number;
    inboxCount(): number;
    signOutCount(): number;
    stopCount(): number;
    holdNavigation(): void;
    releaseNavigation(): void;
    navigate(path: string): void;
  };
} }

test('mounted owner screen fences lost keys and resets on account switch', { timeout: 90_000 }, async () => {
  const scratch = await mkdtemp(join(process.env.TMPDIR ?? '/tmp', 'khala-device-loss-'));
  const browserProfile = await mkdtemp(join('/tmp', 'khala-device-loss-profile-'));
  let server: PreviewServer | null = null;
  let browser: Browser | null = null;
  try {
    await build({ root: join(import.meta.dirname, 'browser-harness'),
      build: { outDir: join(scratch, 'dist'), emptyOutDir: true,
        rollupOptions: { input: join(import.meta.dirname, 'browser-harness/device-loss.html') } }, logLevel: 'error' });
    server = await preview({ root: join(import.meta.dirname, 'browser-harness'),
      build: { outDir: join(scratch, 'dist') }, preview: { host: '127.0.0.1', port: 0 } });
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
      headless: true, args: ['--no-sandbox'], env: { ...process.env, TMPDIR: browserProfile } });
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(server.resolvedUrls!.local[0]! + 'device-loss.html');
    try {
      await page.getByRole('heading', { name: 'Device keys unavailable' }).waitFor({ timeout: 5_000 });
    } catch (error) {
      throw new Error(`Lost state did not mount; page errors: ${errors.join(' | ')}; body: ${await page.locator('body').innerText()}`, { cause: error });
    }
    assert.equal(await page.getByTestId('live-room').count(), 0);
    assert.equal(await page.evaluate(() => window.__lossHarness.inboxCount()), 0);
    assert.equal(await page.getByRole('button', { name: 'Check retained keys again' }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Log out' }).count(), 1);

    // A retained profile is a fresh application lifecycle, not a retry of the
    // sticky lost service instance above.
    await page.goto(server.resolvedUrls!.local[0]! + 'device-loss.html?state=ready');
    await page.getByTestId('live-room').getByText('Channel for owner_alice').waitFor();
    assert.equal(await page.getByRole('heading', { name: 'Device keys unavailable' }).count(), 0);
    await page.evaluate(() => window.__lossHarness.setDevice('revoked'));
    await page.getByText('revoked_by_owner').waitFor();
    assert.equal(await page.getByTestId('live-room').count(), 0);
    assert.equal(await page.getByRole('heading', { name: 'Device keys unavailable' }).count(), 0);

    await page.evaluate(() => window.__lossHarness.switchAccount());
    await page.getByRole('heading', { name: 'Device keys unavailable' }).waitFor();
    assert.equal(await page.getByTestId('live-room').count(), 0);
    assert.equal(await page.evaluate(() => window.__lossHarness.inboxCount()), 1);
  } finally {
    await browser?.close();
    if (server) await new Promise<void>(resolve => server!.httpServer!.close(() => resolve()));
    await rm(scratch, { recursive: true, force: true });
    await rm(browserProfile, { recursive: true, force: true });
  }
});

test('standalone logout stays reachable on desktop and phone and clears the active device', { timeout: 90_000 }, async () => {
  const scratch = await mkdtemp(join(process.env.TMPDIR ?? '/tmp', 'khala-logout-'));
  const browserProfile = await mkdtemp(join('/tmp', 'khala-logout-profile-'));
  let server: PreviewServer | null = null;
  let browser: Browser | null = null;
  try {
    await build({ root: join(import.meta.dirname, 'browser-harness'),
      build: { outDir: join(scratch, 'dist'), emptyOutDir: true,
        rollupOptions: { input: join(import.meta.dirname, 'browser-harness/device-loss.html') } }, logLevel: 'error' });
    server = await preview({ root: join(import.meta.dirname, 'browser-harness'),
      build: { outDir: join(scratch, 'dist') }, preview: { host: '127.0.0.1', port: 0 } });
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
      headless: true, args: ['--no-sandbox'], env: { ...process.env, TMPDIR: browserProfile } });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(server.resolvedUrls!.local[0]! + 'device-loss.html?state=ready&logout');
    const button = page.getByRole('button', { name: 'Log out' });
    await button.waitFor();
    assert.equal(await button.isVisible(), true);
    const brand = page.getByRole('link', { name: 'KHALA' });
    assert.equal(await brand.getAttribute('href'), '/conversations');
    assert.equal(await brand.locator('img').evaluate(image => (image as HTMLImageElement).naturalWidth > 0), true);
    assert.equal(await page.getByRole('navigation', { name: 'Main navigation' }).getByText('Khala').count(), 0);
    const shell = await page.locator('.aiur-shell').elementHandle();
    assert.ok(shell);
    assert.equal(await page.locator('.conversation-list__item').count(), 2);
    const createButton = page.getByRole('button', { name: 'Create channel' });
    await createButton.click();
    await page.getByRole('dialog', { name: 'Create a channel' }).waitFor();
    assert.equal(await page.getByRole('textbox', { name: 'Channel name (optional)' }).evaluate(element => element === document.activeElement), true);
    await page.keyboard.press('Escape');
    assert.equal(await createButton.evaluate(element => element === document.activeElement), true);
    await page.evaluate(() => window.__lossHarness.navigate('/new'));
    await page.getByRole('dialog', { name: 'Create a channel' }).waitFor();
    await page.evaluate(() => window.__lossHarness.navigate('/conversations'));
    await page.getByRole('dialog', { name: 'Create a channel' }).waitFor({ state: 'detached' });
    await page.evaluate(() => window.__lossHarness.holdNavigation());
    await page.locator('.conversation-list__item', { hasText: 'Second channel' }).click();
    await page.getByRole('status', { name: 'Loading conversation' }).waitFor();
    assert.equal(await shell.evaluate(node => node.isConnected), true, 'the signed-in shell remains mounted');
    assert.equal(await page.locator('.conversation-list__item').count(), 2, 'the channel list remains live during navigation');
    await page.evaluate(() => window.__lossHarness.releaseNavigation());
    await page.getByTestId('live-room').getByText('room_2').waitFor();
    const screenshotDir = process.env.KHALA_SCREENSHOT_DIR;
    if (screenshotDir) {
      await mkdir(screenshotDir, { recursive: true });
      await page.screenshot({ path: join(screenshotDir, 'desktop.png'), fullPage: true });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await button.isVisible(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    const channelsButton = page.getByRole('button', { name: 'Channels', exact: true });
    await channelsButton.click();
    const channelsDialog = page.getByRole('dialog', { name: 'Channels' });
    await channelsDialog.waitFor();
    assert.equal(await channelsDialog.getAttribute('aria-modal'), 'true', 'the hosted mobile drawer is modal to assistive technology');
    assert.equal(await page.locator('.conversation-list__item').first().isVisible(), true);
    await createButton.click();
    await page.getByRole('dialog', { name: 'Create a channel' }).waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await channelsButton.evaluate(element => element === document.activeElement), true);
    await channelsButton.click();
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.locator('.khala-sidebar').evaluate(element => element.contains(document.activeElement)), true);
    for (let i = 0; i < 8; i += 1) {
      await page.keyboard.press('Tab');
      assert.equal(await page.locator('.khala-sidebar').evaluate(element => element.contains(document.activeElement)), true);
    }
    await page.keyboard.press('Escape');
    assert.equal(await channelsButton.getAttribute('aria-expanded'), 'false');
    if (screenshotDir) await page.screenshot({ path: join(screenshotDir, 'mobile.png'), fullPage: true });

    await button.click();
    await page.getByRole('status').getByText('Logging out…').waitFor();
    assert.equal(await button.isDisabled(), true);
    await page.getByRole('alert').getByText('Log out failed. Try again.').waitFor();
    assert.equal(await page.evaluate(() => window.__lossHarness.signOutCount()), 1);
    await button.click();
    await page.getByRole('button', { name: 'Sign in' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Log out' }).count(), 0);
    assert.equal(await page.getByTestId('live-room').count(), 0);
    assert.equal(await page.evaluate(() => window.__lossHarness.signOutCount()), 2);
    assert.equal(await page.evaluate(() => window.__lossHarness.stopCount()), 1);
    assert.equal(new URL(page.url()).pathname, '/new');

    await page.goto(server.resolvedUrls!.local[0]! + 'device-loss.html?state=ready&logout&hosted');
    await page.getByRole('button', { name: 'Log out' }).waitFor();
    assert.equal(await page.locator('.aiur-shell__topbar').count(), 0);
    assert.equal(await page.locator('.khala-content-actions').count(), 1);
    if (screenshotDir) {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.screenshot({ path: join(screenshotDir, 'hosted-desktop.png'), fullPage: true });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: join(screenshotDir, 'hosted-mobile.png'), fullPage: true });
    }

    await page.goto(server.resolvedUrls!.local[0]! + 'device-loss.html?state=lost&logout');
    await page.getByRole('heading', { name: 'Device keys unavailable' }).waitFor();
    const unavailableLogout = page.getByRole('button', { name: 'Log out' });
    await unavailableLogout.click();
    await page.getByRole('alert').getByText('Log out failed. Try again.').waitFor();
    await unavailableLogout.click();
    await page.getByRole('button', { name: 'Sign in' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Log out' }).count(), 0);
    assert.equal(await page.getByRole('navigation', { name: 'Main navigation' }).getByText('Khala').count(), 0);
  } finally {
    await browser?.close();
    if (server) await new Promise<void>(resolve => server!.httpServer!.close(() => resolve()));
    await rm(scratch, { recursive: true, force: true });
    await rm(browserProfile, { recursive: true, force: true });
  }
});
