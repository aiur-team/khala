import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { build, preview, type PreviewServer } from 'vite';
import { chromium, type Browser, type Page } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const harnessRoot = join(here, 'browser-harness');

const bob = { bindingId: 'binding-bob', generation: 1, harness: 'codex', agentParticipantId: 'participant-bob' };
const carol = { bindingId: 'binding-carol', generation: 1, harness: 'claude', agentParticipantId: 'participant-carol' };

const focusedText = (page: Page) => page.evaluate(() => document.activeElement?.textContent?.trim() ?? '');
const release = (page: Page, outcome: unknown) => page.evaluate(value => {
  (window as unknown as { __releaseStop(outcome: unknown): void }).__releaseStop(value);
}, outcome);

test('StopControl is keyboard operable: confirm, cancel, single submission, partial retry and announced success', { timeout: 90_000 }, async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'khala-stop-control-dist-'));
  const chromiumProfileRoot = await mkdtemp(join('/tmp', 'khala-stop-control-profile-'));
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

    const status = page.locator('.stop-control__status[role="status"]');
    await status.waitFor({ state: 'attached' });
    assert.equal((await status.innerText()).trim(), '', 'the live region is mounted empty before any action');

    // Keyboard only: reach Stop, open the confirmation, Escape returns focus to Stop.
    const stopButton = page.getByRole('button', { name: 'Stop agent delivery' });
    await stopButton.focus();
    await page.keyboard.press('Enter');
    await page.getByRole('group', { name: 'Stop delivery to agents in this channel?' }).waitFor();
    assert.equal(await focusedText(page), 'Stop delivery to agents in this channel?');
    await page.keyboard.press('Escape');
    await stopButton.waitFor();
    assert.equal(await focusedText(page), 'Stop agent delivery');
    assert.equal(await page.evaluate(() => (window as unknown as { __stopCalls: number }).__stopCalls), 0, 'cancel sends nothing');

    // Confirm; while in flight both actions are disabled and repeat presses send nothing.
    await page.keyboard.press('Enter');
    await page.keyboard.press('Tab');
    assert.equal(await focusedText(page), 'Stop delivery');
    await page.keyboard.press('Enter');
    await page.getByText('Stopping agent delivery…').waitFor();
    assert.equal(await page.getByRole('button', { name: 'Stopping…' }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Cancel' }).isDisabled(), true);
    assert.equal(await focusedText(page), 'Stop delivery to agents in this channel?', 'focus stays on the question, not the page');
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => (window as unknown as { __stopCalls: number }).__stopCalls), 1);

    // Partial: an alert names the remaining binding, takes focus, and offers retry.
    await release(page, { kind: 'partial', stopped: [bob], remaining: [{ ...carol, reason: 'revoke_failed' }] });
    const alert = page.getByRole('alert');
    await alert.waitFor();
    assert.match(await alert.innerText(), /claude agent \(participant-carol, binding binding-carol\): its binding could not be revoked/);
    assert.equal(await focusedText(page), 'Stop did not finish');
    await page.keyboard.press('Tab');
    assert.equal(await focusedText(page), 'Retry Stop');
    await page.keyboard.press('Enter');
    await release(page, { kind: 'stopped', stopped: [carol] });

    // Success is announced, takes focus, and links into the channel access flow.
    await page.getByRole('heading', { name: 'Agent delivery stopped' }).waitFor();
    assert.equal(await focusedText(page), 'Agent delivery stopped');
    assert.match(await status.innerText(), /Agent delivery stopped\. 1 agent binding was revoked\./);
    assert.equal(await page.getByRole('link', { name: 'Channel link for a new access request' }).getAttribute('href'),
      'http://127.0.0.1:4871/channels/ch_harness');

    // A narrow viewport keeps the outcome and actions without horizontal scrolling.
    await page.setViewportSize({ width: 320, height: 800 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, `no horizontal overflow at 320px (got ${overflow})`);
    assert.equal(await page.getByRole('button', { name: 'Stop agent delivery' }).isVisible(), true);
  } finally {
    await browser?.close();
    await server?.close();
    await rm(outDir, { recursive: true, force: true });
    await rm(chromiumProfileRoot, { recursive: true, force: true });
  }
});
