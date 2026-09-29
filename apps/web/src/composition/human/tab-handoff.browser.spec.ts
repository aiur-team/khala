import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { build, preview, type PreviewServer } from 'vite';
import { chromium, type Browser } from '@playwright/test';

test('focused tabs hand off one device generation and recover from timeout', { timeout: 90_000 }, async () => {
  const scratch = await mkdtemp(join(process.env.TMPDIR ?? '/tmp', 'khala-tab-handoff-'));
  const profile = await mkdtemp(join('/tmp', 'khala-handoff-profile-'));
  let server: PreviewServer | null = null;
  let browser: Browser | null = null;
  try {
    const root = join(import.meta.dirname, 'browser-harness');
    await build({ root, build: { outDir: join(scratch, 'dist'), emptyOutDir: true,
      rollupOptions: { input: join(root, 'tab-handoff.html') } }, logLevel: 'error' });
    server = await preview({ root, build: { outDir: join(scratch, 'dist') }, preview: { host: '127.0.0.1', port: 0 } });
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
      headless: true, args: ['--no-sandbox'], env: { ...process.env, TMPDIR: profile } });
    const context = await browser.newContext();
    const origin = server.resolvedUrls!.local[0]!;
    const open = async (path: string, holdSync = false) => {
      const page = await context.newPage();
      await page.goto(origin + 'tab-handoff.html?path=' + encodeURIComponent(path) + (holdSync ? '&holdSync=1' : ''));
      await page.bringToFront();
      return page;
    };
    // Headless Chromium keeps hasFocus() true for both pages and does not emit
    // window focus on bringToFront. Dispatch the browser event after selecting
    // the tab to exercise the same production listener as a real focus switch.
    const focus = async (page: Awaited<ReturnType<typeof open>>) => {
      for (const other of context.pages()) {
        if (other !== page && !other.isClosed()) await other.evaluate(() => window.__tabHandoff.setFocused(false));
      }
      await page.bringToFront();
      await page.evaluate(() => { window.__tabHandoff.setFocused(true); window.dispatchEvent(new Event('focus')); });
    };
    const first = await open('/channels/first', true);
    await first.waitForFunction(() => window.__tabHandoff?.phase() === 'initializing_device');
    assert.equal(await first.getByTestId('live-room').count(), 0, 'initial sync has no channel capability');
    await first.evaluate(() => window.__tabHandoff.releaseSync());
    await first.getByTestId('live-room').waitFor();
    await first.evaluate(() => window.__tabHandoff.setFocused(false));
    const second = await open('/new');
    await second.waitForFunction(() => window.__tabHandoff?.phase() === 'ready');
    await first.getByRole('heading', { name: 'Khala is active in another tab' }).waitFor();
    assert.equal(await first.getByTestId('live-room').count(), 0);
    assert.equal(await first.evaluate(() => window.__tabHandoff.overlap()), false);

    await focus(first);
    await first.getByTestId('live-room').waitFor();
    await second.getByRole('heading', { name: 'Khala is active in another tab' }).waitFor();
    assert.equal(await second.evaluate(() => window.__tabHandoff.overlap()), false);

    await first.evaluate(() => window.__tabHandoff.holdStop());
    await focus(second);
    await second.getByRole('heading', { name: 'Device handoff took too long' }).waitFor();
    await first.evaluate(() => window.__tabHandoff.releaseStop());
    await second.getByRole('button', { name: 'Try again in this tab' }).click();
    await second.waitForFunction(() => window.__tabHandoff?.phase() === 'ready');
    assert.equal(await second.evaluate(() => window.__tabHandoff.overlap()), false);

    await second.evaluate(() => window.__tabHandoff.setFocused(false));
    const closing = await open('/channels/third');
    await closing.close();
    await focus(second);
    await second.waitForFunction(() => window.__tabHandoff?.phase() === 'ready');

    await second.close();
    await focus(first);
    await first.getByTestId('live-room').waitFor();
    assert.equal(await first.evaluate(() => window.__tabHandoff.overlap()), false);
  } finally {
    await browser?.close();
    if (server) await new Promise<void>(resolve => server!.httpServer!.close(() => resolve()));
    await rm(scratch, { recursive: true, force: true });
    await rm(profile, { recursive: true, force: true });
  }
});
