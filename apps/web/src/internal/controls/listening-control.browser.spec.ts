import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { build, preview, type PreviewServer } from 'vite';
import { chromium, type Browser, type Page } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const harnessRoot = join(here, 'listening-harness');

const calls = (page: Page) => page.evaluate(() => (window as unknown as { __calls: string[] }).__calls);

test('ListeningControl: a supported mode is chosen by keyboard, unproven modes stay disabled with the reason, pause and resume are announced', { timeout: 90_000 }, async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'khala-listening-control-dist-'));
  const chromiumProfileRoot = await mkdtemp(join('/tmp', 'khala-listening-control-profile-'));
  let server: PreviewServer | undefined;
  let browser: Browser | undefined;
  try {
    await build({ root: harnessRoot, build: { outDir, emptyOutDir: true }, logLevel: 'error' });
    server = await preview({ root: harnessRoot, build: { outDir }, preview: { host: '127.0.0.1', port: 0 } });
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
      headless: true,
      args: ['--no-sandbox'],
      env: { ...process.env, TMPDIR: chromiumProfileRoot },
    });
    const page = await browser.newPage({ viewport: { width: 1024, height: 900 } });
    await page.goto(server.resolvedUrls!.local[0]!);

    const status = page.locator('.listening-control__status[role="status"]');
    await status.waitFor({ state: 'attached' });
    assert.equal((await status.innerText()).trim(), '', 'the live region is mounted empty before any action');

    // Supported mode: Ada's Codex proves steer and sync; the owner moves from Sync to Steer by keyboard.
    const adaModes = page.getByRole('group', { name: 'Listening mode for Ada' });
    await adaModes.waitFor();
    await page.getByText('In effect: Sync.').waitFor();
    const sync = adaModes.getByRole('radio', { name: 'Sync', exact: true });
    assert.equal(await sync.isChecked(), true);
    await sync.focus();
    await page.keyboard.press('ArrowUp');
    await page.getByText('Ada: Steer requested.').waitFor();
    assert.equal(await adaModes.getByRole('radio', { name: 'Steer', exact: true }).isChecked(), true);
    await page.getByText('In effect: Steer.').waitFor();
    assert.deepEqual(await calls(page), ['mode:Ada:steer:v1']);

    // Unproven: Ada's async awaits a receipt proof; every Bea (Claude) mode is unproven. All stay visible and disabled.
    const adaAsync = adaModes.getByRole('radio', { name: 'Async (not proven for this agent)', exact: true });
    assert.equal(await adaAsync.isDisabled(), true);
    assert.match(await page.locator(`#${await adaAsync.getAttribute('aria-describedby')}`).innerText(), /Awaiting a receipt proof/);
    const beaModes = page.getByRole('group', { name: 'Listening mode for Bea' });
    for (const mode of ['Steer', 'Sync', 'Async']) {
      const radio = beaModes.getByRole('radio', { name: `${mode} (not proven for this agent)`, exact: true });
      assert.equal(await radio.isDisabled(), true, `${mode} is disabled for Bea`);
      assert.equal(await radio.isChecked(), false, `${mode} is not claimed for Bea`);
    }
    await page.getByText('Requested: none. Not in effect: no mode is proven for this agent\'s command-line tool, so none is requested.').waitFor();
    assert.match(await page.locator('.listening-control__agent', { has: beaModes }).innerText(), /Idle agents receive messages only at their next turn\./);

    // Pause and resume: announced, reflected in the agent's state, and the button flips.
    const pause = page.getByRole('button', { name: 'Pause delivery to Ada' });
    await pause.focus();
    await page.keyboard.press('Enter');
    await page.getByText('Delivery to Ada is paused. New messages wait until you resume.').waitFor();
    await page.getByText('Paused. Khala holds new messages for this agent until you resume.').waitFor();
    const resume = page.getByRole('button', { name: 'Resume delivery to Ada' });
    await resume.focus();
    await page.keyboard.press('Enter');
    await page.getByText('Delivery to Ada resumed.').waitFor();
    await page.getByRole('button', { name: 'Pause delivery to Ada' }).waitFor();
    assert.deepEqual(await calls(page), ['mode:Ada:steer:v1', 'pause:Ada:true', 'pause:Ada:false']);

    // A narrow viewport keeps every control without horizontal scrolling.
    await page.setViewportSize({ width: 320, height: 800 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, `no horizontal overflow at 320px (got ${overflow})`);
  } finally {
    await browser?.close();
    await server?.close();
    await rm(outDir, { recursive: true, force: true });
    await rm(chromiumProfileRoot, { recursive: true, force: true });
  }
});
