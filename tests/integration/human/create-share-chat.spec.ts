import { expect, test, type Page, type Response as PlaywrightResponse } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { freshPage, rawRoomMessages, readLiveHumanEnvironment, signIn, syntheticCanary, verifyMatrixObserver } from './fixtures';

const environment = readLiveHumanEnvironment();
type BrowserStage = 'alice-create' | 'alice-send' | 'alice-share' | 'bob-join' | 'bob-send'
  | 'matrix-ciphertext' | 'alice-history' | 'bob-history' | 'outsider-create' | 'outsider-denial';

function recordStage(stage: BrowserStage, details: Record<string, unknown> = {}): void {
  const file = process.env.KHALA_E2E_STAGE_DIAGNOSTIC;
  if (file) writeFileSync(file, JSON.stringify({ stage, ...details }), { mode: 0o600 });
}

function enableHistoryDiagnostics() {
  const target = window as Window & { __khalaLocalHistoryDiagnostics?: boolean; __khalaHistoryStages?: string[] };
  target.__khalaLocalHistoryDiagnostics = true;
  target.__khalaHistoryStages = [];
  window.addEventListener('khala:local-history-diagnostic', event => {
    const stage = (event as CustomEvent<unknown>).detail;
    if (stage === 'history_participants' || stage === 'history_device_info') target.__khalaHistoryStages!.push(stage);
  });
}

async function requireAutomaticHistoryAfterReload(page: Page, expectedMessage: string, stage: 'alice-history' | 'bob-history'): Promise<void> {
  recordStage(stage);
  const participantStatuses: number[] = [];
  const onResponse = (response: PlaywrightResponse) => {
    if (new URL(response.url()).pathname === '/api/human/messaging/participants') participantStatuses.push(response.status());
  };
  page.on('response', onResponse);
  try {
    await page.reload({ waitUntil: 'domcontentloaded' });
    const row = page.getByRole('list', { name: 'Messages' }).getByText(expectedMessage);
    try {
      await expect(row).toBeVisible({ timeout: 30_000 });
    } catch {
      const view = await page.evaluate(() => {
        const target = window as Window & { __khalaHistoryStages?: string[] };
        const timeline = document.querySelector('.timeline');
        const historyAlert = [...(timeline?.querySelectorAll('[role="alert"]') ?? [])]
          .some(node => node.textContent?.includes('Conversation history is unavailable right now.'));
        const loading = [...(timeline?.querySelectorAll('[role="status"]') ?? [])]
          .some(node => node.textContent?.includes('Loading conversation…'));
        const phase = historyAlert ? 'unavailable' : loading ? 'loading'
          : timeline?.querySelector('.timeline__empty') ? 'ready_empty'
            : timeline?.querySelector('.timeline__row') ? 'ready_or_partial' : 'absent';
        return { phase, historyAlert,
          unavailableRows: timeline?.querySelectorAll('.timeline__row.message-content__unavailable').length ?? 0,
          stages: (target.__khalaHistoryStages ?? []).filter(stage =>
            stage === 'history_participants' || stage === 'history_device_info').slice(-8) };
      });
      const deviceReadySurface = await page.getByLabel('Message', { exact: true }).isEnabled().catch(() => false);
      recordStage(stage, { ...view, deviceReadySurface, participantStatuses: participantStatuses.slice(-12) });
      throw new Error('automatic_history_failed');
    }
  } finally {
    page.off('response', onResponse);
  }
}

test('two OAuth humans create, share, join, and exchange encrypted attributed messages', async ({ browser }) => {
  test.setTimeout(180_000);
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  await Promise.all([aliceContext.addInitScript(enableHistoryDiagnostics), bobContext.addInitScript(enableHistoryDiagnostics)]);
  try {
    recordStage('alice-create');
    const alice = await freshPage(aliceContext, environment);
    // The control runtime issues the creator's Matrix session to this browser.
    // Capture it only in test memory; a room outsider cannot read joined history.
    const creatorSessionResponse = alice.waitForResponse(response =>
      new URL(response.url()).pathname === '/api/human/messaging/session' && response.status() === 200,
    );
    await signIn(alice, environment, environment.users[0]);
    const creatorSession = await (await creatorSessionResponse).json() as { session?: { accessToken?: unknown } };
    const creatorAccessToken = creatorSession.session?.accessToken;
    expect(typeof creatorAccessToken).toBe('string');

    const intro = syntheticCanary('intro');
    await alice.getByRole('button', { name: 'Create channel' }).last().click();
    await alice.getByLabel('Channel name (optional)').fill(`Live ${environment.environmentId}`);
    await alice.getByRole('button', { name: 'Create channel' }).last().click();
    await expect(alice).toHaveURL(/\/channels\//u);
    recordStage('alice-send');
    await alice.getByLabel('Message', { exact: true }).fill(intro);
    await alice.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(alice.locator('.timeline__row:not(.timeline__row--pending)', { hasText: intro })).toBeVisible({ timeout: 30_000 });
    recordStage('alice-share');
    await aliceContext.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: environment.appOrigin });
    await alice.getByRole('button', { name: 'Copy my channel link' }).click();
    await expect(alice.getByText('Copied', { exact: true })).toBeVisible();
    const shareUrl = await alice.evaluate(() => navigator.clipboard.readText());
    expect(shareUrl).toMatch(/\/join\/[^/?#]+$/u);

    recordStage('bob-join');
    const bob = await bobContext.newPage();
    await bob.goto(shareUrl, { waitUntil: 'networkidle' });
    await signIn(bob, environment, environment.users[1]);
    await expect(bob.getByText("You're in.")).toBeVisible();
    const roomText = await bob.locator('.join-joined__room-id').innerText();
    const roomId = roomText.replace(/^Channel:\s*/u, '');
    expect(roomId).not.toBe('');

    // The disposable observer has not been admitted. A 403 proves private
    // history is inaccessible; it is not a source of ciphertext evidence.
    await verifyMatrixObserver(environment);
    await expect(rawRoomMessages(environment, roomId, environment.observer.accessToken))
      .rejects.toThrow('Matrix event request failed with 403');

    await bob.getByRole('button', { name: 'Open channel' }).click();
    await expect(bob).toHaveURL(`${environment.appOrigin}/channels/${encodeURIComponent(roomId)}`);
    // The current product default is link admission with no earlier history.
    await expect(bob.getByRole('list', { name: 'Messages' }).getByText('No messages yet.')).toBeVisible();
    await expect(bob.getByRole('list', { name: 'Messages' }).getByText(intro)).toHaveCount(0);
    recordStage('bob-send');
    const reply = syntheticCanary('reply');
    await bob.getByLabel('Message', { exact: true }).fill(reply);
    await bob.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(bob.locator('.timeline__row:not(.timeline__row--pending)', { hasText: reply })).toBeVisible({ timeout: 30_000 });
    await expect(bob.locator('.timeline__row', { hasText: reply }).locator('.conversation-message__kind')).toHaveText('You');

    recordStage('matrix-ciphertext');
    const rawEvents = await rawRoomMessages(environment, roomId, creatorAccessToken as string);
    expect(rawEvents.filter(event => event.type === 'm.room.encrypted').length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(rawEvents)).not.toContain(intro);
    expect(JSON.stringify(rawEvents)).not.toContain(reply);

    await expect(alice).toHaveURL(`${environment.appOrigin}/channels/${encodeURIComponent(roomId)}`);
    await requireAutomaticHistoryAfterReload(alice, reply, 'alice-history');
    await expect(alice.getByRole('list', { name: 'Messages' }).getByText(intro)).toBeVisible();
    await expect(alice.locator('.timeline__row', { hasText: reply }).locator('.conversation-message__kind')).toHaveText('Human');

    await requireAutomaticHistoryAfterReload(bob, reply, 'bob-history');
    await expect(bob.getByRole('list', { name: 'Messages' }).getByText(intro)).toHaveCount(0);
  } finally {
    await Promise.all([aliceContext.close(), bobContext.close()]);
  }
});

test('an account without admission cannot read a protected room', async ({ browser }) => {
  const ownerContext = await browser.newContext();
  const outsiderContext = await browser.newContext();
  try {
    recordStage('outsider-create');
    const owner = await freshPage(ownerContext, environment);
    await signIn(owner, environment, environment.users[0]);
    await owner.getByRole('button', { name: 'Create channel' }).last().click();
    const canary = syntheticCanary('protected');
    await owner.getByRole('button', { name: 'Create channel' }).last().click();
    await expect(owner).toHaveURL(/\/channels\//u);
    const roomId = decodeURIComponent(new URL(owner.url()).pathname.slice('/channels/'.length));
    expect(roomId).not.toBe('');
    await owner.getByLabel('Message', { exact: true }).fill(canary);
    await owner.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(owner.locator('.timeline__row:not(.timeline__row--pending)', { hasText: canary })).toBeVisible({ timeout: 30_000 });

    const outsider = await freshPage(outsiderContext, environment);
    recordStage('outsider-denial');
    const outsiderSessionResponse = outsider.waitForResponse(response =>
      new URL(response.url()).pathname === '/api/human/messaging/session' && response.status() === 200,
    );
    await signIn(outsider, environment, environment.users[1]);
    const outsiderSession = await (await outsiderSessionResponse).json() as { session?: { accessToken?: unknown } };
    expect(typeof outsiderSession.session?.accessToken).toBe('string');
    await expect(rawRoomMessages(environment, roomId, outsiderSession.session!.accessToken as string))
      .rejects.toThrow('Matrix event request failed with 403');
    await outsider.goto(`${environment.appOrigin}/channels/${encodeURIComponent(roomId)}`);
    await expect(outsider.getByRole('list', { name: 'Messages' }).getByText(canary)).toHaveCount(0);
    await expect(outsider.getByRole('alert')).toBeVisible();
  } finally {
    await Promise.all([ownerContext.close(), outsiderContext.close()]);
  }
});
