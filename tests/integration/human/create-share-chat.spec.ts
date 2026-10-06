import { expect, test, type Page, type Response as PlaywrightResponse } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { freshPage, rawRoomMessages, readLiveHumanEnvironment, signIn, syntheticCanary, verifyMatrixObserver } from './fixtures';

const environment = readLiveHumanEnvironment();
type BrowserStage = 'alice-create' | 'alice-send' | 'alice-share' | 'bob-join' | 'bob-send'
  | 'matrix-ciphertext' | 'alice-history' | 'bob-history' | 'outsider-create' | 'outsider-signin'
  | 'outsider-room' | 'outsider-send' | 'outsider-denial';

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
  const participantRouteStages: string[] = [];
  const participantContentTypes: string[] = [];
  const participantMatrixStages: string[] = [];
  const participantMatrixStatuses: number[] = [];
  const onResponse = (response: PlaywrightResponse) => {
    if (new URL(response.url()).pathname !== '/api/human/messaging/participants') return;
    participantStatuses.push(response.status());
    const contentType = response.headers()['content-type']?.split(';', 1)[0];
    if (contentType === 'application/json' || contentType === 'text/html' || contentType === 'text/plain') {
      participantContentTypes.push(contentType);
    }
    const routeStage = response.headers()['x-khala-local-participant-stage'];
    if (routeStage && ['service_loader', 'feature_unavailable', 'authorization', 'participant_unavailable'].includes(routeStage)) {
      participantRouteStages.push(routeStage);
    }
    const matrixStage = response.headers()['x-khala-local-matrix-stage'];
    const matrixStatus = Number(response.headers()['x-khala-local-matrix-status']);
    if (matrixStage && ['membership', 'control_login', 'joined_members'].includes(matrixStage)
      && Number.isInteger(matrixStatus) && matrixStatus >= 0 && matrixStatus <= 599) {
      participantMatrixStages.push(matrixStage);
      participantMatrixStatuses.push(matrixStatus);
    }
  };
  page.on('response', onResponse);
  try {
    const reloadResponse = await page.reload({ waitUntil: 'domcontentloaded' });
    const row = page.getByRole('list', { name: 'Messages' }).getByText(expectedMessage);
    try {
      await expect(row).toBeVisible({ timeout: 30_000 });
    } catch {
      const view = await page.evaluate(() => {
        const target = window as Window & { __khalaHistoryStages?: string[] };
        const timeline = document.querySelector('.timeline');
        const historyAlert = [...(timeline?.querySelectorAll('[role="alert"]') ?? [])]
          .some(node => node.textContent?.includes('Conversation history is unavailable right now.'));
        const loading = Boolean(timeline?.querySelector('.kh-loading'));
        const phase = historyAlert ? 'unavailable' : loading ? 'loading'
          : timeline?.querySelector('.kh-empty') ? 'ready_empty'
            : timeline?.querySelector('.timeline__row') ? 'ready_or_partial' : 'absent';
        return { phase, historyAlert, appRendered: Boolean(document.querySelector('#app')?.firstElementChild),
          unavailableRows: timeline?.querySelectorAll('.message-content__unavailable').length ?? 0,
          stages: (target.__khalaHistoryStages ?? []).filter(stage =>
            stage === 'history_participants' || stage === 'history_device_info').slice(-8) };
      });
      const deviceReadySurface = await page.getByLabel('Message', { exact: true }).isEnabled().catch(() => false);
      const pathname = new URL(page.url()).pathname;
      const pageRoute = pathname.startsWith('/channels/') ? 'channel'
        : pathname === '/' ? 'home' : pathname.startsWith('/auth/') ? 'auth' : 'other';
      recordStage(stage, { ...view, deviceReadySurface, reloadStatus: reloadResponse?.status() ?? 0, pageRoute,
        participantStatuses: participantStatuses.slice(-12),
        participantRouteStages: participantRouteStages.slice(-12), participantContentTypes: participantContentTypes.slice(-12),
        participantMatrixStages: participantMatrixStages.slice(-12), participantMatrixStatuses: participantMatrixStatuses.slice(-12) });
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
    const creatorSession = await (await creatorSessionResponse).json() as { session?: { accessToken?: unknown; userId?: unknown } };
    const creatorAccessToken = creatorSession.session?.accessToken;
    expect(typeof creatorAccessToken).toBe('string');

    const intro = syntheticCanary('intro');
    await alice.getByRole('button', { name: 'New channel', exact: true }).click();
    await alice.getByRole('textbox', { name: 'Channel name', exact: true }).fill(`Live ${environment.environmentId}`);
    await alice.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(alice).toHaveURL(/\/channels\//u);
    const roomId = decodeURIComponent(new URL(alice.url()).pathname.slice('/channels/'.length));
    expect(roomId).not.toBe('');
    recordStage('alice-send');
    await alice.getByLabel('Message', { exact: true }).fill(intro);
    await alice.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(alice.locator('.timeline__row:not(.timeline__row--pending)', { hasText: intro })).toBeVisible({ timeout: 30_000 });
    recordStage('alice-share');
    await aliceContext.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: environment.appOrigin });
    await alice.getByRole('button', { name: 'Invite', exact: true }).click();
    await alice.getByRole('button', { name: 'Copy link', exact: true }).click();
    await expect(alice.getByText('Copied', { exact: true })).toBeVisible();
    const shareUrl = await alice.evaluate(() => navigator.clipboard.readText());
    expect(shareUrl).toMatch(/\/join\/[^/?#]+$/u);
    if (process.env.KHALA_E2E_SHARE_LINK_FILE) {
      writeFileSync(process.env.KHALA_E2E_SHARE_LINK_FILE, shareUrl, { mode: 0o600 });
    }

    recordStage('bob-join');
    const bob = await bobContext.newPage();
    await bob.goto(shareUrl, { waitUntil: 'networkidle' });
    await signIn(bob, environment, environment.users[1]);
    await expect(bob.getByText("You're in.")).toBeVisible();

    // The disposable observer has not been admitted. A 403 proves private
    // history is inaccessible; it is not a source of ciphertext evidence.
    await verifyMatrixObserver(environment);
    await expect(rawRoomMessages(environment, roomId, environment.observer.accessToken))
      .rejects.toThrow('Matrix event request failed with 403');

    await bob.getByRole('button', { name: 'Open channel' }).click();
    await expect(bob).toHaveURL(`${environment.appOrigin}/channels/${encodeURIComponent(roomId)}`);
    // M1 (R4, AE7): a link joiner reads from their join onward; earlier messages are hidden, not shown as broken.
    await expect(bob.getByRole('list', { name: 'Messages' }).getByText('No messages yet', { exact: true })).toBeVisible();
    await expect(bob.getByRole('list', { name: 'Messages' }).getByText(intro)).toHaveCount(0);
    await expect(bob.locator('.message-content__unavailable')).toHaveCount(0);
    recordStage('bob-send');
    const reply = syntheticCanary('reply');
    await bob.getByLabel('Message', { exact: true }).fill(reply);
    await bob.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(bob.locator('.timeline__row:not(.timeline__row--pending)', { hasText: reply })).toBeVisible({ timeout: 30_000 });
    await expect(bob.locator('.timeline__row', { hasText: reply })).toHaveClass(/\bme\b/u);

    recordStage('matrix-ciphertext');
    const rawEvents = await rawRoomMessages(environment, roomId, creatorAccessToken as string);
    expect(rawEvents.filter(event => event.type === 'm.room.encrypted').length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(rawEvents)).not.toContain(intro);
    expect(JSON.stringify(rawEvents)).not.toContain(reply);
    const visibility = await fetch(`${environment.homeserverOrigin}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.history_visibility/`, {
      headers: { authorization: `Bearer ${creatorAccessToken}` },
    });
    expect(visibility.status).toBe(200);
    expect(await visibility.json()).toEqual({ history_visibility: 'shared' });
    const aliceUserId = creatorSession.session?.userId;
    expect(typeof aliceUserId).toBe('string');
    const keys = await fetch(`${environment.homeserverOrigin}/_matrix/client/v3/keys/query`, {
      method: 'POST', headers: { authorization: `Bearer ${creatorAccessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ device_keys: { [aliceUserId as string]: [] } }),
    });
    expect(keys.status).toBe(200);
    expect((await keys.json() as { master_keys?: Record<string, unknown> }).master_keys?.[aliceUserId as string]).toBeDefined();

    await expect(alice).toHaveURL(`${environment.appOrigin}/channels/${encodeURIComponent(roomId)}`);
    await requireAutomaticHistoryAfterReload(alice, reply, 'alice-history');
    await expect(alice.getByRole('list', { name: 'Messages' }).getByText(intro)).toBeVisible();
    const receivedReply = alice.locator('.timeline__row', { hasText: reply });
    await expect(receivedReply).toHaveClass(/\bhuman\b/u);
    await expect(receivedReply.getByRole('img', { name: 'Human', exact: true })).toBeVisible();

    await requireAutomaticHistoryAfterReload(bob, reply, 'bob-history');
    await expect(bob.getByRole('list', { name: 'Messages' }).getByText(intro)).toHaveCount(0);
    await expect(bob.locator('.message-content__unavailable')).toHaveCount(0);
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
    recordStage('outsider-signin');
    await signIn(owner, environment, environment.users[0]);
    recordStage('outsider-room');
    await owner.getByRole('button', { name: 'New channel', exact: true }).click();
    const canary = syntheticCanary('protected');
    await owner.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(owner).toHaveURL(/\/channels\//u);
    const roomId = decodeURIComponent(new URL(owner.url()).pathname.slice('/channels/'.length));
    expect(roomId).not.toBe('');
    recordStage('outsider-send');
    await owner.getByLabel('Message', { exact: true }).fill(canary);
    await owner.getByRole('button', { name: 'Send', exact: true }).click();
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
    // An inaccessible channel returns to the list rather than mounting a timeline.
    await expect(outsider).toHaveURL(`${environment.appOrigin}/conversations`);
    await expect(outsider.getByRole('region', { name: 'No channel selected', exact: true })).toBeVisible();
    await expect(outsider.getByRole('list', { name: 'Messages' })).toHaveCount(0);
    await expect(outsider.getByText(canary, { exact: true })).toHaveCount(0);
  } finally {
    await Promise.all([ownerContext.close(), outsiderContext.close()]);
  }
});
