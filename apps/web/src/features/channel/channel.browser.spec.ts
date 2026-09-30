import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from '@playwright/test';
import { build, preview, type PreviewServer } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const harnessRoot = join(here, 'browser-harness');

test('channel chat keeps messaging reachable without a details pane at desktop and phone width', { timeout: 90_000 }, async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'khala-channel-dist-'));
  // Chromium's singleton socket has a strict path-length cap; the workspace's
  // private TMPDIR is too deep, while mkdtemp keeps this shared /tmp path unique.
  const chromiumProfileRoot = await mkdtemp('/tmp/khala-channel-profile-');
  let server: PreviewServer | undefined;
  let browser: Browser | undefined;
  try {
    await build({ root: harnessRoot, build: { outDir, emptyOutDir: true }, logLevel: 'error' });
    server = await preview({ root: harnessRoot, build: { outDir }, preview: { host: '127.0.0.1', port: 0 } });
    const url = server.resolvedUrls!.local[0]!;
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
      headless: true,
      args: ['--no-sandbox'],
      env: { ...process.env, TMPDIR: chromiumProfileRoot },
    });
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
    await page.goto(url);

    await page.getByText('Release channel').first().waitFor();
    await page.getByRole('button', { name: 'Send message' }).waitFor();
    const toolbar = page.locator('#khala-channel-toolbar');
    const disclosure = toolbar.locator('summary');
    await disclosure.waitFor();
    assert.equal(await page.locator('.conversation-thread__head').count(), 0, 'channel uses one top bar');
    const thread = await page.locator('.conversation-thread').boundingBox();
    const main = await page.locator('.khala-content-main').boundingBox();
    assert.ok(thread && main && thread.width >= main.width - 2, 'thread fills available content width');
    assert.equal(await page.getByRole('button', { name: 'Channel details' }).count(), 0);
    assert.equal(await page.locator('.conversation-detail').count(), 0);

    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
      true,
      'phone layout has no horizontal overflow',
    );
    assert.equal(await page.getByRole('button', { name: 'Send message' }).isVisible(), true, 'injected composer stub remains reachable');
    assert.equal(await page.getByText('Can you check the deployment?').isVisible(), true, 'injected timeline stub remains visible');
    await page.getByLabel('Message').fill('Please verify the release.');
    await page.getByRole('button', { name: 'Send message' }).click();
    await page.getByText('Please verify the release.').waitFor();
    await page.getByText('Sending…').waitFor();
    await page.getByText('Sending…').waitFor({ state: 'detached' });
    await page.getByText('Deployment is healthy.').waitFor();
    await page.reload();
    assert.equal(await page.getByRole('button', { name: 'Channel details' }).count(), 0);
    await page.getByRole('button', { name: 'Show two agents' }).click();
    assert.equal(await page.locator('.channel-participants__chip').count(), 3);
    assert.equal(await page.locator('.channel-participants__chip').last().evaluate(node => getComputedStyle(node).display !== 'none'), true,
      'the last known agent remains reachable in the narrow participant row');
    await disclosure.click();
    assert.equal(await toolbar.locator('details').getAttribute('open'), '');
    await page.getByRole('heading', { name: 'Builder' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Edit name for Scout' }).count(), 1);
    assert.equal(await page.getByRole('button', { name: 'Edit name for Builder' }).count(), 0);
    await page.getByRole('button', { name: 'Edit name for Scout' }).click();
    await page.getByRole('textbox', { name: 'Agent name' }).fill('Dolan');
    await page.getByRole('button', { name: 'Save name' }).click();
    await page.getByText('Scout is now called Dolan · changed by Mira').waitFor();
    await page.getByRole('heading', { name: 'Dolan' }).waitFor();
    await disclosure.click();
    await page.getByRole('button', { name: 'Switch human' }).click();
    await disclosure.click();
    await page.getByRole('button', { name: 'Edit name for Builder' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Edit name for Dolan' }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Edit name for Builder' }).count(), 1);
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.goto(url + '?standalone');
    const inlineHeader = page.locator('.conversation-thread__head');
    await inlineHeader.locator('summary').click();
    await inlineHeader.getByRole('heading', { name: 'Release channel' }).waitFor();
    const headerBox = await inlineHeader.boundingBox();
    const panelBox = await page.locator('.channel-roster__panel').boundingBox();
    assert.ok(headerBox && panelBox && panelBox.y >= headerBox.y + headerBox.height - 1 && panelBox.y < 200,
      'standalone participant details expand directly below their header');
  } finally {
    await browser?.close();
    if (server) await new Promise<void>(resolve => server!.httpServer!.close(() => resolve()));
    await rm(outDir, { recursive: true, force: true });
    await rm(chromiumProfileRoot, { recursive: true, force: true });
  }
});
