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

test('AE1/AE3/AE5: onboarding, live presence, and injected channel-slot stubs work at desktop and phone width', { timeout: 90_000 }, async () => {
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

    await page.getByRole('heading', { name: 'Release channel' }).waitFor();
    await page.getByRole('heading', { name: 'Connect Scout' }).waitFor();
    await page.getByText('Khala skill', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Copy install command' }).waitFor();
    await page.getByRole('button', { name: 'Send message' }).waitFor();
    await page.getByRole('heading', { name: 'Pending release' }).waitFor();
    await page.getByRole('heading', { name: 'Agent controls' }).waitFor();

    await page.getByRole('button', { name: 'Copy install command' }).click();
    await page.getByRole('button', { name: 'Copied' }).waitFor();
    await page.getByText('Install command copied.').waitFor();

    await page.getByRole('button', { name: 'Simulate agent connection' }).click();
    await page.getByText('Connected', { exact: true }).waitFor();
    await page.getByText('Codex CLI', { exact: true }).waitFor();
    await page.getByText('Added to agent context').waitFor();
    await page.getByText('Batch-token return supported', { exact: true }).waitFor();
    assert.equal(await page.getByText('Read by the agent').count(), 0, 'context insertion is never labelled read');
    assert.equal(await page.getByRole('button', { name: 'Copy install command' }).count(), 0);

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
    await page.getByText('Connection stale', { exact: true }).waitFor();

    // Reload to restore the disconnected fixture, then force clipboard denial
    // and verify the failure is visible and announced.
    await page.reload();
    await page.getByRole('button', { name: 'Copy install command' }).waitFor();
    await page.evaluate("Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: function () { return Promise.reject(new Error('clipboard denied')); } })");
    await page.getByRole('button', { name: 'Copy install command' }).click();
    await page.getByRole('button', { name: 'Copy failed' }).waitFor();
    await page.getByText('Install command could not be copied.').waitFor();
  } finally {
    await browser?.close();
    if (server) await new Promise<void>(resolve => server!.httpServer!.close(() => resolve()));
    await rm(outDir, { recursive: true, force: true });
    await rm(chromiumProfileRoot, { recursive: true, force: true });
  }
});
