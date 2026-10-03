import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { build, preview, type PreviewServer } from 'vite';
import { chromium, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { FAKE_CLAUDE, FAKE_CODEX, FAKE_LINK_ORIGIN, FAKE_R1, createFakeLocalHelper, type FakeLocalHelper } from './fake-local-helper';

declare global { interface Window { __csp: string[]; __copied: string[] } }

const CONFIG = resolve(import.meta.dirname, '../../../vite.local.config.mjs');
// The helper's CSP for HTML responses (KI-131); apps/web may not import packages/agent.
const LOCAL_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'";
const R1_PATH = `/channels/${encodeURIComponent(FAKE_R1)}`;

const settingsCog = (page: Page) => page.locator('.kh-brand-actions').getByRole('button', { name: 'Settings' });
async function settingsItem(page: Page, name: string | RegExp) {
  const menu = page.getByRole('menu', { name: 'Settings' });
  if (!(await menu.isVisible())) await settingsCog(page).click();
  const item = menu.getByRole('menuitem', { name });
  await item.waitFor();
  return item;
}
const agentRow = (page: Page, userId: string) => page.locator(`.kh-rai[data-kh-agent="${userId}"]`).locator('..');
const checkedMode = (page: Page, userId: string) => agentRow(page, userId).locator('[role="radio"][aria-checked="true"]').getAttribute('data-v');
const pathname = (page: Page) => new URL(page.url()).pathname;
const posts = (fake: FakeLocalHelper, path: string) => fake.log.filter(r => r.method === 'POST' && r.path === path);

/** Builds the real local entry, previews it under the helper's CSP and opens Chromium. */
async function withLocalApp(run: (input: { browser: Browser; origin: string }) => Promise<void>): Promise<void> {
  const scratch = await mkdtemp(join(process.env.TMPDIR ?? '/tmp', 'khala-local-app-'));
  // Chromium's Unix socket path must fit under 108 bytes; workspace TMPDIR can be longer.
  const browserProfile = await mkdtemp('/tmp/khala-1012-browser-');
  let server: PreviewServer | null = null;
  let browser: Browser | null = null;
  try {
    const outDir = join(scratch, 'dist');
    await build({ configFile: CONFIG, build: { outDir, emptyOutDir: true }, logLevel: 'error' });
    server = await preview({ configFile: CONFIG, build: { outDir },
      preview: { host: '127.0.0.1', port: 0, headers: { 'Content-Security-Policy': LOCAL_CSP } } });
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true,
      args: ['--no-sandbox'], env: { ...process.env, TMPDIR: browserProfile } });
    await run({ browser, origin: new URL(server.resolvedUrls!.local[0]!).origin });
  } finally {
    await browser?.close();
    if (server) await new Promise<void>(resolve => server!.httpServer.close(() => resolve()));
    await rm(scratch, { recursive: true, force: true });
    await rm(browserProfile, { recursive: true, force: true });
  }
}

/** Routes every `/api/local/**` request of `context` to `fake`, and records every URL the context requests. */
async function wire(context: BrowserContext, fake: FakeLocalHelper): Promise<string[]> {
  const urls: string[] = [];
  context.on('request', request => urls.push(request.url()));
  await context.route('**/api/local/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const response = await fake.handle({ method: request.method(), path: url.pathname, query: url.searchParams,
      headers: request.headers(), body: request.postData() ? request.postDataJSON() : undefined });
    await route.fulfill(response.status === 204 ? { status: 204 } : { status: response.status, json: response.json }).catch(() => undefined);
  });
  await context.addInitScript(() => {
    window.__csp = [];
    window.__copied = [];
    addEventListener('securitypolicyviolation', event => window.__csp.push(`${event.violatedDirective} ${event.blockedURI}`));
    Clipboard.prototype.writeText = async (text: string) => { window.__copied.push(text); };
  });
  return urls;
}

test('the helper CSP inlined here matches KI-131', async () => {
  const source = await readFile(join(import.meta.dirname, '../../../../../packages/agent/src/local/http.ts'), 'utf8');
  assert.ok(source.includes(`export const LOCAL_CSP = "${LOCAL_CSP}"`), 'LOCAL_CSP drifted from packages/agent/src/local/http.ts');
});

test('the real local app runs end to end against a faked helper', { timeout: 180_000 }, async () => {
  await withLocalApp(async ({ browser, origin }) => {
    const fake = createFakeLocalHelper();
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    try {
      const urls = await wire(context, fake);
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));

      // F1 entry: `/` → `/conversations`, newest activity first, same-origin fonts, no Log out.
      await page.goto(`${origin}/`);
      await expect(page.locator('.kh-cv')).toHaveCount(2);
      assert.equal(pathname(page), '/conversations');
      await expect(page.locator('.kh-cv').first()).toContainText('refactor');
      await page.evaluate(() => document.fonts.ready);
      assert.equal(await page.evaluate(() => document.fonts.check('16px "Space Grotesk"')), true);
      assert.ok(urls.some(url => new URL(url).origin === origin && /^\/assets\/.+\.woff2$/u.test(new URL(url).pathname)));
      await settingsItem(page, /^Profile/u);
      assert.equal(await page.getByRole('menuitem', { name: 'Log out' }).count(), 0);
      await page.keyboard.press('Escape');

      // F2 open channel.
      await page.locator('.kh-cv', { hasText: 'refactor' }).click();
      await expect.poll(() => pathname(page)).toBe(R1_PATH);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('refactor');
      await page.locator('.timeline__row', { hasText: '@kevin-Codex can you review PR #12?' }).waitFor();

      // F3 send: one POST with the exact body, and one row after the long-poll echo.
      await page.getByRole('combobox', { name: 'Message' }).fill('hello agents');
      await page.getByRole('button', { name: 'Send' }).click();
      const sendPath = `/api/local/rooms/${encodeURIComponent(FAKE_R1)}/send`;
      await expect.poll(() => posts(fake, sendPath).length).toBe(1);
      await page.locator('.timeline__row:not(.timeline__row--pending)', { hasText: 'hello agents' }).waitFor();
      await page.locator('.timeline__row--pending', { hasText: 'hello agents' }).waitFor({ state: 'detached' });
      const sends = posts(fake, sendPath);
      assert.equal(sends.length, 1);
      const sent = sends[0]!.body as { txnId: unknown };
      assert.equal(typeof sent.txnId, 'string');
      assert.deepEqual(sent, { txnId: sent.txnId, type: 'm.room.message', content: { msgtype: 'm.text', body: 'hello agents' } });
      await page.waitForTimeout(2000);
      await expect(page.locator('.timeline__row', { hasText: 'hello agents' })).toHaveCount(1);

      // F4 an agent message over the held events long-poll, attributed to the agent.
      const said = fake.agentSays(FAKE_R1, FAKE_CLAUDE, 'On it. Reviewing PR #12 now.');
      const row = page.locator(`[data-event-id="${said.eventId}"]`);
      await row.waitFor({ timeout: 5000 });
      await expect(row).toContainText('kevin-Claude');
      await expect(row).toContainText('On it. Reviewing PR #12 now.');

      // F5 the join announcement renders as an event pill.
      fake.announce(FAKE_R1, 'kevin-Codex joined');
      await page.locator('li.channel-event-pill', { hasText: 'kevin-Codex joined' }).waitFor({ timeout: 5000 });

      // F6 roster modes: seeded modes, the command, the waiting status, then the confirmed echo.
      await page.locator('#kh-head-btn').click();
      await agentRow(page, FAKE_CLAUDE).waitFor();
      await agentRow(page, FAKE_CODEX).waitFor();
      assert.equal(await checkedMode(page, FAKE_CLAUDE), 'sync');
      assert.equal(await checkedMode(page, FAKE_CODEX), 'async');
      await agentRow(page, FAKE_CLAUDE).locator('[role="radio"][data-v="steer"]').click();
      const roster = page.locator('#kh-roster');
      const waiting = roster.getByRole('status').filter({ hasText: 'Waiting for kevin-Claude to switch…' });
      await waiting.waitFor();
      await expect.poll(() => fake.modeCommands.length).toBe(1);
      const command = fake.modeCommands[0]!;
      assert.equal(typeof command.txnId, 'string');
      assert.deepEqual(fake.modeCommands, [{ roomId: FAKE_R1, agent: FAKE_CLAUDE, mode: 'steer', txnId: command.txnId }]);
      assert.equal(await checkedMode(page, FAKE_CLAUDE), 'steer');
      fake.echoMode(FAKE_R1, FAKE_CLAUDE, 'steer');
      await waiting.waitFor({ state: 'hidden', timeout: 6000 });
      assert.equal(await checkedMode(page, FAKE_CLAUDE), 'steer');

      // F7 rename from the roster's pencil.
      await page.getByRole('button', { name: 'Rename kevin-Claude' }).click();
      const detail = page.getByRole('complementary', { name: 'kevin-Claude details' });
      await detail.waitFor();
      await detail.getByLabel('Name for kevin-Claude').fill('Reviewer');
      await detail.getByRole('button', { name: 'Rename' }).click();
      await page.getByRole('complementary', { name: 'Reviewer details' }).waitFor({ timeout: 6000 });
      const renames = posts(fake, `/api/local/agents/${encodeURIComponent(FAKE_CLAUDE)}/name`);
      assert.equal(renames.length, 1);
      assert.deepEqual(renames[0]!.body, { name: 'Reviewer' });
      await page.getByRole('complementary', { name: 'Reviewer details' }).getByRole('button', { name: 'Close details' }).click();
      if (await page.locator('#kh-head-btn').getAttribute('aria-expanded') === 'false') await page.locator('#kh-head-btn').click();
      await expect(agentRow(page, FAKE_CLAUDE)).toContainText('Reviewer', { timeout: 6000 });

      // F8 Add agent mints a local join link on Copy (the popover shows no link, as hosted) and copies it.
      const linksPath = `/api/local/channels/${encodeURIComponent(FAKE_R1)}/links`;
      await roster.getByRole('button', { name: 'Add agent' }).click();
      const pop = page.locator('.kh-pop');
      await pop.getByRole('button', { name: 'Copy link' }).click();
      await page.locator('.kh-toast.on', { hasText: 'Copied' }).waitFor();
      assert.equal(posts(fake, linksPath).length, 1);
      const copied = await page.evaluate(() => window.__copied);
      assert.equal(copied.length, 1);
      assert.match(copied[0]!, new RegExp(`^${FAKE_LINK_ORIGIN.replace(/[.]/gu, '\\.')}/join/[A-Za-z0-9_-]{43}$`, 'u'));
      await page.keyboard.press('Escape');

      // F9 a new channel from the list, reconciled by its operation id.
      await page.getByRole('button', { name: 'New channel' }).click();
      await page.getByRole('textbox', { name: 'Channel name' }).fill('design');
      await page.getByRole('button', { name: 'Create' }).click();
      await expect.poll(() => pathname(page)).toMatch(/^\/channels\/!new\d{19}%3Alocal$/u);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('design');
      const creates = posts(fake, '/api/local/channels');
      assert.equal(creates.length, 1);
      const created = creates[0]!.body as { name: unknown; operationId: unknown };
      assert.equal(created.name, 'design');
      assert.equal(typeof created.operationId, 'string');

      // F10 settings: username (and the default-name cascade), colour, theme.
      await (await settingsItem(page, /^Profile/u)).click();
      const dialog = page.getByRole('dialog', { name: 'Profile' });
      await dialog.getByRole('textbox', { name: 'Username' }).fill('kev');
      await dialog.getByRole('button', { name: 'Save' }).click();
      await dialog.waitFor({ state: 'hidden' });
      assert.deepEqual(posts(fake, '/api/local/profile/username').map(r => r.body), [{ username: 'kev' }]);
      await expect(await settingsItem(page, /^Profile/u)).toHaveText('Profile@kev');
      await page.keyboard.press('Escape');

      await (await settingsItem(page, /^Profile/u)).click();
      const swatches = dialog.getByRole('radiogroup', { name: 'Color' }).getByRole('radio');
      const unchecked = swatches.and(page.locator('[aria-checked="false"]')).first();
      const colorLabel = (await unchecked.getAttribute('aria-label'))!;
      await unchecked.click();
      await dialog.getByRole('button', { name: 'Save' }).click();
      await dialog.waitFor({ state: 'hidden' });
      const colors = posts(fake, '/api/local/profile/color').map(r => r.body);
      assert.deepEqual(colors, [{ color: colorLabel.toLowerCase() }]);
      const profileItem = await settingsItem(page, /^Profile/u);
      const dot = await profileItem.locator('.kh-swatch-dot').evaluate(node => getComputedStyle(node).backgroundColor);
      await profileItem.click();
      const chosen = await swatches.and(page.locator('[aria-checked="true"]')).getAttribute('aria-label');
      assert.equal(chosen, colorLabel);
      assert.ok(dot && dot !== 'rgba(0, 0, 0, 0)', 'the Profile item shows the saved colour');
      await page.keyboard.press('Escape');

      await page.goto(`${origin}${R1_PATH}`);
      await page.locator('#kh-head-btn').click();
      await expect(agentRow(page, FAKE_CODEX)).toContainText('kev-Codex', { timeout: 6000 });

      await (await settingsItem(page, 'Light mode')).click();
      await expect(page.locator('.khala-app')).toHaveAttribute('data-theme', 'light');
      await page.reload();
      await expect(page.locator('.khala-app')).toHaveAttribute('data-theme', 'light');

      // F11 phone: no overflow, back returns to the list, the roster fits.
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`${origin}${R1_PATH}`);
      await page.locator('.timeline__row', { hasText: 'hello agents' }).waitFor();
      const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
      assert.equal(await noOverflow(), true);
      await page.locator('#kh-head-btn').click();
      await agentRow(page, FAKE_CODEX).waitFor();
      const box = (await roster.boundingBox())!;
      assert.ok(box.x >= -1 && box.x + box.width <= 391, `the roster fits: ${JSON.stringify(box)}`);
      assert.equal(await noOverflow(), true);
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'All channels' }).click();
      await expect.poll(() => pathname(page)).toBe('/conversations');
      await expect(page.locator('.kh-cv')).toHaveCount(3);
      assert.equal(await noOverflow(), true);

      // Invariants: same origin only, no hosted or homeserver calls, mutation header, fully faked, no CSP or page errors.
      const outside = urls.filter(url => !url.startsWith('data:') && !url.startsWith('blob:') && new URL(url).origin !== origin);
      assert.deepEqual(outside, []);
      assert.deepEqual(urls.filter(url => /\/api\/human|googleapis|gstatic|khala\.aiur\.team|\/_matrix\//u.test(url)), []);
      assert.deepEqual(fake.violations, []);
      assert.deepEqual(fake.unhandled, []);
      assert.deepEqual(await page.evaluate(() => window.__csp), []);
      assert.deepEqual(errors, []);
    } finally {
      fake.close();
      await context.close();
    }
  });
});

test('local app screenshots at 1280 and 390, dark and light', { timeout: 180_000 }, async () => {
  const shots = process.env.KHALA_LOCAL_SCREENSHOT_DIR;
  if (!shots) return;
  await mkdir(shots, { recursive: true });
  const written: string[] = [];
  await withLocalApp(async ({ browser, origin }) => {
    for (const width of [1280, 390]) {
      for (const theme of ['dark', 'light']) {
        const fake = createFakeLocalHelper();
        const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 800 } });
        try {
          await wire(context, fake);
          const page = await context.newPage();
          await page.addInitScript(value => localStorage.setItem('khala.theme', value), theme);
          fake.agentSays(FAKE_R1, FAKE_CLAUDE, 'On it. Reviewing PR #12 now.');
          fake.announce(FAKE_R1, 'kevin-Codex joined');
          const shoot = async (view: string) => {
            const path = join(shots, `local-${view}-${width}-${theme}.png`);
            await page.screenshot({ path });
            written.push(path);
          };
          await page.goto(`${origin}/conversations`);
          await expect(page.locator('.kh-cv')).toHaveCount(2);
          await page.waitForTimeout(600);
          await shoot('list');
          await settingsCog(page).click();
          await page.getByRole('menu', { name: 'Settings' }).waitFor();
          await page.waitForTimeout(300);
          if (width === 390) await shoot('settings');
          await page.keyboard.press('Escape');
          await page.goto(`${origin}${R1_PATH}`);
          await page.locator('li.channel-event-pill', { hasText: 'kevin-Codex joined' }).waitFor();
          await page.waitForTimeout(600);
          await shoot('channel');
          await page.locator('#kh-head-btn').click();
          await agentRow(page, FAKE_CODEX).waitFor();
          await page.waitForTimeout(400);
          await shoot('roster');
          if (width === 1280) {
            await page.keyboard.press('Escape');
            await settingsCog(page).click();
            await page.getByRole('menu', { name: 'Settings' }).waitFor();
            await page.waitForTimeout(300);
            await shoot('settings');
          }
        } finally {
          fake.close();
          await context.close();
        }
      }
    }
  });
  assert.equal(written.length, 16);
  for (const path of written) assert.ok((await stat(path)).size > 0, path);
});
