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

/** Builds and serves the composer harness, then runs `body` against a fresh Chromium. */
async function withHarness(body: (browser: Browser, url: string) => Promise<void>) {
  const outDir = await mkdtemp(join(tmpdir(), 'khala-composer-dist-'));
  // Chromium's profile socket path is length-capped; keep it under the system tmp root.
  const chromiumProfileRoot = await mkdtemp(join('/tmp', 'khala-composer-profile-'));
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
    await body(browser, server.resolvedUrls!.local[0]!);
  } finally {
    await browser?.close();
    if (server) await new Promise<void>(resolve => server!.httpServer!.close(() => resolve()));
    await rm(outDir, { recursive: true, force: true });
    await rm(chromiumProfileRoot, { recursive: true, force: true });
  }
}

// The mention chips and composer (RECREATION-SPEC §9, §10) inside the Khala
// frame, with synthetic targets.
test('composer chips keep the D1 colours, autosize to 140px and scroll on a phone', { timeout: 90_000 }, () => withHarness(async (browser, url) => {
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
}));

/** Each suggestion's name and kind, top to bottom. */
const suggestions = (page: Page) => page.locator('.kh-mpop [role=option]').evaluateAll(nodes =>
  nodes.map(node => [node.querySelector('b')?.textContent, node.querySelector('em')?.textContent]));
const activeOption = (page: Page) => page.locator('#kh-input').getAttribute('aria-activedescendant');

// Slack-style @mention autocomplete: filter as you type, pick with keys,
// mouse or touch, and never send while the suggestions are open.
test('composer @mention autocomplete filters, picks and never sends while open', { timeout: 90_000 }, () => withHarness(async (browser, url) => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  await page.goto(url);
  await page.locator('.kh-comp').waitFor();
  const input = page.locator('#kh-input');
  const popup = page.locator('.kh-mpop');
  const sent = page.getByTestId('sent');

  // @c lists the label-prefix hits in chip order, never the viewer.
  await input.pressSequentially('hi @c');
  assert.deepEqual(await suggestions(page), [
    ['Claude #frontend', 'Your agent'], ['Codex #backend', 'Agent of Maya'], ['Claude #infra', 'Agent of Kai'],
  ]);
  assert.equal(await input.getAttribute('aria-expanded'), 'true');
  assert.equal(await input.getAttribute('aria-controls'), 'kh-mention-list');
  assert.equal(await activeOption(page), 'kh-mention-opt-a1');

  // Arrows move; Enter inserts instead of sending.
  await input.press('ArrowDown');
  assert.equal(await activeOption(page), 'kh-mention-opt-a2');
  assert.equal(await page.locator('#kh-mention-opt-a2').getAttribute('aria-selected'), 'true');
  await input.press('Enter');
  assert.equal(await input.inputValue(), 'hi @Codex ');
  assert.equal(await input.evaluate(node => (node as HTMLTextAreaElement).selectionStart), 10);
  assert.equal(await sent.innerText(), '');
  assert.equal(await popup.count(), 0);
  assert.equal(await input.getAttribute('aria-expanded'), 'false');

  // Tab inserts too.
  await input.pressSequentially('@ma');
  await input.press('Tab');
  assert.equal(await input.inputValue(), 'hi @Codex @Maya ');

  // Esc dismisses this @ until a new one is typed.
  await input.pressSequentially('@k');
  assert.equal(await popup.count(), 1);
  await input.press('Escape');
  assert.equal(await popup.count(), 0);
  assert.equal(await input.inputValue(), 'hi @Codex @Maya @k');
  await input.pressSequentially('a');
  assert.equal(await popup.count(), 0);
  await input.pressSequentially(' @');
  assert.equal(await popup.count(), 1);

  // A click inserts and keeps the draft focused.
  await page.locator('[data-kh-mention-option="p-kai"]').click();
  assert.equal(await input.inputValue(), 'hi @Codex @Maya @ka @Kai ');
  assert.equal(await input.evaluate(node => document.activeElement === node), true);

  // With the suggestions closed, Enter sends.
  await input.press('Enter');
  const body = await sent.innerText();
  assert.ok(body.includes('@Codex') && body.includes('@Maya'), body);
  assert.equal(await input.inputValue(), '');

  // An @ inside a word (an email) never opens the suggestions.
  await input.pressSequentially('foo@c');
  assert.equal(await popup.count(), 0);
  await input.fill('');

  // Light theme: the highlighted row is visibly filled.
  await page.goto(`${url}?theme=light`);
  await page.locator('.kh-comp').waitFor();
  await input.pressSequentially('@c');
  const fill = await page.locator('.kh-mpop-opt[aria-selected="true"]').evaluate(node => getComputedStyle(node).backgroundColor);
  assert.notEqual(fill, 'rgba(0, 0, 0, 0)', 'light selected option background');
  await page.close();

  // Phone with touch: a tap inserts, the list fits the viewport, and rows are 44px on a coarse pointer.
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: 'reduce' });
  const mobile = await phone.newPage();
  await mobile.goto(url);
  await mobile.locator('.kh-comp').waitFor();
  const phoneInput = mobile.locator('#kh-input');
  await phoneInput.pressSequentially('@c');
  const box = (await mobile.locator('.kh-mpop').boundingBox())!;
  assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 390, `popup inside the viewport (${JSON.stringify(box)})`);
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no page scroll on a phone');
  assert.equal(await mobile.evaluate(() => matchMedia('(pointer: coarse)').matches), true, 'coarse pointer emulated');
  const heights = await mobile.locator('.kh-mpop-opt').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height));
  assert.ok(heights.every(height => height >= 44), `44px rows (${heights.join(', ')})`);
  await mobile.locator('[data-kh-mention-option="a2"]').tap();
  assert.equal(await phoneInput.inputValue(), '@Codex ');
  assert.equal(await phoneInput.evaluate(node => document.activeElement === node), true, 'the keyboard stays up');
  await phone.close();
}));
