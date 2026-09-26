// Real-HTTP journey for the owner UI (channel requests and discovery settings):
// the production local bundle is built with Vite and served by the real loopback
// channel server, then driven in Chromium under the server's strict CSP. The
// server must answer the app shell on every owner route, for direct loads and reloads.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from '@playwright/test';
import { build } from 'vite';
import { startChannelServer } from '../../../internal/src/server/channel-server';
import { channelId, createChannelFixture } from '../../../internal/src/server/fixtures/channel-fixture';
import { webBundleManifest } from '../../../internal/src/launcher/bundle';
import type { LoopbackServer } from '../../../internal/src/server/server';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('owner UI: settings and channel requests load, reload and navigate over real HTTP', { timeout: 240_000 }, async () => {
  const base = fs.realpathSync(fs.mkdtempSync('/tmp/khala-owner-ui-'));
  const chromiumProfileRoot = fs.mkdtempSync('/tmp/khala-owner-ui-profile-');
  const bundle = path.join(base, 'internal-web');
  const storeRoot = path.join(base, 'store');
  fs.mkdirSync(storeRoot);
  let server: LoopbackServer | undefined;
  let browser: Browser | undefined;
  const fixture = createChannelFixture({ root: storeRoot, now: Date.now() });
  try {
    await build({ configFile: path.join(webRoot, 'vite.internal.config.mjs'), logLevel: 'silent', build: { outDir: bundle, emptyOutDir: true } });
    let id = 0;
    server = await startChannelServer({
      store: fixture.store,
      bootstrap: [fixture.bootstrap],
      bindings: [fixture.bob],
      newId: () => `evt-${Date.now()}-${++id}`,
      clock: Date.now,
      startPort: 0,
      assets: webBundleManifest(bundle),
    });
    const origin = server.origin;

    // The server itself answers the app shell on every owner route.
    const requestHandle = `careq_${'A'.repeat(43)}`;
    for (const route of [`/channels/${channelId}/settings`, '/channel-requests', `/channel-requests/${requestHandle}`]) {
      const response = await fetch(`${origin}${route}`);
      assert.equal(response.status, 200, route);
      assert.match(response.headers.get('content-type') ?? '', /^text\/html/, route);
    }

    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
      headless: true,
      args: ['--no-sandbox'],
      env: { ...process.env, TMPDIR: chromiumProfileRoot },
    });
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
    const violations: string[] = [];
    page.on('console', entry => {
      if (/Content Security Policy|Refused to/i.test(entry.text())) violations.push(entry.text());
    });

    await page.goto(`${origin}/__khala/bootstrap#credential=${fixture.bootstrap.credential}&channel=${channelId}`);
    await page.waitForURL(`${origin}/channels/${channelId}`);

    // The settings link is a client navigation: the document is not reloaded.
    await page.evaluate(() => { (window as unknown as { marker: string }).marker = 'same-document'; });
    await page.getByRole('link', { name: 'Channel discovery settings' }).click();
    await page.waitForURL(`${origin}/channels/${channelId}/settings`);
    await page.getByRole('heading', { name: 'Channel discovery settings' }).waitFor();
    assert.equal(await page.evaluate(() => (window as unknown as { marker?: string }).marker), 'same-document');

    // Direct load and reload of the settings page both render.
    await page.goto(`${origin}/channels/${channelId}/settings`);
    await page.getByRole('heading', { name: 'Channel discovery settings' }).waitFor();
    await page.reload();
    await page.getByRole('heading', { name: 'Channel discovery settings' }).waitFor();

    // The inbox navigation entry is a client navigation too, and its page survives direct load and reload.
    await page.evaluate(() => { (window as unknown as { marker: string }).marker = 'same-document'; });
    await page.getByRole('link', { name: /Channel requests/ }).click();
    await page.waitForURL(`${origin}/channel-requests`);
    await page.getByRole('heading', { name: 'Channel requests', level: 1 }).waitFor();
    assert.equal(await page.evaluate(() => (window as unknown as { marker?: string }).marker), 'same-document');
    await page.goto(`${origin}/channel-requests`);
    await page.getByRole('heading', { name: 'Channel requests', level: 1 }).waitFor();
    await page.reload();
    await page.getByRole('heading', { name: 'Channel requests', level: 1 }).waitFor();
    assert.equal(await page.getByRole('link', { name: /Channel requests/ }).getAttribute('aria-current'), 'page');

    // A selected request path loads the app rather than a server 404.
    const selected = await page.goto(`${origin}/channel-requests/${requestHandle}`);
    assert.equal(selected?.status(), 200);
    await page.getByRole('heading', { name: 'Channel requests', level: 1 }).waitFor();

    // Live announcements: the inbox status is a polite live region.
    await page.goto(`${origin}/channel-requests`);
    await page.getByRole('status').first().waitFor();
    assert.equal(await page.getByRole('status').first().getAttribute('aria-live'), 'polite');

    // Narrow viewport: no horizontal overflow, and interactive controls keep a 44px touch target.
    await page.setViewportSize({ width: 320, height: 640 });
    for (const route of ['/channel-requests', `/channels/${channelId}/settings`]) {
      await page.goto(`${origin}${route}`);
      await page.getByRole('heading', { level: 1 }).or(page.getByRole('heading').first()).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${route} overflows at 320px`);
      for (const control of await page.locator('main button, main a[href]').all()) {
        if (!(await control.isVisible())) continue;
        const box = await control.boundingBox();
        assert.ok(box && box.height >= 44 - 0.5 && box.width >= 44 - 0.5, `${route}: control ${JSON.stringify(box)} is under 44px (${await control.innerText()})`);
      }
    }

    // Keyboard focus reaches the navigation entry and shows as focused.
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${origin}/channel-requests`);
    await page.getByRole('link', { name: /Channel requests/ }).focus();
    assert.equal(await page.evaluate(() => document.activeElement?.className), 'channel-requests-nav');

    assert.deepEqual(violations, []);
  } finally {
    await browser?.close();
    await server?.close();
    fixture.dispose();
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(chromiumProfileRoot, { recursive: true, force: true });
  }
});
