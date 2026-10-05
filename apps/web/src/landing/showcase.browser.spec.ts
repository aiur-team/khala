import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, preview, type PreviewServer } from 'vite';
import { chromium, type Browser } from '@playwright/test';
import { AGENT_REPLIES, NUDGES } from './demo/replies';

const here = dirname(fileURLToPath(import.meta.url));
const configFile = join(here, '../../vite.landing.config.mjs');

test('the splash demo is the real app, local to the page, and its agents answer @mentions', { timeout: 120_000 }, async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'khala-showcase-dist-'));
  // Chromium's singleton socket has a short path limit.
  const profile = await mkdtemp(join('/tmp', 'ks546-'));
  let server: PreviewServer | undefined;
  let browser: Browser | undefined;
  try {
    await build({ configFile, build: { outDir, emptyOutDir: true }, logLevel: 'error' });
    server = await preview({ configFile, build: { outDir }, preview: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
    const origin = new URL(server.resolvedUrls!.local[0]!).origin;
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'], env: { ...process.env, TMPDIR: profile } });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const calls: string[] = [];
    page.on('request', request => {
      const url = new URL(request.url());
      if (url.origin !== origin || /\/(api|_matrix|auth)\//.test(url.pathname)) calls.push(request.url());
    });
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(server.resolvedUrls!.local[0]!);
    const storageBefore = await page.evaluate(() => JSON.stringify(Object.keys(localStorage).filter(key => key !== 'khala.theme')) + JSON.stringify({ ...sessionStorage }));
    const pane = page.locator('#exampleShowcase');
    const input = pane.locator('#kh-input');
    const thread = pane.locator('.kh-thread');
    await thread.getByText('Guest joined').waitFor();
    assert.equal(await page.locator('.showcase-section').evaluate(node => node.previousElementSibling?.classList.contains('stage')), true);
    assert.equal(await page.locator('.showcase-section').evaluate(node => node.nextElementSibling?.classList.contains('feature-section')), true);

    // The product frame: channel list with its unread count, the channel header and the composer.
    assert.equal(await pane.locator('.khala-app .kh-card').count(), 1);
    assert.equal(await pane.locator('.kh-list-head b').textContent(), 'Channels');
    assert.equal(await pane.locator('.kh-list-head span').textContent(), '3 unread');
    assert.equal(await pane.locator('#kh-head-btn').getAttribute('aria-expanded'), 'false');
    assert.equal(await thread.getByText('Claude is now Scout').count(), 1);
    assert.equal(await thread.getByText('Guest joined').count(), 1);

    // The roster: the visitor's agent has the live Steer · Sync · Async control; others show their mode.
    await pane.locator('#kh-head-btn').click();
    assert.equal(await pane.locator('#kh-head-btn').getAttribute('aria-expanded'), 'true');
    const opusModes = pane.getByRole('radiogroup', { name: 'Listening mode for Opus' });
    assert.equal(await opusModes.getByRole('radio', { name: 'Async · on demand' }).getAttribute('aria-checked'), 'true');
    await opusModes.getByRole('radio', { name: 'Steer · interrupts' }).click();
    await page.waitForFunction(() => document.querySelector('#exampleShowcase [aria-label="Listening mode for Opus"] [data-v="steer"]')?.getAttribute('aria-checked') === 'true');
    // Agents the visitor does not own show their mode, read-only.
    assert.equal(await pane.locator(`.kh-rrow:has([data-kh-agent="demo-agent-codex"]) .kh-mode-ro`).getAttribute('aria-label'), 'Steer · interrupts');
    assert.equal(await pane.locator(`.kh-rrow:has([data-kh-agent="demo-agent-scout"]) .kh-mode-ro`).getAttribute('aria-label'), 'Sync · next turn');
    await pane.locator('#kh-head-btn').click();

    // A message with no mention gets no answer.
    const rows = () => pane.locator('.kh-thread .kh-row').count();
    await input.fill('just looking around');
    await input.press('Enter');
    await thread.getByText('just looking around').waitFor();
    const quiet = await rows();
    await page.waitForTimeout(3_500);
    assert.equal(await rows(), quiet, 'no reply without a mention');

    // @-autocomplete picks an agent; the agent answers from the reply list.
    await input.fill('');
    await input.pressSequentially('hi @Co');
    await pane.getByRole('option', { name: /Codex/ }).waitFor();
    await input.press('Enter');
    await input.pressSequentially('how do I start?');
    assert.match(await input.inputValue(), /^hi @Codex how do I start\?$/u);
    await input.press('Enter');
    await thread.getByText('how do I start?').waitFor();
    const last = pane.locator('.kh-thread .kh-row').last();
    await page.waitForFunction(count => document.querySelectorAll('#exampleShowcase .kh-thread .kh-row').length > count, quiet + 1, { timeout: 5_000 });
    const reply = (await last.locator('.kh-b').textContent())?.trim() ?? '';
    assert.ok(AGENT_REPLIES.includes(reply), `reply "${reply}" comes from the list`);
    assert.ok(!NUDGES.includes(reply));

    // Phone width: the thread fills the frame and the back control returns to the list.
    for (const theme of ['light', 'dark'] as const) {
      // The demo follows the page's own theme toggle.
      if (await page.locator('html').getAttribute('data-theme') !== theme) await page.locator('#themeToggle').click();
      await page.waitForFunction(next => document.querySelector('#exampleShowcase .khala-app')?.getAttribute('data-theme') === next, theme);
      for (const width of [1440, 1100, 900, 760, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        const frame = await page.locator('.showcase-window').evaluate(node => {
          const box = node.getBoundingClientRect();
          return { width: box.width, height: box.height, left: box.left, right: box.right };
        });
        assert.ok(frame.width <= Math.min(1000, width), `${theme} ${width}: width`);
        assert.ok(frame.height >= 420 && frame.height <= 660, `${theme} ${width}: height`);
        assert.ok(frame.left >= 0 && frame.right <= width, `${theme} ${width}: frame in viewport`);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${theme} ${width}: no overflow`);
        const card = await pane.locator('.kh-card').evaluate(node => node.getBoundingClientRect().bottom);
        const window = await page.locator('.showcase-window').evaluate(node => node.getBoundingClientRect().bottom);
        assert.ok(card <= window + 1, `${theme} ${width}: the app fits the window`);
        if (width <= 760) {
          await pane.getByRole('button', { name: 'All channels' }).click();
          assert.equal(await pane.locator('.kh-list').isVisible(), true);
          await pane.locator('[data-kh-convo="welcome"]').click();
          assert.equal(await input.isVisible(), true);
        }
      }
    }

    // Another channel opens and clears its unread count.
    await page.setViewportSize({ width: 1280, height: 800 });
    await pane.locator('[data-kh-convo="local"]').click();
    await thread.getByText('This channel is local: no sign-in, no Khala servers, and messages stay on this machine.').waitFor();
    assert.equal(await pane.locator('.kh-list-head span').textContent(), '2 unread');

    assert.equal(await page.evaluate(() => JSON.stringify(Object.keys(localStorage).filter(key => key !== 'khala.theme')) + JSON.stringify({ ...sessionStorage })), storageBefore, 'the demo writes no storage');
    await page.reload();
    assert.equal(await page.getByText('how do I start?').count(), 0, 'a reload resets the demo');
    assert.equal(await page.getByText('just looking around').count(), 0, 'a reload resets the demo');
    assert.deepEqual(calls, [], 'no network calls beyond the page’s own assets');
    assert.deepEqual(errors, [], 'no browser errors');
    await context.close();
  } finally {
    await browser?.close();
    await server?.httpServer.close();
    await rm(outDir, { recursive: true, force: true });
    await rm(profile, { recursive: true, force: true });
  }
});
