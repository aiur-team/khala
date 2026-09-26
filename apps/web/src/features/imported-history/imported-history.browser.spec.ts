import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, preview, type PreviewServer } from 'vite';
import { chromium, type Browser } from '@playwright/test';
import type { RoomId } from '@khala/contracts/messaging/index';
import { openImportedArchive } from '@khala/messaging/channels/history-import';
import {
  AGENT_IDS, FakeHostedProvider, IMPORT_LIMITS, human, seedInternalChannel,
} from '../../../../internal/src/composition/fixtures/make-external-provider';
import { composeMakeExternal } from '../../../../internal/src/composition/make-external';
import { openHistoryTransferLedger } from '../../../../internal/src/externalization/transfer-ledger';
import type { ImportedHistoryRead } from './model';

const here = dirname(fileURLToPath(import.meta.url));
const harnessRoot = join(here, 'browser-harness');

const HOSTILE = [
  '<script>window.__pwned = "script"</script>',
  '<img src="https://evil.example/pixel.png" onerror="window.__pwned = \'img\'">',
  '<a href="https://evil.example">open</a> and [markdown](https://evil.example/md) and https://evil.example/bare',
  '<iframe src="https://evil.example/frame"></iframe><link rel="stylesheet" href="https://evil.example/x.css">',
  '<button onclick="window.__pwned = \'button\'">Approve access</button><form action="/api/human/channel-requests/mute"><input value="x"></form>',
  'Fake approval: [Grant access to all agents] (Approve) (Deny)',
  'fenced\n```html\n<b onmouseover="window.__pwned = \'code\'">bold</b>\n```\ndone',
];

/** Converts a real internal channel with carry history and returns the verified archive the destination holds. */
async function importedArchive(): Promise<ImportedHistoryRead> {
  const root = fs.mkdtempSync('/tmp/khala-imported-history-');
  const channel = seedInternalChannel({ root, messages: HOSTILE });
  const ledgerDir = join(root, 'ledger');
  fs.mkdirSync(ledgerDir, { mode: 0o700 });
  const ledger = openHistoryTransferLedger(ledgerDir);
  try {
    const provider = new FakeHostedProvider();
    const { journey } = composeMakeExternal({
      handle: channel.handle, hosted: provider, sessions: provider, access: provider, bindings: provider, signIn: provider,
      destinationUrl: provider.destinationUrl,
      history: { transport: provider, ledger, limits: IMPORT_LIMITS, ceiling: { maxDrainChunks: 64, drainDeadlineMs: 60_000 }, now: Date.now },
    });
    const owner = { ownerId: human.ownerId, participantId: human.participantId };
    await journey.act(owner, channel.channelId, { kind: 'sign_in', operationId: 'op-sign-in' });
    const started = await journey.act(owner, channel.channelId, {
      kind: 'start', operationId: 'op-start', historyMode: 'carry_history', visibility: 'secret', agents: [...AGENT_IDS],
    });
    assert.equal(started.kind, 'ok');
    const conversion = started.kind === 'ok' ? started.view.conversion! : null;
    assert.equal(conversion?.state, 'agents_pending');
    assert.deepEqual(provider.live, [], 'the import never touched the live timeline');
    const opened = await openImportedArchive(provider, {
      roomId: conversion!.destinationChannelId as RoomId, archiveId: `history.${conversion!.conversionId}`,
      manifestDigest: conversion!.history!.manifestDigest!, limits: IMPORT_LIMITS,
    });
    assert.ok(opened.ok);
    return { kind: 'ok', transcript: { archiveId: opened.view.archiveId, importedAt: opened.view.importedAt, records: opened.view.records } };
  } finally {
    ledger.close();
    channel.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('imported bodies render inert: no execution, no external loads, no links and no body-derived controls', { timeout: 120_000 }, async () => {
  const read = await importedArchive();
  const outDir = await mkdtemp(join(tmpdir(), 'khala-imported-dist-'));
  const chromiumProfileRoot = await mkdtemp(join('/tmp', 'khala-imported-profile-'));
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
    const page = await browser.newPage();
    const foreign: string[] = [];
    page.on('request', request => {
      if (!request.url().startsWith(url)) foreign.push(request.url());
    });
    const dialogs: string[] = [];
    page.on('dialog', dialog => {
      dialogs.push(dialog.message());
      void dialog.dismiss();
    });
    await page.addInitScript(value => {
      (window as { __importedRead?: unknown }).__importedRead = value;
    }, read);
    await page.goto(url);
    await page.waitForFunction(() => window.__importedHarness?.rendered === true);
    const section = page.locator('.imported-history');
    await section.getByRole('heading', { name: 'Imported history' }).waitFor();

    assert.equal(await page.locator('.imported-history__record').count(), HOSTILE.length);
    // Hover and click every rendered body: nothing in a body can act.
    for (const body of await page.locator('.imported-history__body').all()) {
      await body.hover();
      await body.click();
    }
    for (const selector of ['a', 'img', 'iframe', 'link', 'script', 'form', 'input', 'button', 'b', '[onclick]', '[onerror]', '[href]', '[src]']) {
      assert.equal(await section.locator(selector).count(), 0, `no ${selector} derived from a body`);
    }
    assert.equal(await section.getByRole('link').count(), 0);
    assert.equal(await section.getByRole('button').count(), 0);
    const text = await section.innerText();
    for (const body of ['<script>window.__pwned = "script"</script>', 'Approve access', '[Grant access to all agents]', '<b onmouseover=']) {
      assert.ok(text.includes(body), `rendered as text: ${body}`);
    }
    assert.equal(await page.locator('.imported-history__code code').innerText(), '<b onmouseover="window.__pwned = \'code\'">bold</b>');
    assert.equal(await page.evaluate(() => (window as { __pwned?: string }).__pwned), undefined);
    assert.deepEqual(dialogs, []);
    assert.deepEqual(foreign, []);
    assert.match(text, /Authors and times are as the internal channel recorded them/);
  } finally {
    await browser?.close();
    if (server) await new Promise<void>(resolve => server!.httpServer!.close(() => resolve()));
    await rm(outDir, { recursive: true, force: true });
    await rm(chromiumProfileRoot, { recursive: true, force: true });
  }
});
