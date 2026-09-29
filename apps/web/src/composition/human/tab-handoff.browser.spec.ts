import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { build, preview, type PreviewServer } from 'vite';
import { chromium, type Browser, type CDPSession, type Page } from '@playwright/test';

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
    const focusSessions = new Map<Page, CDPSession>();
    const origin = server.resolvedUrls!.local[0]!;
    const open = async (path: string, holdSync = false) => {
      const page = await context.newPage();
      const focusSession = await context.newCDPSession(page);
      focusSessions.set(page, focusSession);
      await page.goto(origin + 'tab-handoff.html?path=' + encodeURIComponent(path) + (holdSync ? '&holdSync=1' : ''));
      // CDP changes the browser's focus state and emits its focus/blur events.
      // Headless tabs otherwise both report hasFocus() even after bringToFront.
      await focusSession.send('Emulation.setFocusEmulationEnabled', { enabled: true });
      await focusSession.send('Emulation.setFocusEmulationEnabled', { enabled: false });
      return page;
    };
    const focus = async (page: Awaited<ReturnType<typeof open>>) => {
      for (const other of context.pages()) {
        if (other !== page && !other.isClosed()) {
          await focusSessions.get(other)!.send('Emulation.setFocusEmulationEnabled', { enabled: false });
        }
      }
      await page.bringToFront();
      await focusSessions.get(page)!.send('Emulation.setFocusEmulationEnabled', { enabled: true });
      assert.equal(await page.evaluate(() => document.hasFocus()), true);
      for (const other of context.pages()) {
        if (other !== page && !other.isClosed()) {
          assert.equal(await other.evaluate(() => document.hasFocus()), false);
        }
      }
    };
    const first = await open('/channels/first', true);
    await focus(first);
    await first.waitForFunction(() => window.__tabHandoff?.phase() === 'initializing_device');
    assert.equal(await first.getByTestId('live-room').count(), 0, 'initial sync has no channel capability');
    await first.evaluate(() => window.__tabHandoff.releaseSync());
    await first.getByTestId('live-room').waitFor();
    const second = await open('/new');
    await second.getByRole('heading', { name: 'Device handoff took too long' }).waitFor();
    assert.equal(await first.evaluate(() => document.hasFocus()), true);
    assert.equal(await first.evaluate(() => window.__tabHandoff.phase()), 'ready');
    assert.equal(await first.getByTestId('live-room').count(), 1, 'the owner stays usable until focus moves');
    assert.equal(await second.getByRole('button', { name: 'Try again in this tab' }).count(), 1);
    await focus(first);
    await focus(second);
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

    const closing = await open('/channels/third');
    await focus(closing);
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
