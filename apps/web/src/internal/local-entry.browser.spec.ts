// Real-HTTP journey for the internal web entry: the production local bundle is
// built with Vite, served by the real loopback channel server over a real
// SQLite store, and driven in Chromium under the server's strict CSP.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from '@playwright/test';
import { build, type Plugin } from 'vite';
import { startChannelServer } from '../../../internal/src/server/channel-server';
import { carolBinding, channelId, createChannelFixture } from '../../../internal/src/server/fixtures/channel-fixture';
import { mintCredential } from '../../../internal/src/server/credentials';
import { webBundleManifest } from '../../../internal/src/launcher/bundle';
import type { LoopbackServer } from '../../../internal/src/server/server';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const repoRoot = fs.realpathSync(path.resolve(webRoot, '../..'));

/** Hosted-only code the local asset graph must never contain. */
const HOSTED_ONLY_MODULES = [
  /node_modules\/.*matrix-js-sdk\//,
  /apps\/web\/src\/composition\/human\/(?:matrix-browser|browser-api|mount|capabilities|routes|entry)\./,
  /apps\/web\/src\/composition\/recovery\//,
  /apps\/web\/src\/features\/(?:join|pairing|recovery)\//,
  /packages\/messaging\/src\/(?:browser-device|recovery)\//,
];
const LOCAL_ONLY_MODULES = [/apps\/web\/src\/internal\//, /packages\/messaging\/src\/local\//];

/**
 * Builds one Vite config into `outDir` and returns the repo-relative ID of every
 * module in its import graph, before tree-shaking: an import is a dependency
 * path even when nothing it exports survives minification.
 */
async function buildGraph(configFile: string, outDir: string): Promise<string[]> {
  const modules = new Set<string>();
  const collect: Plugin = {
    name: 'khala-collect-module-graph',
    buildEnd() {
      for (const id of this.getModuleIds()) {
        if (id.startsWith('\0')) continue;
        const file = id.split('?')[0]!;
        modules.add(path.relative(repoRoot, fs.existsSync(file) ? fs.realpathSync(file) : file));
      }
    },
  };
  await build({ configFile, logLevel: 'silent', plugins: [collect], build: { outDir, emptyOutDir: true } });
  return [...modules];
}

async function text(page: Page): Promise<string> {
  return page.locator('body').innerText();
}

test('local web entry: create/open/send/observe over real HTTP without hosted-only UI or modules', { timeout: 240_000 }, async () => {
  const base = fs.realpathSync(fs.mkdtempSync('/tmp/khala-local-web-'));
  const chromiumProfileRoot = fs.mkdtempSync('/tmp/khala-local-web-profile-');
  const bundle = path.join(base, 'internal-web');
  const storeRoot = path.join(base, 'store');
  fs.mkdirSync(storeRoot);
  let server: LoopbackServer | undefined;
  let browser: Browser | undefined;
  const fixture = createChannelFixture({ root: storeRoot, now: Date.now() });
  try {
    // Asset graph (wrong-implementation check, part 2): the local bundle carries no
    // Matrix, join, pairing or recovery module, and the hosted bundle carries no local module.
    const local = await buildGraph(path.join(webRoot, 'vite.internal.config.mjs'), bundle);
    assert.ok(local.some(id => id.startsWith('apps/web/src/internal/main.tsx')), 'the local entry was built');
    assert.ok(local.some(id => id.startsWith('packages/messaging/src/local/http/')), 'the local transport is bundled');
    assert.deepEqual(local.filter(id => HOSTED_ONLY_MODULES.some(pattern => pattern.test(id))), []);
    const hosted = await buildGraph(path.join(webRoot, 'vite.config.ts'), path.join(base, 'hosted'));
    assert.ok(hosted.some(id => /apps\/web\/src\/features\/join\//.test(id)), `the hosted bundle keeps its join flow: ${hosted.filter(i => i.startsWith('apps/web/src')).join(' ')}`);
    assert.ok(hosted.some(id => /apps\/web\/src\/features\/create-channel\/share-link\./.test(id)), 'the hosted bundle keeps its share flow');
    assert.deepEqual(hosted.filter(id => LOCAL_ONLY_MODULES.some(pattern => pattern.test(id))), []);

    // A second, distinct agent joins the channel so attribution is exercised.
    fixture.store.setMembership({ channelId, participantId: carolBinding.agentParticipantId, membership: 'joined' });
    const carol = { credential: mintCredential(), binding: carolBinding, channels: [channelId] };
    let id = 0;
    server = await startChannelServer({
      store: fixture.store,
      bootstrap: [fixture.bootstrap],
      bindings: [fixture.bob, carol],
      newId: () => `evt-${Date.now()}-${++id}`,
      clock: Date.now,
      startPort: 0,
      assets: webBundleManifest(bundle),
    });
    const origin = server.origin;
    const agentSend = (credential: string, body: string) => fetch(`${origin}/api/v1/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
      body: JSON.stringify({ clientTxnId: `agent-${body.replaceAll(' ', '-')}`, content: { v: 1, kind: 'text', body } }),
    });

    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
      headless: true,
      args: ['--no-sandbox'],
      env: { ...process.env, TMPDIR: chromiumProfileRoot },
    });
    const context = await browser.newContext();
    const page = await context.newPage();
    const violations: string[] = [];
    page.on('console', entry => {
      if (/Content Security Policy|Refused to/i.test(entry.text())) violations.push(entry.text());
    });
    const sentTxnIds: string[] = [];
    page.on('request', request => {
      if (request.method() === 'POST' && request.url().endsWith('/messages')) sentTxnIds.push(JSON.parse(request.postData() ?? '{}').clientTxnId);
    });

    // Bootstrap lands directly on the launcher-selected channel.
    await page.goto(`${origin}/__khala/bootstrap#credential=${fixture.bootstrap.credential}&channel=${channelId}`);
    await page.waitForURL(`${origin}/channels/${channelId}`);
    await page.getByText('No messages yet.').waitFor();
    assert.equal(await page.getByRole('heading', { name: 'Local channel' }).count(), 1);

    // Observe: two agents' messages arrive over the hint stream with their own attribution.
    assert.equal((await agentSend(fixture.bob.credential, 'from bob')).status, 201);
    assert.equal((await agentSend(carol.credential, 'from carol')).status, 201);
    await page.getByText('from carol').waitFor();
    const rows = await page.locator('.timeline__row').allInnerTexts();
    assert.ok(rows.some(row => row.includes('Bob') && row.includes('from bob')), rows.join('\n'));
    assert.ok(rows.some(row => row.includes('Carol') && row.includes('from carol')), rows.join('\n'));

    // Send: the human's message is accepted and reconciled into the durable timeline.
    await page.getByRole('textbox', { name: 'Message' }).fill('hello agents');
    await page.getByRole('button', { name: 'Send' }).click();
    await page.locator('.timeline__row:not(.timeline__row--pending)', { hasText: 'hello agents' }).waitFor();
    await page.waitForFunction(() => document.querySelectorAll('.timeline__row--pending').length === 0);

    // An unknown outcome keeps its operation identity across a reload and resolves under it.
    await page.route('**/messages', route => route.abort('connectionreset'));
    await page.getByRole('textbox', { name: 'Message' }).fill('maybe delivered');
    await page.getByRole('button', { name: 'Send' }).click();
    await page.getByText('Delivery unknown').waitFor();
    const unknownTxn = sentTxnIds.at(-1)!;
    await page.unroute('**/messages');
    await page.reload();
    await page.getByText('Delivery unknown').waitFor();
    await page.getByRole('button', { name: 'Check delivery' }).click();
    await page.locator('.timeline__row:not(.timeline__row--pending)', { hasText: 'maybe delivered' }).waitFor();
    assert.equal(sentTxnIds.at(-1), unknownTxn, 'the retry reused the original clientTxnId');
    const stored = fixture.store.timeline({ channelId, participantId: fixture.bootstrap.human.participantId, reader: { kind: 'member' }, cursor: null, limit: 100 });
    assert.equal(stored.kind === 'done' && stored.events.filter(event => event.content.body === 'maybe delivered').length, 1);

    // Wrong-implementation check, part 1: there is no join route, in the server or the app.
    const joinResponse = await page.goto(`${origin}/join?invite=abc`);
    assert.equal(joinResponse?.status(), 404);
    await page.goto(`${origin}/channels/${channelId}`);
    await page.getByText('hello agents').waitFor();
    await page.evaluate(() => {
      history.pushState(null, '', '/join?invite=abc');
      dispatchEvent(new PopStateEvent('popstate'));
    });
    await page.getByText('This local Khala page does not exist.').waitFor();
    const joinText = await text(page);
    assert.doesNotMatch(joinText, /\bJoin\b|Sign in/);

    // Private create lands directly on the new channel with no share or admission step.
    await page.evaluate(() => {
      history.pushState(null, '', '/');
      dispatchEvent(new PopStateEvent('popstate'));
    });
    await page.getByRole('button', { name: 'Create channel' }).waitFor();
    assert.doesNotMatch(await text(page), /Who can join|Copy link|Sign in/);
    await page.getByLabel('Channel name (optional)').fill('Scratch');
    await page.getByRole('button', { name: 'Create channel' }).click();
    await page.waitForURL(/\/channels\/evt-/);
    await page.getByText('No messages yet.').waitFor();

    // Transport loss: sending pauses with an announced reconnecting state and the draft is kept.
    await page.getByRole('textbox', { name: 'Message' }).fill('draft survives');
    await server.close();
    server = undefined;
    await page.getByText(/Reconnecting \(attempt \d\)/).waitFor({ timeout: 20_000 });
    assert.equal(await page.getByRole('button', { name: 'Send' }).isDisabled(), true);
    assert.equal(await page.getByRole('textbox', { name: 'Message' }).inputValue(), 'draft survives');

    assert.deepEqual(violations, []);
  } finally {
    await browser?.close();
    await server?.close();
    fixture.dispose();
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(chromiumProfileRoot, { recursive: true, force: true });
  }
});
