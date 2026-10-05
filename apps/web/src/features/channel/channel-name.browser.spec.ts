import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from '@playwright/test';
import { build, preview, type PreviewServer } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const harnessRoot = join(here, 'name-harness');
// Set KHALA_SCREENSHOT_DIR to keep light and dark captures at 390 and 1280 px.
const screenshots = process.env.KHALA_SCREENSHOT_DIR;
const focused = (page: Page) => page.evaluate(() => document.activeElement?.tagName.toLowerCase() ?? null);
const noOverflow = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

test('a human who meets someone with the same name picks a name for this channel only', { timeout: 120_000 }, async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'khala-channel-name-dist-'));
  const chromiumProfileRoot = await mkdtemp('/tmp/khala-channel-name-profile-');
  let server: PreviewServer | undefined;
  let browser: Browser | undefined;
  try {
    await build({ root: harnessRoot, build: { outDir, emptyOutDir: true }, logLevel: 'error' });
    server = await preview({ root: harnessRoot, build: { outDir }, preview: { host: '127.0.0.1', port: 0 } });
    const url = server.resolvedUrls!.local[0]!;
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true,
      args: ['--no-sandbox'], env: { ...process.env, TMPDIR: chromiumProfileRoot } });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();

    // The person who held the name first is never asked.
    await page.goto(`${url}?as=first`);
    await page.getByText('alice: Shall we ship on Friday?').waitFor();
    assert.equal(await page.getByRole('dialog').count(), 0);

    // The later one is, with the name plus the lowest free number already filled in and selected.
    await page.goto(url);
    const dialog = page.getByRole('dialog', { name: 'Your name in this channel' });
    await dialog.waitFor();
    assert.equal(await dialog.getAttribute('aria-modal'), 'true');
    assert.equal(await dialog.locator('.kh-cname-note').textContent(), 'Someone here is already alice.');
    const field = dialog.getByRole('textbox', { name: 'Your name in this channel' });
    assert.equal(await field.inputValue(), 'alice2');
    assert.equal(await focused(page), 'input');
    assert.equal(await field.evaluate(input => (input as HTMLInputElement).selectionEnd - (input as HTMLInputElement).selectionStart), 6);
    const save = dialog.getByRole('button', { name: 'Save' });
    assert.equal(await dialog.getByRole('button').count(), 1, 'Save is the only action');

    // Focus stays inside the modal.
    await page.keyboard.press('Tab');
    assert.equal(await focused(page), 'button');
    await page.keyboard.press('Tab');
    assert.equal(await focused(page), 'input');

    // A name someone here holds, or an invalid one, cannot be saved.
    await field.fill('Alice');
    assert.equal(await dialog.getByRole('alert').textContent(), 'Someone here already uses that name.');
    assert.equal(await save.isDisabled(), true);
    await field.fill('a');
    assert.equal(await dialog.getByRole('alert').textContent(), 'At least 2 characters.');
    await field.fill('alice2');
    assert.equal(await save.isDisabled(), false);

    if (screenshots) {
      await mkdir(screenshots, { recursive: true });
      for (const theme of ['light', 'dark'] as const) {
        for (const width of [390, 1280]) {
          const shot = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 800 } });
          await shot.goto(`${url}?theme=${theme}`);
          await shot.getByRole('dialog').waitFor();
          assert.equal(await noOverflow(shot), true, `no horizontal scroll at ${width}px`);
          await shot.screenshot({ path: join(screenshots, `channel-name-${theme}-${width}.png`) });
          await shot.close();
        }
      }
    }

    // Save sets the name here and the rename shows as a pill; the prompt is gone.
    await save.click();
    await dialog.waitFor({ state: 'detached' });
    assert.deepEqual(await page.evaluate(() => window.__saved), ['alice2']);
    assert.equal(await page.getByRole('status').filter({ hasText: 'alice is now alice2' }).count(), 1);

    // Existing numbered names are skipped: with an alice2 here, the suggestion is alice3.
    await page.goto(`${url}?gap`);
    await page.getByRole('dialog').waitFor();
    assert.equal(await page.getByRole('textbox', { name: 'Your name in this channel' }).inputValue(), 'alice3');

    // Phone width: the modal fits without horizontal scrolling and Save is full width.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(url);
    await page.getByRole('dialog').waitFor();
    assert.equal(await noOverflow(page), true);
    const box = (await page.locator('.kh-cname').boundingBox())!;
    assert.ok(box.x >= 15 && box.x + box.width <= 390 - 15, 'keeps a 16px gutter');
  } finally {
    await browser?.close();
    if (server) await new Promise<void>(resolve => server!.httpServer!.close(() => resolve()));
    await rm(outDir, { recursive: true, force: true });
    await rm(chromiumProfileRoot, { recursive: true, force: true });
  }
});

declare global { interface Window { __saved: string[] } }
