// Real-HTTP journey for receipt evidence in the internal channel timeline: the
// production local bundle, the real loopback server with its owner gate, and real
// projected receipt facts in SQLite, driven in Chromium.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from '@playwright/test';
import { build } from 'vite';
import { startChannelServer } from '../../../internal/src/server/channel-server';
import { bobBinding, channelId, createChannelFixture } from '../../../internal/src/server/fixtures/channel-fixture';
import { webBundleManifest } from '../../../internal/src/launcher/bundle';
import type { LoopbackServer } from '../../../internal/src/server/server';
import { type ProjectedReceipt, createReceiptReadModel } from '../../../internal/src/store/receipts';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

let ledgerRevision = 0;
function fact(kind: string, releaseId: string, eventIds: readonly string[], batch?: string): ProjectedReceipt {
  ledgerRevision += 1;
  const acknowledged = kind === 'agent_acknowledged';
  const evidenceRef = acknowledged ? batch! : `ref-${releaseId}-${kind}`;
  return {
    receipt: {
      v: acknowledged ? 2 : 1,
      receiptId: `receipt-${releaseId}-${kind}`,
      releaseId,
      bindingId: bobBinding.bindingId,
      generation: bobBinding.generation,
      kind,
      observedAt: new Date(Date.UTC(2026, 8, 25, 0, 0, ledgerRevision)).toISOString(),
      source: acknowledged ? 'agent' : 'harness',
      evidenceRef: acknowledged ? evidenceRef : null,
      errorCode: null,
    } as ProjectedReceipt['receipt'],
    evidenceRef,
    ledgerRevision,
    events: eventIds.map(eventId => ({ channelId, eventId: eventId as ProjectedReceipt['events'][number]['eventId'] })),
  };
}

const activeId = (page: Page) => page.evaluate(() => document.activeElement?.id ?? '');
const announced = (page: Page) => page.locator('.receipt-evidence__announcer').innerText();

test('receipt evidence: truthful, grouped, navigable and announced once over real HTTP', { timeout: 240_000 }, async () => {
  const base = fs.realpathSync(fs.mkdtempSync('/tmp/khala-receipt-web-'));
  const chromiumProfileRoot = fs.mkdtempSync('/tmp/khala-receipt-web-profile-');
  const bundle = path.join(base, 'internal-web');
  const storeRoot = path.join(base, 'store');
  fs.mkdirSync(storeRoot);
  let server: LoopbackServer | undefined;
  let browser: Browser | undefined;
  const fixture = createChannelFixture({ root: storeRoot, now: Date.now() });
  const readModel = createReceiptReadModel(fixture.handle);
  try {
    await build({ configFile: path.join(webRoot, 'vite.internal.config.mjs'), logLevel: 'silent', build: { outDir: bundle, emptyOutDir: true } });
    let id = 0;
    server = await startChannelServer({
      store: fixture.store,
      bootstrap: [fixture.bootstrap],
      bindings: [fixture.bob],
      receipts: readModel,
      newId: () => `evt-${++id}`,
      clock: Date.now,
      startPort: 0,
      assets: webBundleManifest(bundle),
    });
    const origin = server.origin;
    const send = async (body: string): Promise<string> => {
      const response = await fetch(`${origin}/api/v1/channels/${channelId}/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${fixture.bob.credential}`, 'content-type': 'application/json' },
        body: JSON.stringify({ clientTxnId: `agent-${body.replaceAll(" ", "-")}`, content: { v: 1, kind: 'text', body } }),
      });
      assert.equal(response.status, 201);
      return (await response.json() as { event: { eventId: string } }).event.eventId;
    };
    const solo = await send('solo message');
    const first = await send('batched one');
    const second = await send('batched two');
    for (const projected of [
      fact('context_consumed', 'rel-solo', [solo]),
      fact('agent_acknowledged', 'rel-solo', [solo], 'ack-solo'),
      fact('agent_acknowledged', 'rel-one', [first], 'ack-multi'),
      fact('agent_acknowledged', 'rel-two', [second], 'ack-multi'),
    ]) assert.equal((await readModel.projectReceipt(projected)).kind, 'stored');

    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
      headless: true,
      args: ['--no-sandbox'],
      env: { ...process.env, TMPDIR: chromiumProfileRoot },
    });
    const page = await (await browser.newContext()).newPage();
    await page.goto(`${origin}/__khala/bootstrap#credential=${fixture.bootstrap.credential}&channel=${channelId}`);
    await page.waitForURL(`${origin}/channels/${channelId}`);
    await page.getByText('batched two').waitFor();

    // One event, one release: the evidence sits beside the message with its boundary described.
    const soloRow = page.locator(`[data-event-id="${solo}"]`);
    await soloRow.getByText('Added to agent context').waitFor();
    const tokenReturn = soloRow.locator('.receipt-evidence__fact--token-return');
    const describedBy = await tokenReturn.getAttribute('aria-describedby');
    assert.ok(describedBy);
    assert.match(await page.locator(`[id="${describedBy}"]`).textContent() ?? '', /does not prove the agent acted on the message/);
    const help = soloRow.getByRole('button', { name: 'What this means' });
    await help.focus();
    await page.keyboard.press('Enter');
    assert.equal(await help.getAttribute('aria-expanded'), 'true');
    await page.locator(`[id="${describedBy}"]`).waitFor({ state: 'visible' });
    assert.equal(await page.getByText('Read by the agent').count(), 0);

    // A multi-release batch is one token-return observation with one target.
    assert.equal(await page.locator('.receipt-evidence--group .receipt-evidence__fact--token-return').count(), 1);
    const heading = page.getByRole('heading', { name: 'Batch evidence: 2 releases, 2 messages' });
    await heading.waitFor();
    const headingId = await heading.getAttribute('id');
    const link = page.locator(`[data-event-id="${second}"]`).getByRole('link', { name: 'View batch evidence' });
    const linkId = await link.getAttribute('id');
    assert.equal(await page.getByRole('link', { name: 'View batch evidence' }).count(), 2);

    // Keyboard activation moves focus to the group; back returns it to the invoking row, on the same route.
    await link.focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(id => document.activeElement?.id === id, headingId);
    assert.equal(new URL(page.url()).hash, `#${headingId!.replace(/-heading$/, '')}`);
    await page.goBack();
    await page.waitForFunction(id => document.activeElement?.id === id, linkId);
    assert.equal(new URL(page.url()).pathname, `/channels/${channelId}`);
    assert.equal(await activeId(page), linkId);

    // Hydration was silent; a later fact is announced once, without moving focus.
    assert.equal(await announced(page), '');
    assert.equal((await readModel.projectReceipt(fact('completed', 'rel-solo', [solo]))).kind, 'stored');
    await page.waitForFunction(() => document.querySelector('.receipt-evidence__announcer')?.textContent?.includes('Agent turn completed'), null, { timeout: 20_000 });
    assert.equal(await announced(page), 'New delivery evidence: Agent turn completed.');
    assert.equal(await activeId(page), linkId, 'the announcement never moves focus');
    await soloRow.getByText('Added to agent context').waitFor();

    // Reload replays every fact silently, from the durable read model.
    await page.reload();
    await page.locator(`[data-event-id="${solo}"]`).getByText('Agent turn completed').waitFor();
    assert.equal(await announced(page), '');

    // A failed evidence read keeps messages visible and never claims an absence; retry recovers.
    let failing = true;
    let evidenceReads = 0;
    await page.route('**/receipts', route => {
      evidenceReads += 1;
      return failing
        ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":{"code":"unavailable"}}' })
        : route.continue();
    });
    await page.reload();
    await page.getByText('Delivery evidence unavailable').waitFor();
    await page.getByText('solo message').waitFor();
    assert.equal(await page.getByText('No token-return fact').count(), 0);
    assert.equal(await page.getByText('Batch token returned').count(), 0);
    const before = evidenceReads;
    await Promise.all([
      page.waitForResponse(response => response.url().endsWith('/receipts')),
      page.getByRole('button', { name: 'Retry' }).click(),
    ]);
    assert.ok(evidenceReads > before, 'Retry rereads the evidence');
    await page.getByText('Delivery evidence unavailable').waitFor();
    failing = false;
    await page.locator(`[data-event-id="${solo}"]`).getByText('Batch token returned').waitFor({ timeout: 20_000 });
    assert.equal(await page.getByText('Delivery evidence unavailable').count(), 0);
  } finally {
    await browser?.close();
    await server?.close();
    fixture.dispose();
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(chromiumProfileRoot, { recursive: true, force: true });
  }
});
