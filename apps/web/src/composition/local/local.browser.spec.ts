import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { build, preview, type PreviewServer } from 'vite';
import { chromium, expect, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { LOCAL_CSP } from '../../../../../packages/agent/src/local/http';
import {
  FAKE_CLAUDE, FAKE_CODEX, FAKE_LINK_ORIGIN, FAKE_R1, FAKE_R2, FAKE_RELEASE_AGENT, createFakeLocalHelper, type FakeLocalHelper,
} from './fake-local-helper';

declare global { interface Window { __csp: string[]; __copied: string[] } }

const CONFIG = resolve(import.meta.dirname, '../../../vite.local.config.mjs');
const enc = encodeURIComponent;
const R1_PATH = `/channels/${enc(FAKE_R1)}`;
const R2_PATH = `/channels/${enc(FAKE_R2)}`;
const LINK = new RegExp(`^${FAKE_LINK_ORIGIN.replace(/[.]/gu, '\\.')}/join/[A-Za-z0-9_-]{43}$`, 'u');

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
const ownerBadge = (scope: ReturnType<Page['locator']>) => scope.locator('.kh-own').first();
const background = (scope: ReturnType<Page['locator']>) => scope.evaluate(node => getComputedStyle(node).backgroundColor);
const posts = (fake: FakeLocalHelper, path: string) => fake.log.filter(r => r.method === 'POST' && r.path === path);

/** Reads the fake's state through its own GET routes, as the browser would. */
async function read(fake: FakeLocalHelper, path: string): Promise<Record<string, unknown>> {
  const response = await fake.handle({ method: 'GET', path, query: new URLSearchParams(), headers: {}, body: undefined });
  assert.equal(response.status, 200, path);
  return response.json as Record<string, unknown>;
}

/** Builds the real local entry, previews it under the helper's own CSP (KI-131) and opens Chromium. */
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
    if (server) await new Promise<void>(done => server!.httpServer.close(() => done()));
    await rm(scratch, { recursive: true, force: true });
    await rm(browserProfile, { recursive: true, force: true });
  }
}

type Wired = { urls: string[]; offOrigin: string[]; leaked: Promise<never> };

/**
 * Routes `/api/local/**` to `fake`, serves the rest of the origin from the preview,
 * and aborts anything off-origin. The first off-origin request rejects `leaked`,
 * so `guarded` fails the flow at that request rather than in a final filter.
 */
async function wire(context: BrowserContext, fake: FakeLocalHelper, origin: string): Promise<Wired> {
  let leak: (error: Error) => void = () => undefined;
  const leaked = new Promise<never>((_, fail) => { leak = fail; });
  leaked.catch(() => undefined);
  const wired: Wired = { urls: [], offOrigin: [], leaked };
  context.on('request', request => wired.urls.push(request.url()));
  await context.route('**', async route => {
    const request = route.request();
    const href = request.url();
    if (href.startsWith('data:') || href.startsWith('blob:')) return route.continue();
    const url = new URL(href);
    if (url.origin !== origin) {
      wired.offOrigin.push(href);
      leak(new Error(`request left the origin: ${request.method()} ${href}`));
      return route.abort('blockedbyclient');
    }
    if (!url.pathname.startsWith('/api/local/')) return route.continue();
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
  return wired;
}
const guarded = (wired: Wired, flow: () => Promise<void>) => Promise.race([flow(), wired.leaked]);

test('the real local app runs end to end against a faked helper', { timeout: 180_000 }, async () => {
  await withLocalApp(async ({ browser, origin }) => {
    const fake = createFakeLocalHelper();
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    try {
      const wired = await wire(context, fake, origin);
      const page = await context.newPage();
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await guarded(wired, async () => {
        // F1 entry: `/` → `/conversations`, newest activity first, same-origin fonts, no Log out.
        await page.goto(`${origin}/`);
        await expect(page.locator('.kh-cv')).toHaveCount(2);
        assert.equal(pathname(page), '/conversations');
        await expect(page.locator('.kh-cv').first()).toContainText('refactor');
        await page.evaluate(() => document.fonts.ready);
        assert.equal(await page.evaluate(() => document.fonts.check('16px "Space Grotesk"')), true);
        assert.ok(wired.urls.some(url => new URL(url).origin === origin && /^\/assets\/.+\.woff2$/u.test(new URL(url).pathname)));
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
        const sendPath = `/api/local/rooms/${enc(FAKE_R1)}/send`;
        await expect.poll(() => posts(fake, sendPath).length).toBe(1);
        await page.locator('.timeline__row:not(.timeline__row--pending)', { hasText: 'hello agents' }).waitFor();
        await page.locator('.timeline__row--pending', { hasText: 'hello agents' }).waitFor({ state: 'detached' });
        const sent = posts(fake, sendPath)[0]!.body as { txnId: unknown };
        assert.equal(typeof sent.txnId, 'string');
        assert.deepEqual(sent, { txnId: sent.txnId, type: 'm.room.message', content: { msgtype: 'm.text', body: 'hello agents' } });
        await page.waitForTimeout(2000);
        await expect(page.locator('.timeline__row', { hasText: 'hello agents' })).toHaveCount(1);

        // F4 an agent message over the held events long-poll: sender name, and the owner's
        // badge in the owner's colour. With no initials chosen the badge reads `YO` (#1056 ruling).
        const said = fake.agentSays(FAKE_R1, FAKE_CLAUDE, 'On it. Reviewing PR #12 now.');
        const row = page.locator(`[data-event-id="${said.eventId}"]`);
        await row.waitFor({ timeout: 5000 });
        await expect(row).toContainText('kevin-Claude');
        await expect(row).toContainText('On it. Reviewing PR #12 now.');
        await expect(ownerBadge(row)).toHaveText('YO');
        const ownerColor = await background(ownerBadge(row));
        assert.notEqual(ownerColor, 'rgba(0, 0, 0, 0)', 'the owner badge is drawn in the owner colour');

        // F5 the join announcement renders as an event pill.
        fake.announce(FAKE_R1, 'kevin-Codex joined');
        await page.locator('li.channel-event-pill', { hasText: 'kevin-Codex joined' }).waitFor({ timeout: 5000 });

        // F6 unread: an agent message in another channel shows the dot and the header count; opening it clears both.
        const listHead = page.locator('.kh-list-head span');
        await expect(listHead).toHaveText('0 unread');
        fake.agentSays(FAKE_R2, FAKE_RELEASE_AGENT, 'Release notes are drafted.');
        const releaseRow = page.locator(`.kh-cv[data-kh-convo="${FAKE_R2}"]`);
        await expect(releaseRow).toHaveClass(/\bunread\b/u, { timeout: 6000 });
        await expect(releaseRow).toHaveAttribute('aria-label', /, 1 unread$/u);
        await expect(listHead).toHaveText('1 unread');
        await releaseRow.click();
        await expect.poll(() => pathname(page)).toBe(R2_PATH);
        await page.locator('.timeline__row', { hasText: 'Release notes are drafted.' }).waitFor();
        await expect(releaseRow).not.toHaveClass(/\bunread\b/u);
        await expect(listHead).toHaveText('0 unread');
        await page.locator(`.kh-cv[data-kh-convo="${FAKE_R1}"]`).click();
        await expect.poll(() => pathname(page)).toBe(R1_PATH);

        // F7 roster modes: seeded modes, the command, the waiting status, then the confirmed echo.
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
        assert.deepEqual(fake.modeCommands, [{ roomId: FAKE_R1, agent: FAKE_CLAUDE, mode: 'steer', txnId: command.txnId }]);
        assert.equal(await checkedMode(page, FAKE_CLAUDE), 'steer');
        fake.echoMode(FAKE_R1, FAKE_CLAUDE, 'steer');
        await waiting.waitFor({ state: 'hidden', timeout: 6000 });
        assert.equal(await checkedMode(page, FAKE_CLAUDE), 'steer');

        // F8 rename from the roster's pencil.
        await page.getByRole('button', { name: 'Rename kevin-Claude' }).click();
        const detail = page.getByRole('complementary', { name: 'kevin-Claude details' });
        await detail.waitFor();
        await detail.getByLabel('Name for kevin-Claude').fill('Reviewer');
        await detail.getByRole('button', { name: 'Rename' }).click();
        await page.getByRole('complementary', { name: 'Reviewer details' }).waitFor({ timeout: 6000 });
        assert.deepEqual(posts(fake, `/api/local/agents/${enc(FAKE_CLAUDE)}/name`).map(r => r.body), [{ name: 'Reviewer' }]);
        await page.getByRole('complementary', { name: 'Reviewer details' }).getByRole('button', { name: 'Close details' }).click();
        if (await page.locator('#kh-head-btn').getAttribute('aria-expanded') === 'false') await page.locator('#kh-head-btn').click();
        await expect(agentRow(page, FAKE_CLAUDE)).toContainText('Reviewer', { timeout: 6000 });
        // #1084 the rename pill shows live, without a reload.
        await expect(page.locator('li.channel-event-pill', { hasText: 'kevin-Claude is now Reviewer' })).toHaveCount(1, { timeout: 6000 });

        // F9 Add agent mints a local join link on Copy (as hosted, the popover shows none) and copies it.
        const linksPath = `/api/local/channels/${enc(FAKE_R1)}/links`;
        await roster.getByRole('button', { name: 'Add agent' }).click();
        await page.locator('.kh-pop').getByRole('button', { name: 'Copy link' }).click();
        await page.locator('.kh-toast.on', { hasText: 'Copied' }).waitFor();
        assert.equal(posts(fake, linksPath).length, 1);
        const copied = await page.evaluate(() => window.__copied);
        assert.equal(copied.length, 1);
        assert.match(copied[0]!, LINK);
        await page.keyboard.press('Escape');
        await page.keyboard.press('Escape');

        // F10 Invite: the helper's share link, and the locked Type/Approve/History controls stay inert and send nothing.
        await page.getByRole('button', { name: 'Invite' }).click();
        const invite = page.locator('.kh-pop', { hasText: 'Invite' });
        await expect(invite.locator('.kh-link code')).toHaveText(LINK, { timeout: 6000 });
        const before = fake.log.length;
        for (const group of ['Type', 'History']) {
          const radios = invite.getByRole('radiogroup', { name: group }).getByRole('radio');
          const states = await radios.evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-checked')));
          assert.ok(states.length > 0, `${group} renders`);
          for (const radio of await radios.all()) {
            await expect(radio).toBeDisabled();
            await expect(radio).toHaveAttribute('title', 'Coming soon');
            await radio.click({ force: true });
          }
          assert.deepEqual(await radios.evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-checked'))), states, `${group} is inert`);
        }
        const approve = invite.getByRole('switch', { name: 'Approve joins' });
        await expect(approve).toBeDisabled();
        await approve.click({ force: true });
        await expect(approve).toHaveAttribute('aria-checked', 'false');
        await page.waitForTimeout(500);
        assert.deepEqual(fake.log.slice(before).filter(r => r.method !== 'GET').map(r => r.path), [], 'locked controls send nothing');
        await page.keyboard.press('Escape');

        // F11 a new channel from the list, reconciled by its operation id.
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

        // F12 Profile: username, initials and colour, each POSTed, held by the helper and kept across a reload.
        await page.goto(`${origin}${R1_PATH}`);
        await row.waitFor();
        await (await settingsItem(page, /^Profile/u)).click();
        const dialog = page.getByRole('dialog', { name: 'Profile' });
        await dialog.getByRole('textbox', { name: 'Username' }).fill('kev');
        await dialog.getByRole('textbox', { name: 'Initials' }).fill('kw');
        const swatches = dialog.getByRole('radiogroup', { name: 'Color' }).getByRole('radio');
        const unchecked = swatches.and(page.locator('[aria-checked="false"]')).first();
        const colorLabel = (await unchecked.getAttribute('aria-label'))!;
        await unchecked.click();
        await dialog.getByRole('button', { name: 'Save' }).click();
        await dialog.waitFor({ state: 'hidden' });
        assert.deepEqual(posts(fake, '/api/local/profile/username').map(r => r.body), [{ username: 'kev' }]);
        assert.deepEqual(posts(fake, '/api/local/profile/initials').map(r => r.body), [{ initials: 'KW' }]);
        assert.deepEqual(posts(fake, '/api/local/profile/color').map(r => r.body), [{ color: colorLabel.toLowerCase() }]);
        const profile = await read(fake, '/api/local/profile');
        assert.deepEqual({ username: profile.username, initials: profile.initials, color: profile.color },
          { username: 'kev', initials: 'KW', color: colorLabel.toLowerCase() });

        await page.reload();
        await row.waitFor();
        await expect(await settingsItem(page, /^Profile/u)).toHaveText('Profile@kev');
        await (await settingsItem(page, /^Profile/u)).click();
        await expect(dialog.getByRole('textbox', { name: 'Username' })).toHaveValue('kev');
        await expect(dialog.getByRole('textbox', { name: 'Initials' })).toHaveValue('KW');
        assert.equal(await swatches.and(page.locator('[aria-checked="true"]')).getAttribute('aria-label'), colorLabel);
        await dialog.getByRole('button', { name: 'Cancel' }).click();
        await dialog.waitFor({ state: 'hidden' });
        await expect(ownerBadge(row)).toHaveText('KW');
        assert.notEqual(await background(ownerBadge(row)), ownerColor, 'the owner badge follows the new colour');
        await expect(ownerBadge(page.locator(`.kh-cv[data-kh-convo="${FAKE_R1}"]`))).toHaveText('KW');
        // The username cascade renamed the agents still on a default name.
        await page.locator('#kh-head-btn').click();
        await expect(agentRow(page, FAKE_CODEX)).toContainText('kev-Codex', { timeout: 6000 });
        await page.keyboard.press('Escape');
        // #1084 the cascade is one pill per renamed agent, and a reload does not repeat it.
        await expect(page.locator('li.channel-event-pill', { hasText: 'kevin-Codex is now kev-Codex' })).toHaveCount(1);
        await expect(page.locator('li.channel-event-pill', { hasText: 'kevin-Claude is now Reviewer' })).toHaveCount(1);
        await page.reload();
        await expect(page.locator('li.channel-event-pill', { hasText: 'kevin-Codex is now kev-Codex' })).toHaveCount(1, { timeout: 6000 });
        await expect(page.locator('li.channel-event-pill', { hasText: 'kevin-Claude is now Reviewer' })).toHaveCount(1);

        await (await settingsItem(page, 'Light mode')).click();
        await expect(page.locator('.khala-app')).toHaveAttribute('data-theme', 'light');
        await page.reload();
        await expect(page.locator('.khala-app')).toHaveAttribute('data-theme', 'light');

        // F13 phone: no overflow, back returns to the list, the roster fits.
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
      });

      // Invariants: same origin only, no hosted or homeserver calls, mutation header, fully faked, no CSP or page errors.
      assert.deepEqual(wired.offOrigin, []);
      assert.deepEqual(wired.urls.filter(url => /\/api\/human|googleapis|gstatic|khala\.aiur\.team|\/_matrix\//u.test(url)), []);
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

test('an unconfirmed mode request reverts after 15 s', { timeout: 180_000 }, async () => {
  await withLocalApp(async ({ browser, origin }) => {
    const fake = createFakeLocalHelper();
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    try {
      const wired = await wire(context, fake, origin);
      const page = await context.newPage();
      await page.clock.install();
      // Freeze before setup: network and assertion latency must not consume the
      // confirmation window before we advance it ourselves.
      await page.clock.pauseAt(Date.now() + 60_000);
      await guarded(wired, async () => {
        await page.goto(`${origin}${R1_PATH}`);
        await page.locator('#kh-head-btn').click();
        await agentRow(page, FAKE_CODEX).waitFor();
        assert.equal(await checkedMode(page, FAKE_CODEX), 'async');
        await agentRow(page, FAKE_CODEX).locator('[role="radio"][data-v="steer"]').click();
        const status = page.locator('#kh-roster').getByRole('status');
        await expect(status.filter({ hasText: 'Waiting for kevin-Codex to switch…' })).toBeVisible();
        await expect.poll(() => fake.modeCommands.length).toBe(1);
        assert.equal(await checkedMode(page, FAKE_CODEX), 'steer');
        // No echo: the agent stays on `async`, and the UI reverts at MODE_CONFIRM_MS.
        await page.clock.runFor(14_999);
        assert.equal(await checkedMode(page, FAKE_CODEX), 'steer');
        await page.clock.runFor(1);
        await expect(status.filter({ hasText: 'kevin-Codex didn\'t confirm. It may be offline.' })).toBeVisible();
        assert.equal(await checkedMode(page, FAKE_CODEX), 'async');
        const members = await read(fake, `/api/local/rooms/${enc(FAKE_R1)}/members`) as { members: { userId: string; listeningMode?: string }[] };
        assert.equal(members.members.find(m => m.userId === FAKE_CODEX)?.listeningMode, 'async');
      });
      assert.deepEqual(fake.unhandled, []);
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
          await wire(context, fake, origin);
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
          await page.getByRole('button', { name: 'Invite' }).click();
          await page.locator('.kh-pop', { hasText: 'Invite' }).waitFor();
          await page.waitForTimeout(300);
          await shoot('invite');
          await page.keyboard.press('Escape');
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
  assert.equal(written.length, 20);
  for (const path of written) assert.ok((await stat(path)).size > 0, path);
});

test('local mention notification observes unopened channels without clearing unread; click reveals the message', { timeout: 90_000 }, async () => {
  await withLocalApp(async ({ browser, origin }) => {
    const fake = createFakeLocalHelper();
    const context = await browser.newContext();
    const wired = await wire(context, fake, origin);
    await context.addInitScript(`window.__notifications = [];
      window.__background = false;
      Object.defineProperty(document, 'hidden', { get: () => window.__background });
      document.hasFocus = () => !window.__background;
      class StubNotification {
        static permission = 'granted';
        constructor(title, options) { this.title = title; this.options = options; window.__notifications.push(this); }
        close() { this.onclose?.(); }
      }
      window.Notification = StubNotification;
      localStorage.setItem('khala.mention-notifications.v1', 'on');`);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      await guarded(wired, async () => {
        await page.goto(origin);
        await expect(page.locator('.kh-cv')).toHaveCount(2);
        await expect.poll(() => fake.log.filter(request => request.path.includes('/events')).length).toBeGreaterThanOrEqual(2);
        await page.evaluate('window.__background = true');
        const event = fake.agentSays(FAKE_R2, FAKE_RELEASE_AGENT, '@kevin release is ready');
        await expect.poll(() => page.evaluate('window.__notifications.length')).toBe(1);
        assert.deepEqual(await page.evaluate('({title: window.__notifications[0].title, body: window.__notifications[0].options.body})'),
          { title: 'release', body: 'kevin-Claude: @kevin release is ready' });
        const release = page.locator('.kh-cv', { hasText: 'release' });
        await expect(release).toHaveAttribute('aria-label', /1 unread/u);
        await page.evaluate('window.__background = false; window.__notifications[0].onclick()');
        await expect.poll(() => pathname(page)).toBe(R2_PATH);
        const message = page.locator(`[data-event-id="${event.eventId}"]`);
        await expect(message).toBeVisible();
        await expect(message).toBeFocused();
        // Own and focused messages remain silent.
        fake.agentSays(FAKE_R2, FAKE_RELEASE_AGENT, '@kevin another update');
        await page.getByText('@kevin another update', { exact: true }).waitFor();
        assert.equal(await page.evaluate('window.__notifications.length'), 1);
        assert.deepEqual(errors, []);
      });
    } finally { fake.close(); await context.close(); }
  });
});
