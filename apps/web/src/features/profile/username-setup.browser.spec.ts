import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { build, preview, type PreviewServer } from 'vite';
import { chromium, expect, type Browser, type Page } from '@playwright/test';

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
      await expect(page.getByText('Your agents will be named @Kevin-Claude and @Kevin-Codex.')).toBeVisible();
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
