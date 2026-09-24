import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from '@playwright/test';
import { build, preview, type PreviewServer } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const harnessRoot = join(here, 'browser-harness');

async function withHarness(
  run: (page: Page) => Promise<void>,
  viewport: { width: number; height: number } = { width: 1024, height: 900 },
): Promise<void> {
  const outDir = await mkdtemp(join(tmpdir(), 'khala-recovery-dist-'));
  const chromiumProfileRoot = await mkdtemp(join('/tmp', 'khala-recovery-profile-'));
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
    const page = await browser.newPage({ viewport });
    await page.goto(server.resolvedUrls!.local[0]!);
    await page.getByRole('heading', { name: 'Recovery and channel access' }).waitFor();
    await run(page);
  } finally {
    await browser?.close();
    if (server) await new Promise<void>(resolve => server!.httpServer!.close(() => resolve()));
    await rm(outDir, { recursive: true, force: true });
    await rm(chromiumProfileRoot, { recursive: true, force: true });
  }
}

test('P14 recovery refusal is stable and exposes no setup or recovery-key flow', { timeout: 90_000 }, async () => {
  await withHarness(async page => {
    await page.getByText('Recovery is not available.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: /^(Recover with|Configure)/i }).count(), 0);
    assert.equal(await page.getByLabel(/Recovery secret/i).count(), 0);
    await page.evaluate(() => window.__recoveryHarness.emitUnchanged());
    await page.evaluate(() => window.__recoveryHarness.emitUnchanged());
    const audit = await page.evaluate(() => window.__recoveryHarness.getAudit());
    assert.equal(audit.promptCount, 0, 'capability refusal never prompts for recovery material');
  });
});

test('unknown revocation inspects the original operation identity', { timeout: 90_000 }, async () => {
  await withHarness(async page => {
    await page.evaluate(() => window.__recoveryHarness.setRevocationOutcome('unknown'));
    const trigger = page.getByRole('button', { name: /Revoke binding/ });
    await trigger.focus();
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Confirm revocation' }).press('Enter');
    await page.getByText('Revocation outcome unknown', { exact: true }).waitFor();
    const before = await page.evaluate(() => window.__recoveryHarness.getAudit());
    assert.equal(before.revokeCount, 1);
    assert.ok(before.lastRevocationOperationId);

    await page.getByRole('button', { name: 'Inspect operation' }).click();
    await page.getByText('Revocation complete', { exact: true }).waitFor();
    const after = await page.evaluate(() => window.__recoveryHarness.getAudit());
    assert.equal(after.inspectedRevocationOperationId, before.lastRevocationOperationId);
  });
});

test('closure confirmation dispatches once and navigates once', { timeout: 90_000 }, async () => {
  await withHarness(async page => {
    await page.getByRole('button', { name: 'Close channel' }).click();
    await page.getByRole('button', { name: 'Confirm channel closure' }).press('Enter');
    await page.getByText('Closure complete', { exact: true }).waitFor();
    const audit = await page.evaluate(() => window.__recoveryHarness.getAudit());
    assert.equal(audit.closeCount, 1);
    assert.ok(audit.lastClosureOperationId);
    assert.equal(await page.evaluate(() => window.__recoveryHarness.getClosureCompleteCount()), 1);
  });
});

test('failed and unknown closure outcomes do not navigate', { timeout: 90_000 }, async () => {
  for (const outcome of ['failed', 'unknown'] as const) {
    await withHarness(async page => {
      await page.evaluate(value => window.__recoveryHarness.setClosureOutcome(value), outcome);
      await page.getByRole('button', { name: 'Close channel' }).click();
      await page.getByRole('button', { name: 'Confirm channel closure' }).press('Enter');
      await page.getByText(outcome === 'failed' ? 'Closure failed' : 'Closure outcome unknown', { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.__recoveryHarness.getClosureCompleteCount()), 0);
    });
  }
});

test('controller replacement ignores a stale closure completion emitted during rerender', { timeout: 90_000 }, async () => {
  await withHarness(async page => {
    await page.evaluate(() => window.__recoveryHarness.activateControllerReplacementProbe());
    await page.locator('[data-probe-controller="old"]').waitFor();

    await page.evaluate(() => window.__recoveryHarness.replaceControllerAsOldClosureCompletes());
    await page.locator('[data-probe-controller="current"]').waitFor();
    await page.getByText('Recovery is not available.', { exact: true }).waitFor();

    assert.equal(await page.getByText('Closure complete', { exact: true }).count(), 0);
    assert.equal(await page.evaluate(() => window.__recoveryHarness.getClosureCompleteCount()), 0);
  });
});

test('keyboard cancel closes confirmation and restores focus without dispatching', { timeout: 90_000 }, async () => {
  await withHarness(async page => {
    const trigger = page.getByRole('button', { name: 'Close channel' });
    await trigger.focus();
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Cancel' }).press('Enter');

    await page.waitForFunction(() => document.activeElement?.textContent === 'Close channel');
    assert.equal(await page.getByRole('button', { name: 'Confirm channel closure' }).count(), 0);
    assert.equal((await page.evaluate(() => window.__recoveryHarness.getAudit())).closeCount, 0);
    assert.equal(await page.evaluate(() => window.__recoveryHarness.getClosureCompleteCount()), 0);
  });
});

test('U4 390px and 320px at 200% text keep consequences and actions complete without clipping', { timeout: 90_000 }, async () => {
  for (const layout of [
    { width: 390, scale: 1 },
    { width: 320, scale: 2 },
  ]) {
    await withHarness(async page => {
      if (layout.scale === 2) await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
      await page.getByRole('button', { name: 'Close channel' }).click();
      const confirmation = page.locator('.recovery-panel__confirmation').filter({ hasText: 'Close channel room_synthetic?' });
      await confirmation.getByText('Copies already delivered to participants or models cannot be recalled.').waitFor();
      await confirmation.getByText(/no retention window or global erasure/).waitFor();
      await confirmation.getByRole('button', { name: 'Confirm channel closure' }).waitFor();
      await confirmation.getByRole('button', { name: 'Cancel' }).waitFor();

      const metrics = await page.evaluate(() => ({
        documentWidth: document.documentElement.scrollWidth,
        viewportWidth: document.documentElement.clientWidth,
        clipped: [...document.querySelectorAll('.recovery-panel__confirmation, .recovery-panel__confirmation *')]
          .some(element => element.scrollWidth > element.clientWidth + 1),
        overflow: [...document.querySelectorAll<HTMLElement>('body *')]
          .filter(element => element.getBoundingClientRect().right > document.documentElement.clientWidth + 1)
          .map(element => `${element.tagName}.${element.className}:${Math.ceil(element.getBoundingClientRect().right)}`)
          .slice(0, 8),
      }));
      assert.ok(
        metrics.documentWidth <= metrics.viewportWidth,
        `${layout.width}px layout has no horizontal page overflow: ${JSON.stringify(metrics)}`,
      );
      assert.equal(metrics.clipped, false, `${layout.width}px layout has no clipped confirmation content`);
    }, { width: layout.width, height: 1000 });
  }
});
