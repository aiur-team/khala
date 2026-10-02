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
    signOutCount(): number;
    signInCount(): number;
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
    const brand = page.getByRole('link', { name: 'Khala home' });
    assert.equal(await brand.getAttribute('href'), '/conversations');
    assert.equal(await page.locator('.kh-brand .brand-logo').evaluate(image => (image as HTMLImageElement).naturalWidth > 0), true);
    assert.equal(await page.locator('nav').count(), 0);
    const shell = await page.locator('.khala-app').elementHandle();
    assert.ok(shell);
    assert.equal(await page.locator('.kh-cv').count(), 2);
    const createButton = page.getByRole('button', { name: 'New channel' });
    await createButton.click();
    await page.locator('.kh-pop:not([hidden])').waitFor();
    assert.equal(await page.getByRole('textbox', { name: 'Channel name' }).evaluate(element => element === document.activeElement), true);
    await page.keyboard.press('Escape');
    assert.equal(await createButton.evaluate(element => element === document.activeElement), true);
    await page.evaluate(() => window.__lossHarness.navigate('/new'));
    await page.getByRole('region', { name: 'No channel selected' }).waitFor();
    assert.equal(await page.locator('.kh-pop:not([hidden])').count(), 0);
    await page.evaluate(() => window.__lossHarness.navigate('/conversations'));
    await page.locator('.kh-pop:not([hidden])').waitFor({ state: 'detached' });
    await page.evaluate(() => window.__lossHarness.holdNavigation());
    await page.locator('.kh-cv', { hasText: 'Second channel' }).click();
    await page.getByRole('status', { name: 'Loading conversation' }).waitFor();
    assert.equal(await shell.evaluate(node => node.isConnected), true, 'the signed-in shell remains mounted');
    assert.equal(await page.locator('.kh-cv').count(), 2, 'the channel list remains live during navigation');
    await page.evaluate(() => window.__lossHarness.releaseNavigation());
    await page.getByTestId('live-room').getByText('room_2').waitFor();
    const screenshotDir = process.env.KHALA_SCREENSHOT_DIR;
    if (screenshotDir) {
      await mkdir(screenshotDir, { recursive: true });
      await page.screenshot({ path: join(screenshotDir, 'desktop.png'), fullPage: true });
    }
    // Phone: the thread view hides the list; going back shows the list with
    // the brand row, its Log out and the create control.
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    assert.equal(await page.locator('.kh-cv').first().isVisible(), false);
    await page.getByRole('button', { name: 'All conversations' }).click();
    await page.locator('.kh-card:not(.in-thread)').waitFor();
    assert.equal(await page.locator('.kh-cv').first().isVisible(), true);
    assert.equal(await button.isVisible(), true);
    assert.equal(await page.getByRole('button', { name: 'Channels', exact: true }).count(), 0, 'no channel drawer');
    await createButton.click();
    await page.locator('.kh-pop:not([hidden])').waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await createButton.evaluate(element => element === document.activeElement), true);
    if (screenshotDir) await page.screenshot({ path: join(screenshotDir, 'mobile.png'), fullPage: true });

    await button.click();
    await page.getByRole('status').getByText('Logging out…').waitFor();
    assert.equal(await button.isDisabled(), true);
    await page.getByRole('alert').getByText('Log out failed. Try again.').waitFor();
    assert.equal(await page.evaluate(() => window.__lossHarness.signOutCount()), 1);
    await button.click();
    // Signed out goes straight to sign-in; this harness refuses it, so the
    // page offers Try again, which starts sign-in once more.
    await page.getByRole('alert').getByText('Sign-in is unavailable right now.').waitFor();
    assert.equal(await page.getByRole('button', { name: 'Sign in' }).count(), 0);
    assert.equal(await page.evaluate(() => window.__lossHarness.signInCount()), 1);
    await page.getByRole('button', { name: 'Try again' }).click();
    await page.waitForFunction(() => window.__lossHarness.signInCount() === 2);
    await page.getByRole('alert').getByText('Sign-in is unavailable right now.').waitFor();
    assert.equal(await page.getByRole('button', { name: 'Log out' }).count(), 0);
    assert.equal(await page.getByTestId('live-room').count(), 0);
    assert.equal(await page.evaluate(() => window.__lossHarness.signOutCount()), 2);
    assert.equal(await page.evaluate(() => window.__lossHarness.stopCount()), 1);
    assert.equal(new URL(page.url()).pathname, '/new');

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(server.resolvedUrls!.local[0]! + 'device-loss.html?state=ready&logout&hosted');
    await page.getByRole('button', { name: 'Log out' }).waitFor();
    assert.equal(await page.locator('.aiur-shell__topbar').count(), 0);
    assert.equal(await page.locator('.kh-brand-actions').getByRole('button', { name: 'Log out' }).count(), 1);
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
    await page.getByRole('alert').getByText('Sign-in is unavailable right now.').waitFor();
    assert.equal(await page.getByRole('button', { name: 'Sign in' }).count(), 0);
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
      // Every width shows the gated list and the status together; there is no drawer.
      assert.equal(await page.getByRole('button', { name: 'Channels', exact: true }).count(), 0);
      assert.equal(await page.getByRole('button', { name: 'New channel' }).isVisible(), true);
      assert.equal(await page.locator('.khala-owner-shell').count(), 1);
      assert.equal(await page.getByText('Account and device status').count(), 0);
      assert.equal(await page.locator('.kh-pop:not([hidden])').count(), 0);
      assert.equal(await page.getByRole('button', { name: 'New channel' }).isDisabled(), true);
      assert.equal(await page.getByTestId('live-room').count(), 0);
      if (screenshotDir) await page.screenshot({ path: join(screenshotDir, `device-pending-${width}.png`) });
      await page.evaluate(() => window.__lossHarness.releaseDevice());
      await page.getByRole('region', { name: 'Channel status' }).getByText('device_unavailable').waitFor();
      assert.equal(await page.locator('.khala-owner-shell').count(), 1);
      assert.equal(await page.getByRole('button', { name: 'New channel' }).isDisabled(), true);
      assert.equal(await page.getByTestId('live-room').count(), 0);
      if (screenshotDir) await page.screenshot({ path: join(screenshotDir, `device-unavailable-${width}.png`) });
      const retry = page.getByRole('button', { name: 'Try again' });
      await retry.focus();
      assert.equal(await retry.evaluate(node => node === document.activeElement), true);
      await retry.press('Enter');
      await page.waitForFunction(() => window.__lossHarness.activationCount() === 2);
      assert.equal(await page.getByText('Account and device status').count(), 0);
      assert.equal(await page.locator('.khala-owner-shell').count(), 1);
      const widthState = await page.evaluate(() => ({ viewport: innerWidth, scroll: document.documentElement.scrollWidth,
        outside: [...document.querySelectorAll<HTMLElement>('body *')].filter(node => node.getBoundingClientRect().right > innerWidth + 1)
          .slice(0, 5).map(node => ({ tag: node.tagName, className: node.className, right: node.getBoundingClientRect().right })) }));
      assert.equal(widthState.scroll <= widthState.viewport + 1, true, JSON.stringify(widthState));
      await page.close();
    }
    const readyPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await readyPage.goto(server.resolvedUrls!.local[0]! + 'device-loss.html?state=ready&hold-device&logout');
    await readyPage.getByRole('region', { name: 'Channel status' }).waitFor();
    await readyPage.evaluate(() => window.__lossHarness.releaseDevice());
    await readyPage.locator('.kh-cv').first().waitFor();
    assert.equal(await readyPage.locator('.kh-pop:not([hidden])').count(), 0);
    const create = readyPage.getByRole('button', { name: 'New channel' });
    assert.equal(await create.isEnabled(), true);
    await create.click();
    await readyPage.locator('.kh-pop:not([hidden])').waitFor();
    assert.equal(await readyPage.locator('.kh-pop .kh-or').count(), 0, 'agent-first creation is M2');
    await readyPage.getByRole('textbox', { name: 'Channel name' }).fill('Launch');
    await readyPage.getByRole('textbox', { name: 'Channel name' }).press('Enter');
    await readyPage.getByTestId('live-room').getByText('room_2').waitFor();
    await readyPage.locator('.kh-toast.on').getByText('Created').waitFor();
    assert.equal(await readyPage.locator('.kh-pop:not([hidden])').count(), 0);
    await readyPage.close();
  } finally {
    await browser?.close();
    if (server) await new Promise<void>(resolve => server!.httpServer!.close(() => resolve()));
    await rm(scratch, { recursive: true, force: true });
    await rm(browserProfile, { recursive: true, force: true });
  }
});

test('owner conversation shell fills desktop and phone with channel creation', { timeout: 90_000 }, async () => {
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
    const title = page.locator('.channel-roster__summary');
    await title.getByText('First channel').waitFor();
    assert.equal(await page.getByRole('button', { name: 'Channel settings' }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Channel details' }).count(), 0);
    assert.equal(await page.locator('.conversation-detail').count(), 0);
    assert.equal(await page.locator('.channel-share__more').count(), 0);
    const brand = await page.locator('.kh-brand .wm').boundingBox();
    const theme = await page.getByRole('button', { name: 'Toggle color theme' }).boundingBox();
    const logout = await page.getByRole('button', { name: 'Log out' }).boundingBox();
    const list = await page.locator('.kh-list').boundingBox();
    assert.ok(brand && theme && logout && list && brand.x < theme.x && theme.x < logout.x
      && logout.x + logout.width <= list.x + list.width, 'the brand row holds the wordmark, theme toggle and Log out');
    assert.deepEqual(await page.locator('.kh-card').boundingBox(), { x: 0, y: 0, width: 1440, height: 900 });
    assert.equal(await page.locator('.conversation-layout').evaluate(node => getComputedStyle(node).borderTopWidth), '0px');
    assert.equal(await page.locator('.conversation-layout').evaluate(node => getComputedStyle(node).borderTopLeftRadius), '0px');
    const main = await page.locator('.kh-main').boundingBox();
    const chat = await page.locator('.conversation-layout').boundingBox();
    assert.ok(main && chat && Math.abs(main.width - chat.width) < 1 && Math.abs(main.height - chat.height) < 1,
      JSON.stringify({ main, chat }));
    const screenshotDir = process.env.KHALA_SCREENSHOT_DIR;
    if (screenshotDir) {
      await mkdir(screenshotDir, { recursive: true });
      await page.screenshot({ path: join(screenshotDir, 'human-desktop.png') });
    }
    assert.equal(await page.getByRole('link', { name: 'Channel care' }).count(), 0);
    await page.getByRole('button', { name: 'Toggle color theme' }).click();
    assert.equal(await page.locator('.khala-app').getAttribute('data-theme'), 'light');
    await page.getByRole('button', { name: 'Toggle color theme' }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await page.locator('.conversation-thread__head .channel-roster').waitFor();
    assert.equal(await page.locator('#khala-channel-toolbar').count(), 0, 'the channel header stays in the thread, not a portal');
    assert.equal(await page.locator('.kh-list').isVisible(), false, 'the phone thread view hides the list');
    assert.equal(await page.getByRole('heading', { name: 'First channel', level: 1 }).count(), 1);
    if (screenshotDir) await page.screenshot({ path: join(screenshotDir, 'human-mobile.png') });
    await page.getByRole('button', { name: 'All conversations' }).first().click();
    await page.locator('.kh-card:not(.in-thread)').waitFor();
    assert.equal(await page.locator('.kh-list').isVisible(), true);
    assert.equal(await page.getByRole('link', { name: 'Channel care' }).count(), 0);
    if (screenshotDir) await page.screenshot({ path: join(screenshotDir, 'human-mobile-care.png') });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(server.resolvedUrls!.local[0]! + 'device-loss.html?state=ready&logout&visual&hosted');
    const roster = page.locator('.conversation-thread__head details.channel-roster');
    await roster.waitFor();
    assert.equal(await page.locator('#khala-channel-toolbar').count(), 0, 'hosted channel keeps its header in the thread');
    const hostedMain = await page.locator('.kh-main').boundingBox();
    const hostedThread = await page.locator('.conversation-thread').boundingBox();
    assert.ok(hostedMain && hostedThread && hostedThread.width >= hostedMain.width - 2, 'hosted thread fills the main column');
    await roster.locator('summary').focus();
    await page.keyboard.press('Enter');
    assert.equal(await roster.getAttribute('open'), '', 'keyboard opens the participant details');
    await page.getByText('No agents have joined this channel yet.').waitFor();
    if (screenshotDir) {
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
        for (const theme of ['dark', 'light']) {
          await page.locator('[data-theme]').first().evaluate((node, value) => node.setAttribute('data-theme', value), theme);
          await page.screenshot({ path: join(screenshotDir, `hosted-roster-${width}-${theme}.png`) });
        }
      }
    }
    await page.keyboard.press('Escape');
    assert.equal(await roster.getAttribute('open'), null, 'Escape closes the participant details');
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    const share = page.getByRole('button', { name: 'Copy channel invite link' });
    await share.click();
    assert.equal(await roster.getAttribute('open'), null, 'share does not toggle participant details');
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    assert.equal(await page.getByRole('button', { name: 'All conversations' }).first().isVisible(), true);
    await page.setViewportSize({ width: 320, height: 740 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'the thread fits a 320px window');
    assert.equal(await page.getByRole('heading', { name: 'First channel', level: 2 }).isVisible(), true);
  } finally {
    await browser?.close();
    if (server) await new Promise<void>(resolve => server!.httpServer!.close(() => resolve()));
    await rm(scratch, { recursive: true, force: true });
    await rm(browserProfile, { recursive: true, force: true });
  }
});
