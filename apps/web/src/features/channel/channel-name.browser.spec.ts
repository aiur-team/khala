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
  const chromiumProfileRoot = await mkdtemp('/tmp/khala-1225-name-profile-');
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
    await page.getByRole('button', { name: /Launch plans/ }).click();
    await page.locator('.kh-roster .kh-aav').first().waitFor();
    const avatar = page.locator('.kh-stack .kh-aav');
    assert.equal(await avatar.locator('.kh-ini').textContent(), 'AC');
    assert.equal(await avatar.locator('.kh-own').textContent(), 'AC');
    if (screenshots) {
      await mkdir(screenshots, { recursive: true });
      for (const theme of ['light', 'dark']) {
        for (const width of [390, 1280]) {
          await page.setViewportSize({ width, height: 844 });
          await page.goto(`${url}?as=first&theme=${theme}`);
          await page.getByRole('button', { name: /Launch plans/ }).click();
          await page.locator('.kh-roster .kh-aav').first().waitFor();
          await page.screenshot({ path: join(screenshots, `agent-initials-${theme}-${width}.png`) });
        }
      }
    }

    // The later one is, with the name plus the lowest free number already filled in.
    await page.goto(url);
    const dialog = page.getByRole('region', { name: 'Your name in this channel' });
    await dialog.waitFor();
    assert.equal(await page.getByRole('dialog').count(), 0);
    assert.equal(await dialog.locator('.kh-cname-note').textContent(), 'Someone here is already alice.');
    const field = dialog.getByRole('textbox', { name: 'Your name in this channel' });
    assert.equal(await field.inputValue(), 'alice2');
    assert.notEqual(await focused(page), 'input', 'notice does not steal focus');
    const save = dialog.getByRole('button', { name: 'Save', exact: true });
    await field.focus();
    await page.keyboard.press('Shift+Tab');
    assert.equal(await dialog.evaluate(notice => notice.contains(document.activeElement)), false, 'Tab can leave the notice');
    await page.getByRole('button', { name: /Launch plans/ }).click();
    assert.equal(await dialog.isVisible(), true, 'channel remains usable with the notice open');

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
          await shot.getByRole('region', { name: 'Your name in this channel' }).waitFor();
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
    await page.getByRole('region', { name: 'Your name in this channel' }).waitFor();
    assert.equal(await page.getByRole('textbox', { name: 'Your name in this channel' }).inputValue(), 'alice3');

    // Phone width: the notice fits without horizontal scrolling and Save is full width.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(url);
    await page.getByRole('region', { name: 'Your name in this channel' }).waitFor();
    assert.equal(await noOverflow(page), true);
    const box = (await page.locator('.kh-cname').boundingBox())!;
    assert.ok(box.x >= 15 && box.x + box.width <= 390 - 15, 'keeps a 16px gutter');
    await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
    assert.equal(await page.getByRole('region', { name: 'Your name in this channel' }).count(), 0);
    assert.deepEqual(await page.evaluate(() => window.__saved), [], 'dismiss does not rename');
    await page.getByRole('button', { name: /Launch plans/ }).click();
  } finally {
    await browser?.close();
    if (server) await new Promise<void>(resolve => server!.httpServer!.close(() => resolve()));
    await rm(outDir, { recursive: true, force: true });
    await rm(chromiumProfileRoot, { recursive: true, force: true });
  }
});

declare global { interface Window { __saved: string[] } }
