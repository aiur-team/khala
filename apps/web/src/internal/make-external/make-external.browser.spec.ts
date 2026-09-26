// Real-HTTP Make-external journey: the production internal bundle, served by the real
// loopback channel server over a real SQLite store, with the real conversion journal,
// service, history export and journey. Only the hosted service is a fake, and it loses
// responses. Every journey is driven in Chromium under the server's strict CSP.

import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from '@playwright/test';
import { build } from 'vite';
import type { EventId, RoomId } from '@khala/contracts/messaging/index';
import { openImportedArchive } from '@khala/messaging/channels/history-import';
import { startChannelServer } from '../../../../internal/src/server/channel-server';
import {
  aliceDevice, alice, carol, channelId, createChannelFixture, type ChannelFixture,
} from '../../../../internal/src/server/fixtures/channel-fixture';
import { webBundleManifest } from '../../../../internal/src/launcher/bundle';
import type { LoopbackServer } from '../../../../internal/src/server/server';
import { FakeHostedProvider, IMPORT_LIMITS } from '../../../../internal/src/composition/fixtures/make-external-provider';
import { type ComposedMakeExternal, composeMakeExternal } from '../../../../internal/src/composition/make-external';
import { openHistoryTransferLedger } from '../../../../internal/src/externalization/transfer-ledger';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const owner = { ownerId: alice.ownerId, participantId: alice.participantId };

let base = '';
let bundle = '';
let browser: Browser | undefined;
let chromiumProfileRoot = '';

before(async () => {
  base = fs.realpathSync(fs.mkdtempSync('/tmp/khala-make-external-web-'));
  bundle = path.join(base, 'internal-web');
  await build({ configFile: path.join(webRoot, 'vite.internal.config.mjs'), logLevel: 'silent', build: { outDir: bundle, emptyOutDir: true } });
  chromiumProfileRoot = fs.mkdtempSync('/tmp/khala-make-external-profile-');
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    headless: true,
    args: ['--no-sandbox'],
    env: { ...process.env, TMPDIR: chromiumProfileRoot },
  });
});

after(async () => {
  await browser?.close();
  fs.rmSync(base, { recursive: true, force: true });
  fs.rmSync(chromiumProfileRoot, { recursive: true, force: true });
});

type Launched = Readonly<{
  page: Page;
  origin: string;
  fixture: ChannelFixture;
  provider: FakeHostedProvider;
  composed: ComposedMakeExternal;
  violations: string[];
  send(body: string): boolean;
  close(): Promise<void>;
}>;

let launches = 0;

async function launch(messages: readonly string[] = [], maxDrainChunks = 64): Promise<Launched> {
  launches += 1;
  const root = path.join(base, `store-${launches}`);
  fs.mkdirSync(root);
  const fixture = createChannelFixture({ root, now: Date.now() });
  fixture.store.setMembership({ channelId, participantId: carol.participantId, membership: 'joined' });
  let sent = 0;
  const send = (body: string) => {
    sent += 1;
    const stored = fixture.store.send({
      channelId, eventId: `seed-${sent}` as EventId, authorParticipantId: alice.participantId, authorDeviceId: aliceDevice,
      clientTxnId: `seed-${sent}`, content: { v: 1, kind: 'text', body }, receivedAt: new Date(Date.UTC(2026, 8, 25, 11, 0, sent)).toISOString(),
    });
    return stored.kind === 'stored';
  };
  for (const body of messages) assert.equal(send(body), true);
  const ledgerDir = path.join(root, 'ledger');
  fs.mkdirSync(ledgerDir, { mode: 0o700 });
  const ledger = openHistoryTransferLedger(ledgerDir);
  const provider = new FakeHostedProvider();
  const composed = composeMakeExternal({
    handle: fixture.handle, hosted: provider, sessions: provider, access: provider, bindings: provider, signIn: provider,
    destinationUrl: provider.destinationUrl,
    history: { transport: provider, ledger, limits: IMPORT_LIMITS, ceiling: { maxDrainChunks, drainDeadlineMs: 60_000 }, now: Date.now },
  });
  let id = 0;
  const server: LoopbackServer = await startChannelServer({
    store: fixture.store,
    bootstrap: [fixture.bootstrap],
    bindings: [fixture.bob],
    makeExternal: composed.journey,
    newId: () => `evt-${Date.now()}-${++id}`,
    clock: Date.now,
    startPort: 0,
    assets: webBundleManifest(bundle),
  });
  const context = await browser!.newContext();
  const page = await context.newPage();
  const violations: string[] = [];
  page.on('console', entry => {
    if (/Content Security Policy|Refused to/i.test(entry.text())) violations.push(entry.text());
  });
  await page.goto(`${server.origin}/__khala/bootstrap#credential=${fixture.bootstrap.credential}&channel=${channelId}`);
  await page.waitForURL(`${server.origin}/channels/${channelId}`);
  return {
    page, origin: server.origin, fixture, provider, composed, violations, send,
    async close() {
      await context.close();
      await server.close();
      ledger.close();
      fixture.dispose();
    },
  };
}

const heading = (page: Page) => page.locator('#make-external-heading');
const status = (page: Page) => page.locator('.make-external__status');

async function focusedText(page: Page): Promise<string> {
  return page.evaluate(() => document.activeElement?.textContent ?? '');
}

/** Waits for a step heading and proves it took focus. */
async function arrive(page: Page, name: string): Promise<void> {
  await heading(page).getByText(name, { exact: true }).waitFor({ timeout: 20_000 });
  await page.waitForFunction(text => document.activeElement?.id === 'make-external-heading' && document.activeElement.textContent === text, name);
}

/** Tabs forward until the named control has focus, then presses `key` on it. */
async function press(page: Page, name: string, key = 'Enter'): Promise<void> {
  // One action at a time: the page ignores a press while the previous action is in flight.
  await page.waitForFunction(() => document.querySelector('.make-external')?.getAttribute('aria-busy') !== 'true');
  for (let tab = 0; tab < 60; tab += 1) {
    const label = await page.evaluate(() => {
      const active = document.activeElement as HTMLElement | null;
      return active ? (active.getAttribute('aria-label') ?? active.innerText ?? '').trim() : '';
    });
    if (label === name) {
      await page.keyboard.press(key);
      return;
    }
    await page.keyboard.press('Tab');
  }
  throw new Error(`no focusable control named ${name}`);
}

async function openJourney(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Make external' }).waitFor();
  await page.getByRole('button', { name: 'Make external' }).focus();
  await page.keyboard.press('Enter');
  await arrive(page, 'Make this channel external');
}

async function signIn(run: Launched): Promise<void> {
  run.provider.signInOutcome = 'pending';
  await press(run.page, 'Sign in to continue');
  await arrive(run.page, 'Finish signing in');
  const link = run.page.getByRole('link', { name: 'Open the hosted sign-in page' });
  assert.equal(await link.getAttribute('href'), 'https://khala.test/sign-in/1');
  assert.equal(await link.getAttribute('rel'), 'noopener noreferrer');
  run.provider.signInOutcome = 'signed_in';
  await arrive(run.page, 'Confirm the external channel');
  await status(run.page).getByText('Signed in. Choose history, visibility and agents.').waitFor();
}

test('carry history end to end: keyboard only, lost responses, reload, commit and a stale channel reference', { timeout: 180_000 }, async () => {
  const hostile = '<script>window.__pwned = 1</script> <img src="https://evil.example/x.png"> [approve](https://evil.example)';
  const run = await launch(['first message', hostile, 'third message']);
  try {
    const { page, provider } = run;
    await openJourney(page);
    await status(page).getByText('Make external. Nothing changes until you confirm.').waitFor();
    await signIn(run);

    // Confirming without a history choice is refused in place, with focus on the choice.
    await press(page, 'Create the external channel');
    await page.getByText('Choose what happens to this channel’s messages.').waitFor();
    assert.equal(await page.evaluate(() => (document.activeElement as HTMLInputElement | null)?.value), 'carry_history');
    assert.equal(await page.locator('input[name="visibility"][value="secret"]').isChecked(), true, 'secret is the default');
    await page.keyboard.press('Space');
    assert.equal(await page.locator('input[name="history"][value="carry_history"]').isChecked(), true);

    // The hosted service loses the create response and the first acknowledgement of every part.
    provider.loseCreateResponses = 1;
    const lost = new Set<string>();
    provider.loseAck = txn => !lost.has(txn) && Boolean(lost.add(txn));
    await press(page, 'Create the external channel');
    await arrive(page, 'Bring your agents');
    await page.getByText('History is copied. The internal channel is paused until you switch or cancel.').waitFor();

    // A reload lands on the same journaled step.
    await page.reload();
    await arrive(page, 'Bring your agents');
    assert.equal(provider.creates.length, 1, 'one external channel despite the lost create response');

    await press(page, 'Grant access to 2 agents');
    await page.getByText('Ready, paused until you switch').first().waitFor({ timeout: 20_000 });
    await page.waitForFunction(() => document.querySelectorAll('.make-external__agent-status').length === 2
      && [...document.querySelectorAll('.make-external__agent-status')].every(node => node.textContent === 'Ready, paused until you switch'));
    assert.equal(provider.canExchange('participant-bob'), false, 'a ready binding stays paused until the switch');
    await press(page, 'Switch to the external channel');
    await arrive(page, 'This channel is now external');
    await status(page).getByText(/Done\. The external channel is now authoritative/).waitFor();
    assert.equal(await page.getByRole('link', { name: 'Open the external channel' }).getAttribute('href'), 'https://khala.test/channels/external-1');
    assert.equal(provider.canExchange('participant-bob'), true);

    // One import, verified, in source order, and nothing reached the live timeline.
    const view = await run.composed.journey.view(owner, channelId);
    assert.equal(view.kind, 'ok');
    const conversion = view.kind === 'ok' ? view.value.conversion! : null;
    const archive = await openImportedArchive(provider, {
      roomId: conversion!.destinationChannelId as RoomId, archiveId: `history.${conversion!.conversionId}`,
      manifestDigest: conversion!.history!.manifestDigest!, limits: IMPORT_LIMITS,
    });
    assert.deepEqual(archive.ok && archive.view.records.map(record => record.body), ['first message', hostile, 'third message']);
    assert.deepEqual(provider.live, []);

    // The old channel reference no longer leads to a writable channel.
    await press(page, 'View this read-only channel');
    await page.waitForURL(`${run.origin}/channels/${channelId}`);
    await page.getByText('This channel moved to an external channel and is read-only.').waitFor();
    await page.getByText('This channel is read-only. Its conversation continues in the external channel.').waitFor();
    assert.equal(await page.getByRole('button', { name: 'Make external' }).count(), 0);
    assert.equal(run.send('after the switch'), false, 'the internal store refuses writes after the link');
    assert.equal(await page.evaluate(() => (window as { __pwned?: number }).__pwned), undefined);
    assert.deepEqual(run.violations, []);
  } finally {
    await run.close();
  }
});

test('a failed sign-in and a cancel before creation change nothing', { timeout: 120_000 }, async () => {
  const run = await launch(['hello']);
  try {
    const { page, provider } = run;
    await openJourney(page);
    provider.signInOutcome = 'denied';
    await press(page, 'Sign in to continue');
    await arrive(page, 'Sign-in did not finish');
    await page.getByText('The sign-in was refused. Nothing changed and this channel is still active.').waitFor();
    await status(page).getByText('Sign-in did not finish. The internal channel is unchanged.').waitFor();

    provider.signInOutcome = 'signed_in';
    await press(page, 'Try signing in again');
    await arrive(page, 'Confirm the external channel');
    await press(page, 'Cancel');
    await page.waitForURL(`${run.origin}/channels/${channelId}`);
    await page.getByRole('button', { name: 'Make external' }).waitFor();
    assert.equal(provider.creates.length, 0);
    assert.equal(run.send('still active'), true);
  } finally {
    await run.close();
  }
});

test('start fresh with a chosen visibility, a blocked agent, retry, skip and a cancel after creation', { timeout: 120_000 }, async () => {
  const run = await launch(['not copied']);
  try {
    const { page, provider } = run;
    provider.blocked.set('participant-carol', 'revoked');
    await openJourney(page);
    await signIn(run);
    await page.locator('input[name="history"][value="start_fresh"]').check();
    await page.locator('input[name="visibility"][value="public"]').check();
    await press(page, 'Create the external channel');
    await arrive(page, 'Bring your agents');
    assert.equal(provider.creates[0]?.visibility, 'public');

    await press(page, 'Grant access to 2 agents');
    await page.getByText('Blocked: its access was revoked').waitFor({ timeout: 20_000 });
    const commit = page.getByRole('button', { name: 'Switch to the external channel' });
    assert.equal(await commit.getAttribute('aria-disabled'), 'true');
    assert.match(await page.locator(`#${await commit.getAttribute('aria-describedby')}`).innerText(), /every agent is ready or skipped/);
    // Still focusable and named, but pressing it does nothing.
    await commit.focus();
    await page.keyboard.press('Enter');
    await heading(page).getByText('Bring your agents').waitFor();
    assert.equal(run.send('not switched'), true);

    // Retrying re-verifies the same session and stays blocked while access is still revoked.
    await press(page, 'Retry Carol');
    await page.getByText('Blocked: its access was revoked').waitFor({ timeout: 20_000 });
    await press(page, 'Skip Carol');
    await page.getByText('Skipped, stays out of the external channel').waitFor();
    await page.waitForFunction(() => document.querySelector('button[aria-disabled]')?.textContent === 'Switch to the external channel'
      && document.querySelector('button[aria-disabled]')?.getAttribute('aria-disabled') === 'false');

    await press(page, 'Cancel conversion');
    await arrive(page, 'Conversion cancelled');
    await page.getByText('external-1', { exact: true }).waitFor();
    await page.getByText(/It is not deleted automatically/).waitFor();
    assert.equal(run.send('active again'), true);
    assert.equal(provider.parts.size, 0, 'start fresh copies nothing');
  } finally {
    await run.close();
  }
});

test('non-convergent history asks for a paused drain, and a failure after the link recovers forward', { timeout: 150_000 }, async () => {
  const run = await launch(Array.from({ length: 6 }, (_, index) => `seed ${index}`));
  try {
    const { page, provider } = run;
    let written = 0;
    provider.beforePut = () => {
      for (let index = 0; index < 9; index += 1) run.send(`live ${++written}`);
    };
    provider.releaseFails.add('participant-bob');
    await openJourney(page);
    await signIn(run);
    await page.locator('input[name="history"][value="carry_history"]').check();
    await press(page, 'Create the external channel');
    await arrive(page, 'History is still changing');
    await status(page).getByText(/History is still changing\. Choose whether to pause/).waitFor();
    assert.equal(run.send('still writable before the drain'), true);

    provider.beforePut = () => {};
    await press(page, 'Pause this channel and finish copying');
    await arrive(page, 'Bring your agents');
    assert.equal(run.send('paused'), false);

    await press(page, 'Grant access to 2 agents');
    await page.waitForFunction(() => [...document.querySelectorAll('.make-external__agent-status')]
      .every(node => node.textContent === 'Ready, paused until you switch'), undefined, { timeout: 20_000 });
    await press(page, 'Switch to the external channel');
    await arrive(page, 'Finishing activation');
    assert.equal(await page.getByRole('button', { name: /Cancel/ }).count(), 0, 'no way back after the link');
    assert.equal(run.send('reopened?'), false);

    provider.releaseFails.clear();
    await press(page, 'Retry activation');
    await arrive(page, 'This channel is now external');
    assert.match(await focusedText(page), /This channel is now external/);
    assert.deepEqual(provider.live, []);
  } finally {
    await run.close();
  }
});
