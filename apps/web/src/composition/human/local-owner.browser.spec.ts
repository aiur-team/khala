import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { build, preview, type PreviewServer } from 'vite';
import { chromium, type Browser, type Page } from '@playwright/test';

declare global { interface Window {
  __localOwner: { signInCount(): number; signOutCount(): number; copied: string[] };
} }

type Theme = 'dark' | 'light';
const viewports = [{ width: 1280, height: 800 }, { width: 390, height: 844 }] as const;
const themes: readonly Theme[] = ['dark', 'light'];
const shots = process.env.KHALA_LOCAL_OWNER_SHOTS;

/** The brand row's settings cog. */
const settingsCog = (page: Page) => page.locator('.kh-brand-actions').getByRole('button', { name: 'Settings' });

let scratch = '';
let browserProfile = '';
let server: PreviewServer | null = null;
let browser: Browser | null = null;

before(async () => {
  scratch = await mkdtemp(join(process.env.TMPDIR ?? '/tmp', 'khala-local-owner-'));
  browserProfile = await mkdtemp(join('/tmp', 'khala-lo-'));
  await build({ root: join(import.meta.dirname, 'browser-harness'),
    build: { outDir: join(scratch, 'dist'), emptyOutDir: true,
      rollupOptions: { input: join(import.meta.dirname, 'browser-harness/local-owner.html') } }, logLevel: 'error' });
  server = await preview({ root: join(import.meta.dirname, 'browser-harness'),
    build: { outDir: join(scratch, 'dist') }, preview: { host: '127.0.0.1', port: 0 } });
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    headless: true, args: ['--no-sandbox'], env: { ...process.env, TMPDIR: browserProfile } });
});

after(async () => {
  await browser?.close();
  if (server) await new Promise<void>(resolve => server!.httpServer!.close(() => resolve()));
  await rm(scratch, { recursive: true, force: true });
  await rm(browserProfile, { recursive: true, force: true });
});

/** Opens the harness at `search` in `theme`, with a clipboard that records what was copied. */
async function withPage(viewport: { width: number; height: number }, theme: Theme, search: string,
  run: (page: Page) => Promise<void>) {
  const context = await browser!.newContext({ viewport });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  // A string, not a function: tsx's emitted `__name` helper does not exist in the page.
  await page.addInitScript(`localStorage.setItem('khala.theme', ${JSON.stringify(theme)});
    window.__localOwner = { copied: [] };
    Object.defineProperty(navigator, 'clipboard', { configurable: true,
      value: { writeText: async text => { window.__localOwner.copied.push(text); } } });`);
  try {
    await page.goto(server!.resolvedUrls!.local[0]! + 'local-owner.html' + search);
    // The theme transition settles before any assertion or screenshot.
    await page.waitForTimeout(600);
    await run(page);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}

const shot = (page: Page, name: string) => shots ? page.screenshot({ path: join(shots, `${name}.png`) }) : Promise.resolve();

for (const viewport of viewports) {
  for (const theme of themes) {
    const label = `${viewport.width}px ${theme}`;
    const modeItem = theme === 'dark' ? 'Light mode' : 'Dark mode';

    test(`local owner settings menu has no Log out at ${label}`, { timeout: 60_000 }, async () => {
      await withPage(viewport, theme, '', async page => {
        await settingsCog(page).click();
        const menu = page.getByRole('menu', { name: 'Settings' });
        await menu.getByRole('menuitem', { name: /Profile/u }).waitFor();
        assert.deepEqual(await menu.getByRole('menuitem').allTextContents(), [modeItem, 'Profile@kevin']);
        assert.equal(await page.getByText('Log out').count(), 0);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        await page.waitForTimeout(400); // the menu's open animation
        await shot(page, `local-owner-menu-${viewport.width}-${theme}`);
        assert.equal(await page.evaluate(() => window.__localOwner.signInCount() + window.__localOwner.signOutCount()), 0);
      });
      await withPage(viewport, theme, '?oauth', async page => {
        await settingsCog(page).click();
        const menu = page.getByRole('menu', { name: 'Settings' });
        await menu.getByRole('menuitem', { name: 'Log out' }).waitFor();
        assert.deepEqual(await menu.getByRole('menuitem').allTextContents(), [modeItem, 'Profile@kevin', 'Log out']);
        await page.waitForTimeout(400);
        await shot(page, `oauth-menu-${viewport.width}-${theme}`);
      });
    });

    test(`helper down shows the Not connected panel at ${label}`, { timeout: 60_000 }, async () => {
      await withPage(viewport, theme, '?down', async page => {
        const alert = page.getByRole('alert');
        await alert.getByText('Not connected').waitFor();
        assert.equal(await page.locator('.kh-oneliner code').textContent(), 'khala local open');
        assert.equal(await settingsCog(page).count(), 0);
        assert.equal(await page.getByRole('button', { name: 'Toggle color theme' }).count(), 1);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        await shot(page, `local-owner-down-${viewport.width}-${theme}`);
        await page.getByRole('button', { name: 'Copy command' }).click();
        await page.locator('.kh-toast.on').getByText('Copied').waitFor();
        assert.deepEqual(await page.evaluate(() => window.__localOwner.copied), ['khala local open']);
        assert.equal(await page.evaluate(() => window.__localOwner.signInCount()), 0);
      });
    });
  }

  test(`signed out shows the same panel and never navigates at ${viewport.width}px`, { timeout: 60_000 }, async () => {
    await withPage(viewport, 'dark', '?signed-out', async page => {
      await page.getByRole('alert').getByText('Not connected').waitFor();
      const before = new URL(page.url()).pathname;
      await page.waitForTimeout(500);
      assert.equal(new URL(page.url()).pathname, before);
      assert.equal(await page.locator('.kh-oneliner code').textContent(), 'khala local open');
      assert.equal(await page.evaluate(() => window.__localOwner.signInCount()), 0);
    });
  });

  test(`a channel the owner can no longer open silently returns to the list at ${viewport.width}px`, { timeout: 60_000 }, async () => {
    await withPage(viewport, 'dark', '?gone', async page => {
      await page.getByText('Select a channel to read its messages.').waitFor({state:'attached'});
      assert.equal(await page.getByText('You no longer have access to this channel.').count(), 0);
      assert.equal(await page.getByText(/encrypted/iu).count(), 0);
    });
  });
}


test('owner removes another human while their open channel silently disappears', {timeout:60_000}, async () => {
  const context = await browser!.newContext({viewport:{width:1280,height:900}});
  const owner = await context.newPage();
  const member = await context.newPage();
  try {
    const url = server!.resolvedUrls!.local[0]! + 'local-owner.html';
    await owner.goto(url + '?owner-removal&oauth');
    await member.goto(url + '?removed-human&oauth');
    await member.getByRole('heading', {level:1,name:'refactor'}).waitFor();
    await owner.locator('#kh-head-btn').click();
    await owner.getByRole('button', {name:'Remove Theo',exact:true}).click();
    await member.evaluate(`window.__removalWarnings = [];
      new MutationObserver(records => {
        for (const record of records) for (const node of record.addedNodes) {
          if (/no longer have access/i.test(node.textContent ?? '')) window.__removalWarnings.push(node.textContent);
        }
      }).observe(document.body, {subtree:true,childList:true});`);
    await owner.getByRole('button', {name:'Remove',exact:true}).click();
    await member.getByText('Select a channel to read its messages.').waitFor({state:'attached'});
    assert.equal(await member.getByRole('heading', {level:1,name:'refactor'}).count(), 0);
    assert.deepEqual(await member.evaluate('window.__removalWarnings'), []);
    assert.equal(await member.locator('.kh-toast.on').count(), 0);
    assert.equal(await member.getByRole('dialog').count(), 0);
    assert.equal(await member.getByText(/no longer have access|removed|unavailable/i).count(), 0);
    assert.equal(await member.locator('.kh-list').getByText('refactor', {exact:true}).count(), 0);
  } finally { await context.close(); }
});

test('opening just after joining stays in the room while its first sync arrives late', { timeout: 60_000 }, async () => {
  const page = await browser!.newPage();
  try {
    await page.goto(server!.resolvedUrls!.local[0]! + 'local-owner.html?late-channel&oauth');
    await page.getByRole('heading', { level: 1, name: 'refactor' }).waitFor();
    assert.equal(await page.getByText('Select a channel to read its messages.').count(), 0);
  } finally { await page.close(); }
});

test('a definite control 403 returns to the channel list before Matrix reports a leave', { timeout: 60_000 }, async () => {
  const page = await browser!.newPage();
  try {
    await page.goto(server!.resolvedUrls!.local[0]! + 'local-owner.html?forbidden&oauth');
    await page.getByText('Select a channel to read its messages.').waitFor();
    assert.equal(await page.getByRole('heading', { level: 1, name: 'refactor' }).count(), 0);
  } finally { await page.close(); }
});
