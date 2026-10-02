import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { build, preview, type PreviewServer } from 'vite';
import { chromium, type Browser, type Page } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const harnessRoot = join(here, 'composer-harness');

// Reduced motion leaves a 0.01ms transition on every property; measure after it lands.
const settle = (page: Page) => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const heightOf = async (page: Page) => {
  await settle(page);
  return page.locator('#kh-input').evaluate(node => node.getBoundingClientRect().height);
};

/** The computed colour of `.kh-chip-h` for Maya, and of a probe set to `expected`. */
const chipColour = (page: Page, expected: string) => page.locator('.kh-chip-h[data-kh-mention="p-maya"]').evaluate((node, value) => {
  const probe = document.createElement('span');
  probe.style.color = value;
  document.body.append(probe);
  const want = getComputedStyle(probe).color;
  probe.remove();
  return { got: getComputedStyle(node).color, want };
}, expected);

// The mention chips and composer (RECREATION-SPEC §9, §10) inside the Khala
// frame, with synthetic targets.
test('composer chips keep the D1 colours, autosize to 140px and scroll on a phone', { timeout: 90_000 }, async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'khala-composer-dist-'));
  // Chromium's profile socket path is length-capped; keep it under the system tmp root.
  const chromiumProfileRoot = await mkdtemp(join('/tmp', 'khala-composer-profile-'));
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
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    await page.goto(url);
    await page.locator('.kh-comp').waitFor();

    // D1: the human chip is light-on-dark in the dark theme, dark-on-light in the light theme.
    const dark = await chipColour(page, 'hsl(330 70% 72%)');
    assert.equal(dark.got, dark.want, 'dark human chip colour');
    await page.goto(`${url}?theme=light`);
    await page.locator('.kh-comp').waitFor();
    const light = await chipColour(page, 'hsl(330 60% 36%)');
    assert.equal(light.got, light.want, 'light human chip colour');
    await page.goto(url);
    await page.locator('.kh-comp').waitFor();

    // Flat order and toggle; the chips bar sits directly above the form.
    assert.deepEqual(await page.locator('.kh-to-flat [data-kh-mention]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-kh-mention'))),
      ['a1', 'p-maya', 'a2']);
    assert.equal(await page.locator('.kh-to + form.kh-comp').count(), 1);
    assert.equal(await page.locator('.kh-comp').evaluate(node => getComputedStyle(node).borderTopWidth), '0px');
    const toggle = page.locator('.kh-to-tog');
    assert.equal(await toggle.innerText(), '+2');
    await toggle.click();
    assert.equal(await page.locator('.kh-to.is-open .kh-to-h').count(), 3);
    assert.equal(await toggle.innerText(), 'Less');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    await toggle.click();
    assert.equal(await page.locator('.kh-to.is-open').count(), 0);

    // A chip inserts @label and focuses the draft; Enter sends it.
    const input = page.locator('#kh-input');
    const send = page.getByRole('button', { name: 'Send', exact: true });
    assert.equal(await send.isDisabled(), true);
    await page.locator('[data-kh-mention="p-maya"]').click();
    assert.equal(await input.inputValue(), '@Maya ');
    assert.equal(await input.evaluate(node => document.activeElement === node), true);
    assert.equal(await send.isDisabled(), false);
    await input.press('Enter');
    assert.equal(await page.getByTestId('sent').innerText(), '@Maya');
    assert.equal(await input.inputValue(), '');

    // Autosize: 38px empty, grows to 140px, then scrolls.
    assert.equal(await heightOf(page), 38);
    await input.fill('line 1\nline 2');
    const twoLines = await heightOf(page);
    assert.ok(twoLines > 38 && twoLines < 140, `two lines grow the draft (${twoLines}px)`);
    await input.fill(Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join('\n'));
    assert.equal(await heightOf(page), 140);
    assert.deepEqual(await input.evaluate(node => ({ overflowY: getComputedStyle(node).overflowY, scrolls: node.scrollHeight > node.clientHeight })),
      { overflowY: 'auto', scrolls: true });
    await input.fill('');

    // Phone: the chip row scrolls sideways inside the composer, never the page.
    await page.setViewportSize({ width: 390, height: 844 });
    const row = await page.locator('.kh-to-flat').evaluate(node => ({ overflowX: getComputedStyle(node).overflowX,
      scrolls: node.scrollWidth > node.clientWidth }));
    assert.deepEqual(row, { overflowX: 'auto', scrolls: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no page scroll on a phone');
    assert.equal(await heightOf(page), 40, '40px floor at ≤760');
  } finally {
    await browser?.close();
    if (server) await new Promise<void>(resolve => server!.httpServer!.close(() => resolve()));
    await rm(outDir, { recursive: true, force: true });
    await rm(chromiumProfileRoot, { recursive: true, force: true });
  }
});
