import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { build, preview, type PreviewServer } from 'vite';
import { chromium, expect, type Browser, type Locator, type Page } from '@playwright/test';

/** Serves the fixture with `/api/human/profile` answering `username`; `KHALA_SHOTS` keeps screenshots. */
async function withFixture(viewport: { width: number; height: number }, username: string | null,
  run: (page: Page, saved: string[]) => Promise<void>) {
  const scratch = await mkdtemp(join(process.env.TMPDIR ?? '/tmp', 'khala-username-setup-'));
  // Chromium's Unix socket needs a short path even in long issue workspaces.
  const profile = await mkdtemp('/tmp/khala-952-browser-');
  let server: PreviewServer | undefined;
  let browser: Browser | undefined;
  try {
    const root = join(import.meta.dirname, 'browser-harness');
    const outDir = join(scratch, 'dist');
    await build({ root, build: { outDir, emptyOutDir: true }, logLevel: 'error' });
    server = await preview({ root, build: { outDir }, preview: { host: '127.0.0.1', port: 0 } });
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
      headless: true, args: ['--no-sandbox'], env: { ...process.env, TMPDIR: profile, XDG_CONFIG_HOME: join(scratch, 'config') } });
    const page = await browser.newPage({ viewport });
    const errors: string[] = [];
    const saved: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/human/me', route => route.fulfill({ json: {
      principal: { v: 1, ownerId: 'owner_alice', providerIssuer: 'https://issuer.example', providerSubject: 'alice',
        verifiedEmail: 'alice@example.test', sessionExpiresAt: '2030-01-01T00:00:00Z' }, csrfToken: 'browser-proof',
    } }));
    await page.route('**/api/human/profile', route => route.fulfill({ json: { username, suggestion: 'alice', color: 'teal' } }));
    await page.route('**/api/human/profile/username', async route => {
      assert.equal(route.request().method(), 'POST');
      const name = (route.request().postDataJSON() as { username: string }).username;
      saved.push(name);
      await route.fulfill(name === 'taken' ? { status: 409, json: { error: 'username_taken' } } : { json: { username: name } });
    });
    await page.goto(server.resolvedUrls!.local[0]!);
    await run(page, saved);
    assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    if (server) await new Promise<void>(resolve => server!.httpServer!.close(() => resolve()));
    await rm(profile, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  }
}

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  test(`a human without a username chooses one by keyboard at ${viewport.width}px`, { timeout: 60_000 }, async () => {
    await withFixture(viewport, null, async (page, saved) => {
      const heading = page.getByRole('heading', { name: 'Choose your username' });
      await expect(heading).toBeFocused();
      const input = page.getByRole('textbox', { name: 'Username' });
      await expect(input).toHaveValue('alice');
      assert.equal(await page.getByText('Opened channel').count(), 0);
      assert.equal(await page.locator('.khala-owner-shell').count(), 0);
      // Nothing overflows sideways, a phone included.
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      if (process.env.KHALA_SHOTS) {
        for (let shot = 0; shot < 2; shot += 1) {
          const theme = await page.locator('.khala-username-setup').getAttribute('data-theme');
          await page.screenshot({ path: join(process.env.KHALA_SHOTS, `username-setup-${viewport.width}-${theme}.png`) });
          await page.getByRole('button', { name: 'Toggle color theme' }).click();
          // The theme's colour transition settles before the next shot.
          await page.waitForTimeout(600);
        }
        await heading.focus();
      }

      await page.keyboard.press('Tab');
      await expect(input).toBeFocused();
      await input.fill('a');
      await expect(page.getByRole('alert')).toHaveText('At least 2 characters.');
      await expect(page.getByRole('button', { name: 'Continue' })).toBeDisabled();
      await input.fill('taken');
      await page.keyboard.press('Enter');
      await expect(page.getByRole('alert')).toHaveText('That username is taken.');

      await input.fill('Kevin');
      await expect(page.getByText(/Your agents will be named/u)).toHaveCount(0);
      await page.keyboard.press('Enter');
      // The asked-for route renders once the username is saved; the URL never moved.
      await expect(page.getByText('Opened channel')).toBeVisible();
      assert.deepEqual(saved, ['taken', 'Kevin']);
    });
  });
}

test('a human with a username goes straight in', { timeout: 60_000 }, async () => {
  await withFixture({ width: 1280, height: 800 }, 'Kevin', async page => {
    await expect(page.getByText('Opened channel')).toBeVisible();
    assert.equal(await page.getByRole('heading', { name: 'Choose your username' }).count(), 0);
  });
});

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  test(`the brand cog switches theme, renames and logs out by keyboard at ${viewport.width}px`, { timeout: 60_000 }, async () => {
    await withFixture(viewport, 'Kevin', async (page, saved) => {
      await page.goto(`${page.url()}?list`);
      const brand = page.locator('.khala-owner-shell .kh-brand');
      const cog = brand.getByRole('button', { name: 'Settings' });
      await expect(cog).toBeVisible();
      // Logo, wordmark, then the cog alone: no Live badge, theme toggle or Log out button.
      assert.equal(await brand.locator('.brand-live').count(), 0);
      assert.equal(await brand.getByRole('button', { name: 'Toggle color theme' }).count(), 0);
      assert.equal(await brand.getByRole('button', { name: 'Log out' }).count(), 0);
      assert.equal(await brand.locator('.kh-brand-actions > :last-child').getAttribute('aria-label'), 'Settings');
      await expect(cog).toHaveAttribute('aria-haspopup', 'menu');
      await expect(cog).toHaveAttribute('aria-expanded', 'false');
      // A pointer press where the item is: Playwright's own scroll-into-view
      // would scroll the clipped phone card, which a real tap does not.
      const press = async (item: Locator) => {
        const box = (await item.boundingBox())!;
        await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      };
      const shoot = async (name: string) => {
        if (!process.env.KHALA_SHOTS) return;
        // Popover and dialog entrances settle first.
        await page.waitForTimeout(300);
        const theme = await page.locator('.khala-owner-shell').getAttribute('data-theme');
        await page.screenshot({ path: join(process.env.KHALA_SHOTS, `settings-${name}-${viewport.width}-${theme}.png`) });
      };
      await shoot('closed');

      // Enter opens at the first item; arrows wrap; Home and End jump.
      await cog.focus();
      await page.keyboard.press('Enter');
      await expect(cog).toHaveAttribute('aria-expanded', 'true');
      const menu = page.getByRole('menu', { name: 'Settings' });
      const items = menu.getByRole('menuitem');
      assert.deepEqual(await items.allInnerTexts(), ['Light mode', 'Username\n@Kevin', 'Log out']);
      await expect(items.nth(0)).toBeFocused();
      await page.keyboard.press('ArrowUp');
      await expect(items.nth(2)).toBeFocused();
      await page.keyboard.press('ArrowDown');
      await expect(items.nth(0)).toBeFocused();
      await page.keyboard.press('End');
      await expect(items.nth(2)).toBeFocused();
      await page.keyboard.press('Home');
      await expect(items.nth(0)).toBeFocused();
      // The menu fits inside the card, a phone included.
      const card = await page.locator('.kh-card').boundingBox();
      const pop = await page.locator('.kh-pop').boundingBox();
      assert.ok(card && pop && pop.x >= card.x && pop.x + pop.width <= card.x + card.width, 'the menu stays inside the card');
      await shoot('open');
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);
      await expect(cog).toBeFocused();
      await expect(cog).toHaveAttribute('aria-expanded', 'false');

      // ArrowUp opens at the last item; Tab closes the menu.
      await page.keyboard.press('ArrowUp');
      await expect(items.nth(2)).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(menu).toHaveCount(0);

      // Mode switches the theme and returns focus to the cog.
      await cog.focus();
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await expect(page.locator('.khala-owner-shell')).toHaveAttribute('data-theme', 'light');
      await expect(cog).toBeFocused();
      await page.waitForTimeout(600);
      await shoot('closed');
      await cog.click();
      await expect(items.nth(0)).toHaveText('Dark mode');
      await shoot('open');
      await page.keyboard.press('Escape');

      // Username opens the dialog with focus in it; Esc closes back to the cog.
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      const dialog = page.getByRole('dialog', { name: 'Change username' });
      const input = dialog.getByRole('textbox', { name: 'Username' });
      await expect(input).toBeFocused();
      await expect(input).toHaveValue('Kevin');
      await expect(dialog.getByText(/renamed to match/u)).toHaveCount(0);
      const box = await dialog.boundingBox();
      if (viewport.width === 390) assert.equal(Math.round(box!.width), 390 - 32);
      await shoot('dialog');
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect(cog).toBeFocused();

      // Focus is trapped while the dialog is open; Save renames and the item reads the new name.
      await cog.click();
      await press(items.nth(1));
      await expect(input).toBeFocused();
      await page.keyboard.press('Shift+Tab');
      await expect(dialog.getByRole('button', { name: 'Save' })).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(input).toBeFocused();
      await input.fill('Kev');
      await page.keyboard.press('Enter');
      await expect(dialog).toHaveCount(0);
      await expect(cog).toBeFocused();
      assert.deepEqual(saved, ['Kev']);
      await cog.click();
      await expect(items.nth(1)).toHaveText(/@Kev$/u);
      await expect(page.locator('.khala-owner-shell')).toHaveAttribute('data-theme', 'light');
      await page.keyboard.press('Escape');

      // Log out keeps its brand-row messages; the fixture's sign-out fails.
      await cog.click();
      await press(items.nth(2));
      await expect(brand.getByRole('alert')).toHaveText('Log out failed. Try again.');
      await expect(cog).toBeFocused();
      // The message fits the brand row without scrolling the card sideways.
      assert.equal(await page.locator('.kh-card').evaluate(node => node.scrollLeft), 0);
      assert.equal(await brand.evaluate(node => node.scrollWidth <= node.clientWidth), true);
      if (process.env.KHALA_SHOTS) {
        // The dark-theme dialog, for the screenshot set.
        await cog.click();
        await press(items.nth(0));
        await page.waitForTimeout(600);
        await cog.click();
        await press(items.nth(1));
        await shoot('dialog');
      }
    });
  });
}
