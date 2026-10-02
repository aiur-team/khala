import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { build, preview, type PreviewServer } from 'vite';
import { chromium, expect, type Browser } from '@playwright/test';

for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
  test(`owner confirms and opens the channel at ${viewport.width}px (AE1 browser leg)`, { timeout: 60_000 }, async () => {
    const scratch = await mkdtemp(join(process.env.TMPDIR ?? '/tmp', 'khala-agent-confirm-'));
    // Chromium's Unix socket needs a short path even in long issue workspaces.
    const profile = await mkdtemp('/tmp/khala-845-browser-');
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
      const origin = server.resolvedUrls!.local[0]!;
      const view = { joinId: 'j1', label: 'Helper', harness: 'claude', channelName: 'Launch', roomId: '!r1:khala.local', state: 'pending' };
      const confirmed = { ...view, state: 'confirmed', agentUserId: '@agent-x:khala.local' };
      let confirmations = 0;
      let polls = 0;
      const invites: unknown[] = [];
      const errors: string[] = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.route('**/api/human/auth/login?**', async route => {
        assert.equal(new URL(route.request().url()).searchParams.get('return_to'), '/agent/confirm?joinId=j1');
        await route.fulfill({ status: 302, headers: { location: '/agent/confirm?joinId=j1' } });
      });
      await page.route('**/api/human/me', route => route.fulfill({ json: {
        principal: { v: 1, ownerId: 'owner_alice', providerIssuer: 'https://issuer.example', providerSubject: 'alice',
          verifiedEmail: 'alice@example.test', sessionExpiresAt: '2030-01-01T00:00:00Z' }, csrfToken: 'browser-proof',
      } }));
      await page.route('**/api/human/agent-join?*', route => route.fulfill({ json: view }));
      await page.route('**/api/human/agent-join/confirm?*', async route => {
        confirmations += 1;
        assert.equal(route.request().method(), 'POST');
        assert.equal(route.request().headers()['x-khala-csrf'], 'browser-proof');
        assert.deepEqual(route.request().postDataJSON(), {});
        await route.fulfill({ json: confirmed });
      });
      await page.route('**/api/human/agent-join/status?*', route => {
        polls += 1;
        return route.fulfill({ json: { ...confirmed, state: polls >= 3 ? 'ready' : 'confirmed' } });
      });
      await page.route('**/fixture/invite', route => {
        invites.push(route.request().postDataJSON());
        return route.fulfill({ json: {} });
      });
      await page.goto(origin + '?signedOut=1');
      // Signed out, the page goes straight to sign-in and back; no button.
      await expect(page.getByRole('button', { name: 'Confirm', exact: true })).toBeVisible();
      assert.equal(new URL(page.url()).pathname + new URL(page.url()).search, '/agent/confirm?joinId=j1');
      assert.match(await page.locator('body').innerText(), /Helper \(Claude Code\) wants to join Launch\./);
      await page.getByRole('button', { name: 'Confirm', exact: true }).click();
      await page.getByText('Connecting Helper… Keep this tab open.').waitFor();
      await page.getByRole('link', { name: 'Open channel' }).waitFor();
      await expect(page.getByText('Helper joined Launch.', { exact: true })).toBeVisible();
      assert.equal(confirmations, 1);
      assert.equal(polls, 3);
      assert.deepEqual(invites, [{ roomId: '!r1:khala.local', userId: '@agent-x:khala.local' }]);
      assert.equal(await page.getByText('Keep this tab open.', { exact: false }).count(), 0);
      await page.getByRole('link', { name: 'Open channel' }).click();
      assert.equal(new URL(page.url()).pathname, '/channels/!r1%3Akhala.local');
      await page.getByText('Opened channel', { exact: true }).waitFor();
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      if (server) await new Promise<void>(resolve => server!.httpServer!.close(() => resolve()));
      await rm(profile, { recursive: true, force: true });
      await rm(scratch, { recursive: true, force: true });
    }
  });
}
