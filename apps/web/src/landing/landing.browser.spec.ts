import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { build, preview, type PreviewServer } from 'vite';
import { chromium, type Browser, type Page } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
// The production splash build config, with only the output directory redirected.
const configFile = join(here, '../../vite.landing.config.mjs');
const EXACT_PROMPT = "Open a channel with another agent: https://khala.aiur.team";
const SIGN_IN_HREF = '/api/human/auth/login?return_to=%2Fconversations';
// RECREATION-SPEC §2.2 --accent-ink, --accent-line and --accent-soft.
const SIGN_IN = {
  light: { color: 'rgb(26, 74, 168)', border: 'rgba(31, 87, 196, 0.3)', hover: 'rgba(31, 87, 196, 0.11)' },
  dark: { color: 'rgb(143, 188, 255)', border: 'rgba(47, 134, 255, 0.34)', hover: 'rgba(47, 134, 255, 0.15)' },
} as const;
const FEATURE_TITLES = [
  'Multiplayer',
  'Hosted encryption',
  'Listening modes',
  'Local channel',
  'Weigh in',
  'Aiur Support',
];
const LISTENING_MODES_COPY = 'steer interrupts, sync (default) waits for the current turn, async checks when ready.';
const LOCAL_CHANNEL_COPY = "No Khala servers, no sign-in; messages are stored only on this machine. Each agent's model provider sees what that agent reads.";

async function assertSignInColors(page: Page, theme: keyof typeof SIGN_IN): Promise<void> {
  const signIn = page.locator('.topbar').getByRole('link', { name: 'Sign in' });
  // Colours ease over 0.2s after a theme switch.
  await page.waitForFunction(expected => getComputedStyle(document.querySelector('.signin')!).color === expected,
    SIGN_IN[theme].color, { timeout: 2000 }).catch(() => undefined);
  assert.equal(await signIn.evaluate(node => getComputedStyle(node).color), SIGN_IN[theme].color, `${theme}: Sign in text`);
  assert.equal(await signIn.evaluate(node => getComputedStyle(node).borderTopColor), SIGN_IN[theme].border, `${theme}: Sign in border`);
  await signIn.hover();
  await page.waitForFunction(expected => getComputedStyle(document.querySelector('.signin')!).backgroundColor === expected,
    SIGN_IN[theme].hover, { timeout: 2000 });
  assert.equal(await signIn.evaluate(node => getComputedStyle(node).color), SIGN_IN[theme].color, `${theme}: Sign in hover text`);
  await page.mouse.move(0, 0);
}

async function buttonColors(page: Page): Promise<{ label: string; background: string; color: string }[]> {
  return page.locator('button:not(.banner-close), .button').evaluateAll(nodes => nodes.map(node => {
    const style = getComputedStyle(node);
    return { label: node.getAttribute('aria-label') ?? node.textContent?.trim() ?? '', background: style.backgroundColor, color: style.color };
  }));
}

// Builds the real splash page and drives it in headless Chromium: the exact
// prompt, the copy button (by pointer and by keyboard), every button's colour
// in both themes, the theme toggle and its persistence, and phone widths.
test('splash page: exact prompt, working copy, buttons, theme and phone layout', { timeout: 90_000 }, async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'khala-landing-dist-'));
  // Chromium's singleton socket path is length-capped; keep the profile under /tmp.
  const chromiumProfileRoot = await mkdtemp(join('/tmp', 'khala-landing-profile-'));
  let server: PreviewServer | undefined;
  let browser: Browser | undefined;
  try {
    await build({ configFile, build: { outDir, emptyOutDir: true }, logLevel: 'error' });
    server = await preview({ configFile, build: { outDir }, preview: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
    const url = server.resolvedUrls!.local[0]!;

    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
      headless: true,
      args: ['--no-sandbox'],
      env: { ...process.env, TMPDIR: chromiumProfileRoot },
    });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      colorScheme: 'light',
      reducedMotion: 'reduce',
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    const page = await context.newPage();
    const failures: string[] = [];
    page.on('pageerror', error => failures.push(error.message));
    page.on('console', message => { if (message.type() === 'error') failures.push(message.text()); });
    page.on('response', response => { if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`); });
    await page.goto(url);

    const banner = page.getByRole('complementary', { name: 'Project announcement' });
    const dismissBanner = page.getByRole('button', { name: 'Dismiss announcement' });
    // The dismiss matches aiur.team: transparent, muted icon, SVG not a text glyph.
    assert.equal(await dismissBanner.evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)');
    assert.equal(await dismissBanner.locator('svg').count(), 1);
    assert.equal(await banner.isVisible(), true);
    const lineField = await page.evaluate(() => {
      const bannerRect = document.querySelector('#aiurBanner')!.getBoundingClientRect();
      const fieldRect = document.querySelector('#field')!.getBoundingClientRect();
      return { bannerBottom: bannerRect.bottom, fieldTop: fieldRect.top };
    });
    assert.ok(Math.abs(lineField.bannerBottom - lineField.fieldTop) <= 1, 'line field starts flush below the banner');
    await dismissBanner.focus();
    assert.equal(await dismissBanner.evaluate(node => node.matches(':focus-visible')), true);
    await page.keyboard.press('Enter');
    assert.equal(await banner.isHidden(), true);
    await page.reload();
    assert.equal(await banner.isHidden(), true, 'dismissal persists without revealing the banner');

    assert.deepEqual(await page.locator('.feature-card h3').allTextContents(), FEATURE_TITLES);
    assert.equal((await page.locator('.feature-card').nth(2).locator('p').innerText()).trim(), LISTENING_MODES_COPY);
    assert.equal((await page.locator('.feature-card').nth(3).locator('p').innerText()).trim(), LOCAL_CHANNEL_COPY);
    assert.equal((await page.locator('.features-intro').innerText()).trim(), 'Encrypted chat for humans and their agents.');
    assert.equal((await page.locator('.features-signoff').innerText()).trim(), 'Building is multiplayer again. Hailing freqencies open.');
    assert.equal(await page.locator('.features-signoff .open').textContent(), 'open');
    assert.equal(await page.getByRole('link', { name: 'Aiur', exact: true }).first().getAttribute('href'), 'https://aiur.team/');
    assert.equal(await page.locator('.what').innerText(), 'Multi-model, multi-machine agent messaging protocol');
    assert.equal(await page.getByText('Explore features', { exact: true }).count(), 0);
    assert.equal((await page.locator('#scrollcue').innerText()).trim(), 'SCROLL');
    await page.waitForFunction(() => (document.querySelector<HTMLCanvasElement>('#field')?.width ?? 0) > 0);
    await page.evaluate(() => window.scrollTo(0, 100));
    // The scroll event is dispatched asynchronously after scrollTo.
    await page.waitForFunction(() => document.querySelector('#scrollcue')?.classList.contains('gone') === true, undefined, { timeout: 2000 });
    await page.evaluate(() => window.scrollTo(0, 0));
    assert.equal(await page.getByRole('heading', { name: 'Built around' }).count(), 0);
    assert.equal(await page.getByRole('heading', { name: 'Plain limits' }).count(), 0);
    assert.equal((await page.locator('footer').innerText()).trim(), 'built with Aiur · Open Source');

    const faviconHrefs = ['/landing/favicon.ico', '/landing/favicon-32x32.png', '/landing/favicon-16x16.png', '/landing/apple-touch-icon.png'];
    const faviconResponses = await Promise.all(faviconHrefs.map(href => page.request.get(new URL(href, url).toString())));
    faviconResponses.forEach((response, index) => {
      const href = faviconHrefs[index]!;
      assert.equal(response.ok(), true, `${href} resolves`);
    });

    // The hero prompt is exact and is the only h1-level promise on the page.
    assert.equal(await page.locator('#agentPrompt').textContent(), EXACT_PROMPT);
    assert.equal(await page.getByRole('heading', { level: 1 }).count(), 1);
    assert.equal(await page.getByRole('main').count(), 1);

    // The prompt is copyable and the hosted app is reachable from the hero.
    const copy = page.getByRole('button', { name: 'Copy the prompt' });
    assert.equal(await copy.isEnabled(), true);
    assert.equal(await page.getByRole('link', { name: 'Open Khala app' }).count(), 0);
    assert.equal(await page.locator('#prompt-soon').count(), 0);

    // Top-right controls exist and the Docs link points at the quick start.
    assert.equal(await page.getByRole('link', { name: 'Docs' }).getAttribute('href'), 'https://aiur.team/docs/khala/quick-start');
    const toggle = page.getByRole('button', { name: 'Dark mode' });
    assert.equal(await toggle.getAttribute('aria-pressed'), 'false', 'light system preference: dark mode off');

    // Sign in is the last top-right control: the app's accent tool-btn pill,
    // in the UI mono font and exactly as tall as the theme toggle.
    const signIn = page.locator('.topbar').getByRole('link', { name: 'Sign in' });
    assert.equal(await signIn.getAttribute('href'), SIGN_IN_HREF);
    assert.equal(await page.locator('.topbar > :last-child').evaluate(node => node.textContent?.trim()), 'Sign in');
    const signInStyle = await signIn.evaluate(node => {
      const style = getComputedStyle(node);
      return { radius: style.borderRadius, size: style.fontSize, family: style.fontFamily, height: node.getBoundingClientRect().height };
    });
    assert.equal(signInStyle.radius, '999px');
    assert.equal(signInStyle.size, '12.16px');
    assert.match(signInStyle.family, /^"JetBrains Mono"/);
    assert.doesNotMatch(signInStyle.family, /Bungee/);
    assert.equal(signInStyle.height, await toggle.evaluate(node => node.getBoundingClientRect().height));

    // Sign in is the accent pill; the other topbar and copy controls follow
    // the quiet controls on aiur.team.
    await page.mouse.move(0, 0);
    const lightButtons = await buttonColors(page);
    assert.ok(lightButtons.length >= 4, 'Docs, theme toggle, Sign in and Copy');
    await assertSignInColors(page, 'light');
    assert.equal(lightButtons.find(button => button.label === 'Docs')?.background, 'rgba(0, 0, 0, 0)');
    assert.equal(lightButtons.find(button => button.label === 'Copy the prompt')?.background, 'rgba(0, 0, 0, 0)');
    assert.equal(await toggle.evaluate(node => getComputedStyle(node).borderRadius), '50%');
    const lightBackground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

    // ...and after switching to dark, which persists across a reload.
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
    const darkBackground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    assert.notEqual(darkBackground, lightBackground);
    assert.equal(darkBackground, 'rgb(26, 27, 30)');
    await page.mouse.move(0, 0);
    const darkButtons = await buttonColors(page);
    await assertSignInColors(page, 'dark');
    assert.equal(darkButtons.find(button => button.label === 'Docs')?.background, 'rgba(0, 0, 0, 0)');
    assert.equal(darkButtons.find(button => button.label === 'Copy the prompt')?.background, 'rgba(0, 0, 0, 0)');
    await page.reload();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
    assert.equal(await page.getByRole('button', { name: 'Dark mode' }).getAttribute('aria-pressed'), 'true');

    // With no stored choice, the system preference decides.
    const darkContext = await browser.newContext({ viewport: { width: 1024, height: 800 }, colorScheme: 'dark' });
    const darkPage = await darkContext.newPage();
    await darkPage.goto(url);
    assert.equal(await darkPage.getByRole('button', { name: 'Dark mode' }).getAttribute('aria-pressed'), 'true');
    assert.equal(await darkPage.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(26, 27, 30)');
    assert.equal(await darkPage.evaluate(() => document.documentElement.dataset.theme), 'dark');
    await darkPage.emulateMedia({ colorScheme: 'light' });
    await darkPage.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    assert.equal(await darkPage.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(231, 214, 178)');
    await darkContext.close();

    const blockedStorageContext = await browser.newContext({ viewport: { width: 1024, height: 800 }, colorScheme: 'light' });
    await blockedStorageContext.addInitScript(() => {
      Storage.prototype.getItem = () => { throw new Error('blocked'); };
      Storage.prototype.setItem = () => { throw new Error('blocked'); };
    });
    const blockedStoragePage = await blockedStorageContext.newPage();
    await blockedStoragePage.goto(url);
    const blockedBanner = blockedStoragePage.getByRole('complementary', { name: 'Project announcement' });
    assert.equal(await blockedBanner.isVisible(), true, 'blocked storage leaves the banner available');
    await blockedStoragePage.getByRole('button', { name: 'Dismiss announcement' }).click();
    assert.equal(await blockedBanner.isHidden(), true, 'banner remains dismissible when storage is blocked');
    await blockedStorageContext.close();

    const deniedStorageContext = await browser.newContext({ viewport: { width: 1024, height: 800 }, colorScheme: 'light' });
    await deniedStorageContext.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', {
        configurable: true,
        get: () => { throw new Error('denied'); },
      });
    });
    const deniedStoragePage = await deniedStorageContext.newPage();
    await deniedStoragePage.goto(url);
    const deniedBanner = deniedStoragePage.getByRole('complementary', { name: 'Project announcement' });
    assert.equal(await deniedBanner.isVisible(), true, 'denied storage getter leaves the banner available');
    await deniedStoragePage.getByRole('button', { name: 'Dismiss announcement' }).click();
    assert.equal(await deniedBanner.isHidden(), true, 'banner remains dismissible when the storage getter is denied');
    await deniedStorageContext.close();

    // Phone widths: no horizontal scroll, and the prompt and copy stay reachable.
    for (const [width, height] of [[390, 844], [360, 780]] as const) {
      await page.setViewportSize({ width, height });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        true,
        `${width}px: no horizontal overflow`,
      );
      assert.equal(await copy.isVisible(), true, `${width}px: copy button visible`);
      assert.equal(await page.locator('#agentPrompt').evaluate(node => {
        const text = node.firstChild;
        if (!text) return 0;
        const content = text.textContent ?? '';
        const start = content.indexOf('https://khala.aiur.team');
        const range = document.createRange();
        range.setStart(text, start);
        range.setEnd(text, start + 'https://khala.aiur.team'.length);
        return range.getClientRects().length;
      }), 1, `${width}px: the agent URL stays on one line`);
      assert.equal(await page.getByRole('link', { name: 'Docs' }).isVisible(), true, `${width}px: Docs visible`);
      if (width === 390) {
        assert.equal(
          await page.locator('.features').evaluate(node => getComputedStyle(node).gridTemplateColumns.split(' ').length),
          1,
          '390px: feature cards collapse to one column',
        );
      }
    }

    assert.deepEqual(failures, [], 'no page or console errors');
    assert.equal(await copy.locator('[data-copy-label]').innerText(), 'Copy');
    await copy.click();
    await page.waitForFunction(() => document.querySelector('#copyBtn [data-copy-label]')?.textContent === 'Copied');
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), EXACT_PROMPT);

    // A cancelled or failed sign-in returns here: the outcome shows once under
    // the topbar and the parameter leaves the address bar.
    for (const [outcome, message] of [['cancelled', 'Sign-in was cancelled.'], ['error', 'Sign-in could not be completed.']] as const) {
      await page.goto(`${url}?sign_in=${outcome}`);
      const status = page.locator('.signin-status');
      await status.waitFor();
      assert.equal(await status.getAttribute('role'), 'status');
      assert.equal((await status.innerText()).trim(), message);
      assert.equal(await status.evaluate(node => node.previousElementSibling?.classList.contains('topbar')), true);
      assert.equal(await status.evaluate(node => getComputedStyle(node).textAlign), 'right');
      assert.equal(new URL(page.url()).search, '', `${outcome}: sign_in leaves the URL`);
    }
    await page.goto(`${url}?sign_in=%3Cb%3Eforged%3C%2Fb%3E`);
    assert.equal(await page.locator('.signin-status').count(), 0, 'unknown outcomes show nothing');
    assert.equal(new URL(page.url()).search, '');
    assert.deepEqual(failures, [], 'no page or console errors after sign-in outcomes');
  } finally {
    await browser?.close();
    if (server) await new Promise<void>(resolve => server!.httpServer!.close(() => resolve()));
    await rm(outDir, { recursive: true, force: true });
    await rm(chromiumProfileRoot, { recursive: true, force: true });
  }
});
