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
const EXACT_PROMPT = "I'd like to connect you with another agent. Open a channel: https://khala.aiur.team";
const BUTTON_BLUE = 'rgb(31, 87, 196)';
const WHITE = 'rgb(255, 255, 255)';

async function buttonColors(page: Page): Promise<{ label: string; background: string; color: string }[]> {
  return page.locator('button, .button').evaluateAll(nodes => nodes.map(node => {
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

    // The hero prompt is exact and is the only h1-level promise on the page.
    assert.equal(await page.locator('#agentPrompt').textContent(), EXACT_PROMPT);
    assert.equal(await page.getByRole('heading', { level: 1 }).count(), 1);
    assert.equal(await page.getByRole('main').count(), 1);

    // Pointer copy puts exactly the prompt on the clipboard and says so.
    const copy = page.getByRole('button', { name: 'Copy the prompt' });
    await copy.click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), EXACT_PROMPT);
    assert.equal((await copy.innerText()).trim(), 'Copied');
    assert.equal(await page.locator('#copyStatus').textContent(), 'Prompt copied to the clipboard');

    // Keyboard copy: Tab reaches the button, it shows a focus ring, Enter copies.
    await page.evaluate(() => navigator.clipboard.writeText(''));
    await page.locator('body').focus();
    let reached = false;
    for (let i = 0; i < 10 && !reached; i += 1) {
      await page.keyboard.press('Tab');
      reached = await copy.evaluate(node => node === document.activeElement);
    }
    assert.ok(reached, 'Tab reaches the copy button');
    assert.equal(await copy.evaluate(node => node.matches(':focus-visible')), true);
    assert.equal(await copy.evaluate(node => getComputedStyle(node).outlineStyle), 'solid');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('#copyStatus')?.textContent !== '');
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), EXACT_PROMPT);

    // Top-right controls exist and the Docs link points at the quick start.
    assert.equal(await page.getByRole('link', { name: 'Docs' }).getAttribute('href'), 'https://aiur.team/docs/khala/quick-start');
    const toggle = page.getByRole('button', { name: 'Dark mode' });
    assert.equal(await toggle.getAttribute('aria-pressed'), 'false', 'light system preference: dark mode off');

    // Every button is white on archon blue, in the light theme. The context
    // runs with reduced motion, so parking the pointer ends hover at once.
    await page.mouse.move(0, 0);
    const lightButtons = await buttonColors(page);
    assert.ok(lightButtons.length >= 4, 'Docs, theme toggle, Copy and the call to action');
    for (const button of lightButtons) assert.deepEqual([button.label, button.background, button.color], [button.label, BUTTON_BLUE, WHITE]);
    const lightBackground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

    // ...and after switching to dark, which persists across a reload.
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
    const darkBackground = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    assert.notEqual(darkBackground, lightBackground);
    assert.equal(darkBackground, 'rgb(26, 27, 30)');
    await page.mouse.move(0, 0);
    for (const button of await buttonColors(page)) assert.deepEqual([button.label, button.background, button.color], [button.label, BUTTON_BLUE, WHITE]);
    await page.reload();
    assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
    assert.equal(await page.getByRole('button', { name: 'Dark mode' }).getAttribute('aria-pressed'), 'true');

    // With no stored choice, the system preference decides.
    const darkContext = await browser.newContext({ viewport: { width: 1024, height: 800 }, colorScheme: 'dark' });
    const darkPage = await darkContext.newPage();
    await darkPage.goto(url);
    assert.equal(await darkPage.getByRole('button', { name: 'Dark mode' }).getAttribute('aria-pressed'), 'true');
    assert.equal(await darkPage.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(26, 27, 30)');
    assert.equal(await darkPage.evaluate(() => document.documentElement.hasAttribute('data-theme')), false);
    await darkContext.close();

    // Phone widths: no horizontal scroll, and the prompt and copy stay reachable.
    for (const [width, height] of [[390, 844], [360, 780]] as const) {
      await page.setViewportSize({ width, height });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        true,
        `${width}px: no horizontal overflow`,
      );
      assert.equal(await copy.isVisible(), true, `${width}px: copy button visible`);
      assert.equal(await page.getByRole('link', { name: 'Docs' }).isVisible(), true, `${width}px: Docs visible`);
    }

    assert.deepEqual(failures, [], 'no page or console errors');
  } finally {
    await browser?.close();
    if (server) await new Promise<void>(resolve => server!.httpServer!.close(() => resolve()));
    await rm(outDir, { recursive: true, force: true });
    await rm(chromiumProfileRoot, { recursive: true, force: true });
  }
});
