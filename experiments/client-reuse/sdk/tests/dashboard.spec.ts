import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { chromium, type Browser } from 'playwright';
import { preview } from 'vite';
import { basename } from 'node:path';

const candidate = basename(process.cwd());
test(`${candidate}: synthetic invitation, review, focus, mobile, and failure states`, { timeout: 60_000 }, async () => {
  const scratch = await mkdtemp(`${homedir()}/.cache/khala-client-reuse-`);
  let server: Awaited<ReturnType<typeof preview>> | undefined;
  let browser: Browser | undefined;
  try {
    server = await preview({ preview: { host: '127.0.0.1', port: 0 } });
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, env: { ...process.env, TMPDIR: scratch }, args: ['--no-sandbox'] });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const url = server.resolvedUrls!.local[0]!;
    await page.goto(url);
    await page.getByRole('button', { name: 'Continue with account (fixture)', exact: true }).click();
    await page.getByText('Encrypted message unavailable on this device', { exact: true }).waitFor();
    const review = page.getByRole('button', { name: 'Review selected batch', exact: true });
    await review.focus(); await page.keyboard.press('Enter');
    await page.getByRole('dialog').waitFor();
    assert.equal(await page.getByRole('button', { name: 'Close review' }).evaluate(node => node === document.activeElement), true);
    await page.keyboard.press('Escape');
    assert.equal(await review.evaluate(node => node === document.activeElement), true);
    await review.click(); await page.getByRole('button', { name: 'Approve fixture batch' }).click();
    await page.getByRole('status').filter({ hasText: 'Delivery unknown' }).waitFor();
    assert.equal(await review.isDisabled(), true);
    if (candidate === 'sdk') {
      await page.getByRole('button', { name: 'Toggle navigation' }).click();
      await page.getByRole('button', { name: 'Use light theme' }).click();
    }
    const usable = async (layout: string) => {
      assert(await page.getByRole('region', { name: 'Timeline' }).isVisible(), `${layout}: timeline visible`);
      assert(await review.isVisible(), `${layout}: review control visible`);
    };
    await usable('desktop');
    await mkdir('evidence', { recursive: true });
    await page.screenshot({ path: 'evidence/desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no long-message horizontal overflow');
    await usable('narrow');
    await page.screenshot({ path: 'evidence/mobile.png', fullPage: true });
    if (candidate === 'sdk') {
      await page.goto(url + '?embedded=1');
      assert.equal(await page.getByRole('navigation').count(), 0);
      await page.getByRole('heading', { name: 'Khala', exact: true }).waitFor();
    } else {
      await page.goto(url + '?failure=1');
      await page.getByRole('alert').filter({ hasText: 'module failed to load' }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'Review selected batch', exact: true }).count(), 0);
    }
    console.log(JSON.stringify({ candidate, browser: browser.version(), viewport: [1440, 1000, 390, 844], evidence: 'synthetic presentation and module loader only', passed: true }));
  } finally {
    await browser?.close();
    if (server) await new Promise<void>(resolve => server!.httpServer!.close(() => resolve()));
    await rm(scratch, { recursive: true, force: true });
  }
});
