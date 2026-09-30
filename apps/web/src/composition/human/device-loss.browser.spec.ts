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
    releaseDevice(): void;
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
    await page.getByRole('region', { name: 'No channel selected' }).waitFor();
    assert.equal(await page.getByRole('dialog', { name: 'Create a channel' }).count(), 0);
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

test('signed-in index remains visible while device initializes and fails', { timeout: 90_000 }, async () => {
  const scratch = await mkdtemp(join(process.env.TMPDIR ?? '/tmp', 'khala-device-pending-'));
  const browserProfile = await mkdtemp(join('/tmp', 'khala-device-pending-profile-'));
  let server: PreviewServer | null = null;
  let browser: Browser | null = null;
  try {
    const screenshotDir = process.env.KHALA_SCREENSHOT_DIR;
    if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
    await build({ root: join(import.meta.dirname, 'browser-harness'),
      build: { outDir: join(scratch, 'dist'), emptyOutDir: true,
        rollupOptions: { input: join(import.meta.dirname, 'browser-harness/device-loss.html') } }, logLevel: 'error' });
    server = await preview({ root: join(import.meta.dirname, 'browser-harness'),
      build: { outDir: join(scratch, 'dist') }, preview: { host: '127.0.0.1', port: 0 } });
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
      headless: true, args: ['--no-sandbox'], env: { ...process.env, TMPDIR: browserProfile } });
    for (const width of [1440, 320]) {
      const page = await browser.newPage({ viewport: { width, height: 700 } });
      await page.goto(server.resolvedUrls!.local[0]! + 'device-loss.html?state=ready&hold-device&fail-device&logout');
      await page.getByRole('region', { name: 'Channel status' }).getByText('Getting this device ready…').waitFor();
      if (width <= 959) {
        const channels = page.getByRole('button', { name: 'Channels', exact: true });
        await channels.click();
        assert.equal(await page.getByRole('button', { name: 'Close channels' }).evaluate(node => node === document.activeElement), true);
        await page.keyboard.press('Escape');
        assert.equal(await channels.evaluate(node => node === document.activeElement), true);
        await channels.press('Enter');
      }
      assert.equal(await page.locator('.khala-owner-shell').count(), 1);
      assert.equal(await page.getByText('Account and device status').count(), 0);
      assert.equal(await page.getByRole('dialog', { name: 'Create a channel' }).count(), 0);
      assert.equal(await page.getByRole('button', { name: 'Create channel' }).isDisabled(), true);
      assert.equal(await page.getByTestId('live-room').count(), 0);
      assert.equal(await page.evaluate(() => window.__lossHarness.inboxCount()), 0);
      if (width <= 959) await page.getByRole('button', { name: 'Close channels' }).click();
      if (screenshotDir) await page.screenshot({ path: join(screenshotDir, `device-pending-${width}.png`) });
      await page.evaluate(() => window.__lossHarness.releaseDevice());
      await page.getByRole('region', { name: 'Channel status' }).getByText('device_unavailable').waitFor();
      assert.equal(await page.locator('.khala-owner-shell').count(), 1);
      if (width <= 959) await page.getByRole('button', { name: 'Channels', exact: true }).click();
      assert.equal(await page.getByRole('button', { name: 'Create channel' }).isDisabled(), true);
      assert.equal(await page.getByTestId('live-room').count(), 0);
      assert.equal(await page.evaluate(() => window.__lossHarness.inboxCount()), 0);
      if (width <= 959) await page.getByRole('button', { name: 'Close channels' }).click();
      if (screenshotDir) await page.screenshot({ path: join(screenshotDir, `device-unavailable-${width}.png`) });
      const retry = page.getByRole('button', { name: 'Try again' });
      await retry.focus();
      assert.equal(await retry.evaluate(node => node === document.activeElement), true);
      await retry.press('Enter');
      await page.waitForFunction(() => window.__lossHarness.activationCount() === 2);
      assert.equal(await page.getByText('Account and device status').count(), 0);
      assert.equal(await page.locator('.khala-owner-shell').count(), 1);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      await page.close();
    }
    const readyPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await readyPage.goto(server.resolvedUrls!.local[0]! + 'device-loss.html?state=ready&hold-device&logout');
    await readyPage.getByRole('region', { name: 'Channel status' }).waitFor();
    await readyPage.evaluate(() => window.__lossHarness.releaseDevice());
    await readyPage.locator('.conversation-list__item').first().waitFor();
    assert.equal(await readyPage.getByRole('dialog', { name: 'Create a channel' }).count(), 0);
    const create = readyPage.getByRole('button', { name: 'Create channel' });
    assert.equal(await create.isEnabled(), true);
    await create.click();
    await readyPage.getByRole('dialog', { name: 'Create a channel' }).waitFor();
    await readyPage.close();
  } finally {
    await browser?.close();
    if (server) await new Promise<void>(resolve => server!.httpServer!.close(() => resolve()));
    await rm(scratch, { recursive: true, force: true });
    await rm(browserProfile, { recursive: true, force: true });
  }
});

test('owner conversation shell fills desktop and phone with conditional request control', { timeout: 90_000 }, async () => {
  const scratch = await mkdtemp(join(process.env.TMPDIR ?? '/tmp', 'khala-owner-visual-'));
  const browserProfile = await mkdtemp(join('/tmp', 'khala-owner-visual-profile-'));
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
    await page.goto(server.resolvedUrls!.local[0]! + 'device-loss.html?state=ready&logout&visual');
    const title = page.locator('.aiur-shell__title');
    await title.getByText('First channel').waitFor();
    const requests = page.getByRole('link', { name: 'Channel requests, 2 pending' });
    await requests.waitFor();
    assert.equal((await requests.innerText()).trim(), '2');
    assert.equal(await requests.evaluate(node => node.nextElementSibling?.getAttribute('aria-label')), 'Create channel');
    assert.equal(await page.getByRole('button', { name: 'Channel settings' }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Channel details' }).count(), 0);
    assert.equal(await page.locator('.conversation-detail').count(), 0);
    assert.equal(await page.locator('.channel-share__more').count(), 0);
    const brand = await page.locator('.aiur-shell__brand').boundingBox();
    const theme = await page.getByRole('button', { name: 'Toggle color theme' }).boundingBox();
    const logout = await page.getByRole('button', { name: 'Log out' }).boundingBox();
    assert.ok(brand && theme && logout && brand.x < theme.x && theme.x < logout.x && logout.x + logout.width < 261);
    assert.equal(await page.locator('.conversation-layout').evaluate(node => getComputedStyle(node).borderTopWidth), '0px');
    assert.equal(await page.locator('.conversation-layout').evaluate(node => getComputedStyle(node).borderTopLeftRadius), '0px');
    const main = await page.locator('.aiur-shell__content').boundingBox();
    const chat = await page.locator('.conversation-layout').boundingBox();
    assert.ok(main && chat && Math.abs(main.width - chat.width) < 1 && Math.abs(main.height - chat.height) < 1);
    const screenshotDir = process.env.KHALA_SCREENSHOT_DIR;
    if (screenshotDir) {
      await mkdir(screenshotDir, { recursive: true });
      await page.screenshot({ path: join(screenshotDir, 'human-desktop.png') });
    }
    const channelCare = page.getByRole('link', { name: 'Channel care' });
    assert.equal(await channelCare.getAttribute('title'), 'Channel care');
    assert.equal((await channelCare.innerText()).trim(), '');
    await channelCare.focus();
    assert.equal(await channelCare.evaluate(node => node === document.activeElement), true);
    await page.keyboard.press('Enter');
    await page.getByRole('heading', { name: 'Channel care' }).waitFor();
    await page.evaluate(() => window.__lossHarness.navigate('/channels/room_1'));
    await title.getByText('First channel').waitFor();
    await page.getByRole('button', { name: 'Toggle color theme' }).click();
    assert.equal(await page.locator('.aiur-shell').getAttribute('data-theme'), 'light');
    await page.getByRole('button', { name: 'Toggle color theme' }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    if (screenshotDir) await page.screenshot({ path: join(screenshotDir, 'human-mobile.png') });
    await page.getByRole('button', { name: 'Channels' }).click();
    await page.waitForTimeout(250);
    assert.equal(await channelCare.isVisible(), true);
    if (screenshotDir) await page.screenshot({ path: join(screenshotDir, 'human-mobile-care.png') });
    await requests.focus();
    assert.equal(await requests.evaluate(node => node === document.activeElement), true);
    if (screenshotDir) await page.screenshot({ path: join(screenshotDir, 'human-mobile-requests.png') });
    await page.keyboard.press('Enter');
    await page.getByRole('heading', { name: 'Channel requests', level: 1 }).waitFor();
  } finally {
    await browser?.close();
    if (server) await new Promise<void>(resolve => server!.httpServer!.close(() => resolve()));
    await rm(scratch, { recursive: true, force: true });
    await rm(browserProfile, { recursive: true, force: true });
  }
});

test('long channel request inbox scrolls to approval on desktop and 320px phone', { timeout: 90_000 }, async () => {
  const scratch = await mkdtemp(join(process.env.TMPDIR ?? '/tmp', 'khala-owner-requests-'));
  const browserProfile = await mkdtemp(join('/tmp', 'khala-owner-requests-profile-'));
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
    const screenshotDir = process.env.KHALA_SCREENSHOT_DIR;
    if (screenshotDir) await mkdir(screenshotDir, { recursive: true });
    for (const layout of [
      { name: 'desktop', width: 1440, height: 900, hosted: false, scroll: '.aiur-shell__content' },
      { name: 'mobile', width: 320, height: 700, hosted: true, scroll: '.khala-content-main' },
    ]) {
      const page = await browser.newPage({ viewport: { width: layout.width, height: layout.height } });
      await page.goto(server.resolvedUrls!.local[0]! + `device-loss.html?state=ready&logout&long-requests${layout.hosted ? '&hosted' : ''}`);
      if (layout.hosted) await page.getByRole('button', { name: 'Channels' }).click();
      const requests = page.getByRole('link', { name: 'Channel requests, 50 pending' });
      await requests.waitFor();
      assert.equal((await requests.innerText()).trim(), '50');
      assert.equal(await requests.evaluate(node => node.nextElementSibling?.getAttribute('aria-label')), 'Create channel');
      await requests.click();
      await page.getByRole('heading', { name: 'Waiting for you (50)' }).waitFor();
      assert.equal(await page.getByRole('list', { name: 'Requests waiting for you' }).locator('.channel-requests__row').count(), 50);
      const scroller = page.locator(layout.scroll);
      const scrollSize = await scroller.evaluate(node => ({ scroll: node.scrollHeight, client: node.clientHeight, overflow: getComputedStyle(node).overflowY }));
      assert.equal(scrollSize.scroll > scrollSize.client, true, `${layout.name} request route has a bounded scroll container: ${JSON.stringify(scrollSize)}`);
      const lastReview = page.getByRole('list', { name: 'Requests waiting for you' }).getByRole('button', { name: 'Review request' }).last();
      await lastReview.scrollIntoViewIfNeeded();
      assert.equal(await scroller.evaluate(node => node.scrollTop > 0), true, 'the last request scrolls into view');
      assert.equal(await lastReview.isVisible(), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      if (screenshotDir) await page.screenshot({ path: join(screenshotDir, `human-requests-long-${layout.name}.png`) });
      await lastReview.click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('button', { name: 'Approve access' }).waitFor();
      assert.equal(await dialog.getByRole('button', { name: 'Approve access' }).isVisible(), true);
      await page.close();
    }
  } finally {
    await browser?.close();
    if (server) await new Promise<void>(resolve => server!.httpServer!.close(() => resolve()));
    await rm(scratch, { recursive: true, force: true });
    await rm(browserProfile, { recursive: true, force: true });
  }
});
