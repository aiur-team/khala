import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { build, preview, type PreviewServer } from 'vite';
import { chromium, type Browser, type CDPSession, type Page } from '@playwright/test';

type OpenOptions = Readonly<{
  holdSync?: boolean;
  /**
   * A Firefox permission prompt is open and never answered: it holds focus, so
   * the page never has it, and `navigator.storage.persist()` never settles.
   */
  unansweredPrompt?: boolean;
}>;

type Harness = Readonly<{
  open(path: string, options?: OpenOptions): Promise<Page>;
  /** Loads the harness again in `page`, like a reload of the same tab. */
  reload(page: Page, path: string, options?: OpenOptions): Promise<void>;
  focus(page: Page): Promise<void>;
  assertExclusiveOwner(page: Page): void;
}>;

async function withHarness(run: (harness: Harness) => Promise<void>): Promise<void> {
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
    const activeEngines = new Map<string, Page>();
    const overlaps: string[][] = [];
    await context.exposeBinding('__recordDeviceEngine', ({ page }, event: 'opened' | 'closed', engineId: string) => {
      // A destroyed renderer cannot retain an engine; its Web Locks are also
      // released by the browser. Prune here as well as on the page close event.
      for (const [id, owner] of activeEngines) {
        if (owner.isClosed()) activeEngines.delete(id);
      }
      if (event === 'opened' && !page.isClosed()) {
        if (activeEngines.size) overlaps.push([...activeEngines.keys(), engineId]);
        activeEngines.set(engineId, page);
      } else {
        activeEngines.delete(engineId);
      }
    });
    const forget = (page: Page) => {
      for (const [id, owner] of activeEngines) {
        if (owner === page) activeEngines.delete(id);
      }
    };
    const focusSessions = new Map<Page, CDPSession>();
    const origin = server.resolvedUrls!.local[0]!;
    const harnessUrl = (path: string, options: OpenOptions = {}) => origin + 'tab-handoff.html?path=' + encodeURIComponent(path)
      + (options.holdSync ? '&holdSync=1' : '') + (options.unansweredPrompt ? '&unansweredPrompt=1' : '');
    const blur = async (page: Page) => {
      // CDP changes the browser's focus state and emits its focus/blur events.
      // Headless tabs otherwise both report hasFocus() even after bringToFront.
      await focusSessions.get(page)!.send('Emulation.setFocusEmulationEnabled', { enabled: true });
      await focusSessions.get(page)!.send('Emulation.setFocusEmulationEnabled', { enabled: false });
    };
    await run({
      async open(path, options) {
        const page = await context.newPage();
        page.on('close', () => forget(page));
        focusSessions.set(page, await context.newCDPSession(page));
        await page.goto(harnessUrl(path, options));
        await blur(page);
        return page;
      },
      async reload(page, path, options) {
        // The harness rewrites its URL to the app path, which the preview server
        // does not serve, so load the harness entry again instead.
        forget(page);
        await page.goto(harnessUrl(path, options));
      },
      async focus(page) {
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
      },
      assertExclusiveOwner(page) {
        assert.deepEqual(overlaps, [], 'device engine generations must never overlap');
        assert.equal(activeEngines.size, 1, 'one engine must be observed for the ready owner');
        assert.equal([...activeEngines.values()][0], page, 'the ready tab owns the observed engine');
      },
    });
  } finally {
    await browser?.close();
    if (server) await new Promise<void>(resolve => server!.httpServer!.close(() => resolve()));
    await rm(scratch, { recursive: true, force: true });
    await rm(profile, { recursive: true, force: true });
  }
}

test('focused tabs hand off one device generation and recover from timeout', { timeout: 90_000 }, () => withHarness(async ({
  open, focus, assertExclusiveOwner,
}) => {
  const first = await open('/channels/first', { holdSync: true });
  await focus(first);
  await first.evaluate(() => window.__tabHandoff.whenPhase('initializing_device'));
  assert.equal(await first.getByTestId('live-room').count(), 0, 'initial sync has no channel capability');
  await first.evaluate(() => window.__tabHandoff.releaseSync());
  await first.getByTestId('live-room').waitFor();
  assertExclusiveOwner(first);
  const second = await open('/new');
  await second.getByRole('heading', { name: 'Device handoff took too long' }).waitFor();
  assert.equal(await second.locator('.khala-owner-shell').count(), 1, 'handoff timeout stays in the channel shell');
  assert.equal(await first.evaluate(() => document.hasFocus()), true);
  assert.equal(await first.evaluate(() => window.__tabHandoff.phase()), 'ready');
  assert.equal(await first.getByTestId('live-room').count(), 1, 'the owner stays usable until focus moves');
  assert.equal(await second.getByRole('button', { name: 'Try again in this tab' }).count(), 1);
  await focus(first);
  await focus(second);
  await second.evaluate(() => window.__tabHandoff.whenPhase('ready'));
  await first.getByRole('heading', { name: 'Khala is active in another tab' }).waitFor();
  assert.equal(await first.locator('.khala-owner-shell').count(), 1, 'inactive tab keeps the channel shell');
  assert.equal(await first.getByTestId('live-room').count(), 0);
  assertExclusiveOwner(second);

  await focus(first);
  await first.getByTestId('live-room').waitFor();
  await second.getByRole('heading', { name: 'Khala is active in another tab' }).waitFor();
  assertExclusiveOwner(first);

  await first.evaluate(() => window.__tabHandoff.holdStop());
  await focus(second);
  await second.getByRole('heading', { name: 'Device handoff took too long' }).waitFor();
  await first.evaluate(() => window.__tabHandoff.releaseStop());
  await second.getByRole('button', { name: 'Try again in this tab' }).click();
  await second.evaluate(() => window.__tabHandoff.whenPhase('ready'));
  assertExclusiveOwner(second);

  const closing = await open('/channels/third');
  await focus(closing);
  await closing.close();
  await focus(second);
  await second.evaluate(() => window.__tabHandoff.whenPhase('ready'));

  await second.close();
  await focus(first);
  await first.getByTestId('live-room').waitFor();
  assertExclusiveOwner(first);
}));

// aiur-team/khala#1087. From the reload on, a Firefox permission prompt that is
// never answered holds focus outside the owner's page and keeps
// `navigator.storage.persist()` pending.
test('a reloaded owner tab takes the device back after the other tab closes', { timeout: 90_000 }, () => withHarness(async ({
  open, reload, focus, assertExclusiveOwner,
}) => {
  const quickly = { timeout: 5_000 };
  const unansweredPrompt = true;
  const first = await open('/channels/first');
  await focus(first);
  await first.getByTestId('live-room').waitFor();
  const confirm = await open('/agent/confirm');
  await focus(confirm);
  await confirm.evaluate(() => window.__tabHandoff.whenPhase('ready'));
  assertExclusiveOwner(confirm);

  await reload(first, '/channels/first', { unansweredPrompt });
  await first.getByRole('heading', { name: 'Khala is active in another tab' }).waitFor(quickly);

  await confirm.close();
  await first.getByRole('button', { name: 'Try again in this tab' }).click();
  await first.getByTestId('live-room').waitFor(quickly);
  assertExclusiveOwner(first);

  await first.close();
  const fresh = await open('/channels/first', { unansweredPrompt });
  await fresh.getByTestId('live-room').waitFor(quickly);
  assert.deepEqual((await fresh.evaluate(() => window.__tabHandoff.phases())).filter(phase => phase === 'inactive'), [],
    'a new tab never reports another tab when none exists');
  assertExclusiveOwner(fresh);
}));
