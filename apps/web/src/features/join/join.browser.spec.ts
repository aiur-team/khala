import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { build, preview, type PreviewServer } from 'vite';
import { chromium, type Browser } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const harnessRoot = join(here, '../../composition/human/browser-harness');
const SECRET_INVITE_REF = 'super-secret-invite-token-do-not-log-9f2c';

// Real desktop/phone viewports and real same-origin navigation against the
// production controller/screen composed with synthetic ports; this harness
// renders join in isolation and is not a full-page integration test. Live
// OAuth/admission proof belongs to KHA-132.
test('join screen: real navigation, viewport overflow and secret handling', { timeout: 90_000 }, async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'khala-join-dist-'));
  const chromiumProfileRoot = await mkdtemp(join('/tmp', 'khala-join-profile-'));
  let server: PreviewServer | undefined;
  let browser: Browser | undefined;
  try {
    await build({ root: harnessRoot, build: { outDir, emptyOutDir: true,
      rollupOptions: { input: join(harnessRoot, 'personal-links.html') } }, logLevel: 'error' });
    await copyFile(join(outDir, 'personal-links.html'), join(outDir, 'index.html'));
    server = await preview({ root: harnessRoot, build: { outDir }, preview: { host: '127.0.0.1', port: 0 } });
    const url = `${server.resolvedUrls!.local[0]!}personal-links.html`;

    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
      headless: true,
      args: ['--no-sandbox'],
      env: { ...process.env, TMPDIR: chromiumProfileRoot },
    });

    for (const theme of ['light', 'dark']) {
      for (const width of [390, 1280]) {
        const page = await browser.newPage({ viewport: { width, height: 844 } });
        for (const title of ['Launch plans', '']) {
          await page.goto(`${url}?invite=test-invite&identity=signed_in&state=eligible&theme=${theme}&title=${encodeURIComponent(title)}`);
          await page.getByText("You're in.").waitFor();
          assert.equal(await page.getByText(`Channel: ${title || 'a Khala channel'}`, { exact: true }).count(), 1);
          assert.doesNotMatch(await page.locator('body').innerText(), /room_1/);
          if (process.env.KHALA_SCREENSHOT_DIR) {
            await mkdir(process.env.KHALA_SCREENSHOT_DIR, { recursive: true });
            await page.screenshot({ path: join(process.env.KHALA_SCREENSHOT_DIR, `join-${title ? 'named' : 'fallback'}-${theme}-${width}.png`) });
          }
        }
        await page.close();
      }
    }

    // Browser back from sign-in does not auto-redirect forever: sign in,
    // land on the synthetic OAuth page, go back, and confirm we are on the
    // sign-in prompt again rather than looping back into OAuth.
    {
      const page = await browser.newPage({ viewport: { width: 1024, height: 800 } });
      const consoleMessages: string[] = [];
      page.on('console', message => consoleMessages.push(message.text()));

      await page.goto(`${url}?invite=${SECRET_INVITE_REF}`);
      await page.getByRole('link', { name: 'Agent instructions' }).waitFor();
      assert.match(await page.locator('body').innerText(), /Joining as a person gives you your own link for your agent/);
      assert.doesNotMatch(await page.locator('body').innerText(), new RegExp(SECRET_INVITE_REF));
      await page.getByRole('button', { name: 'Sign in' }).waitFor();
      await page.getByRole('button', { name: 'Sign in' }).click();
      await page.getByRole('link', { name: /Continue as test user/ }).waitFor();
      assert.match(page.url(), /page=oauth-mock/);

      await page.goBack();
      await page.getByRole('button', { name: 'Sign in' }).waitFor();
      assert.doesNotMatch(page.url(), /page=oauth-mock/, 'back from OAuth returns to sign-in, not another OAuth hop');

      // Complete the round trip: still signed in leads to the joined state, once.
      await page.getByRole('button', { name: 'Sign in' }).click();
      await page.getByRole('link', { name: /Continue as test user/ }).click();
      await page.getByText("You're in.").waitFor();
      assert.equal(await page.getByText(/You.re in/).count(), 1);

      // The raw invite reference never reaches console output.
      assert.equal(consoleMessages.some(text => text.includes(SECRET_INVITE_REF)), false, 'invite reference leaked into console output');

      // Nor does it land in localStorage.
      const storedValues = await page.evaluate(() => Object.values(window.localStorage));
      assert.equal(
        storedValues.some(value => value.includes(SECRET_INVITE_REF)),
        false,
        'invite reference leaked into localStorage',
      );
      await page.close();
    }

    // 390px portrait and landscape render a long verified email without horizontal overflow.
    for (const [label, width, height] of [
      ['390px portrait', 390, 844],
      ['landscape phone', 844, 390],
    ] as const) {
      const page = await browser.newPage({ viewport: { width, height } });
      await page.goto(`${url}?invite=${SECRET_INVITE_REF}&identity=signed_in&state=eligible`);
      await page.getByText(/Signed in as/).waitFor();
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
        true,
        `${label}: long verified email overflowed the viewport`,
      );
      await page.close();
    }

    // Distinct recoverable states render distinct, explicit copy.
    for (const [state, expectedText] of [
      ['expired', /expired/i],
      ['revoked', /revoked/i],
      ['identity_mismatch', /wrong account/i],
      ['invalid_link', /not valid/i],
    ] as const) {
      const page = await browser.newPage({ viewport: { width: 1024, height: 800 } });
      await page.goto(`${url}?invite=${SECRET_INVITE_REF}&identity=signed_in&state=${state}`);
      await page.getByRole('alert').waitFor();
      assert.match(await page.getByRole('alert').innerText(), expectedText, `${state} did not render its distinct copy`);
      assert.equal(await page.getByRole('button', { name: 'Try again' }).count(), 0, `${state} must not offer a retry action`);
      await page.close();
    }

    // A creates the channel, B opens A's link in a separate signed-in context,
    // and each person gets a distinct personal link after admission.
    const a = await browser.newPage({ viewport: { width: 1024, height: 800 } });
    const b = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await a.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await a.goto(`${url}?create=1&owner=owner_alice`);
    await a.getByRole('heading', { name: 'Test channel' }).waitFor();
    await a.evaluate(`(() => {
      const writeText = navigator.clipboard.writeText.bind(navigator.clipboard);
      let writes = 0;
      Object.defineProperty(window, '__shareWrites', { get: () => writes });
      navigator.clipboard.writeText = async text => { writes += 1; return writeText(text); };
    })()`);
    const linkA = `${new URL(url).origin}/join/owner_alice`;
    assert.match(linkA, /\/join\/owner_alice$/);
    assert.equal(await a.locator('.channel-share input, .channel-share__hint').count(), 0);
    await a.getByRole('button', { name: 'Copy my channel link' }).click();
    await a.getByRole('status').getByText('Copied').waitFor();
    assert.equal(await a.evaluate(() => navigator.clipboard.readText()), linkA);
    assert.equal(await a.evaluate(() => (window as unknown as { __shareWrites: number }).__shareWrites), 1);
    await a.getByRole('button', { name: 'Copy my channel link' }).evaluate(button => button.blur());
    await a.keyboard.press('Tab');
    assert.equal(await a.getByRole('button', { name: 'Copy my channel link' }).evaluate(button => button === document.activeElement), true);
    assert.equal(await a.getByRole('button', { name: 'Copy my channel link' }).evaluate(button => getComputedStyle(button).outlineStyle), 'solid');
    await a.keyboard.press('Enter');
    assert.equal(await a.evaluate(() => (window as unknown as { __shareWrites: number }).__shareWrites), 2);
    await a.goto(linkA);
    await a.getByText("You're in.").waitFor();
    await a.getByRole('button', { name: 'Copy my channel link' }).waitFor();

    await b.goto(`${url}?create=1&owner=owner_bob`);
    await b.goto(linkA);
    await b.getByText("You're in.").waitFor();
    await b.getByRole('button', { name: 'Copy my channel link' }).waitFor();
    const linkB = `${new URL(url).origin}/join/owner_bob`;
    assert.match(linkB, /\/join\/owner_bob$/);
    assert.notEqual(linkA, linkB);
    await b.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await b.getByRole('button', { name: 'Copy my channel link' }).click();
    await b.getByRole('status').getByText('Copied').waitFor();
    assert.equal(await b.evaluate(() => navigator.clipboard.readText()), linkB);
    assert.equal(await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await b.reload();
    await b.getByText("You're in.").waitFor();
    await b.getByRole('button', { name: 'Copy my channel link' }).waitFor();
    assert.equal(await b.locator('.channel-share input, .channel-share__hint').count(), 0);
    await a.close();
    await b.close();

    // A revoked callback never exposes room content (AE1).
    {
      const page = await browser.newPage({ viewport: { width: 1024, height: 800 } });
      await page.goto(`${url}?invite=${SECRET_INVITE_REF}&identity=signed_in&state=revoked`);
      await page.getByRole('alert').waitFor();
      assert.equal(await page.getByText('room_1').count(), 0, 'revoked screen must not expose room content');
      await page.close();
    }
  } finally {
    await browser?.close();
    if (server) await new Promise<void>(resolve => server!.httpServer!.close(() => resolve()));
    await rm(outDir, { recursive: true, force: true });
    await rm(chromiumProfileRoot, { recursive: true, force: true });
  }
});
