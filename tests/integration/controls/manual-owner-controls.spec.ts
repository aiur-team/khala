import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { signIn, syntheticCanary } from '../human/fixtures';
import { nativeReviewBaseline, nativeSelectedOnlyProof, readReviewNativeConfig } from '../review/native-witness';
import { connectorWitness, controlsStatus, mailbox, mailboxOutcome, readLiveControlsEnvironment,
  sameProcessRunning } from './fixtures';

const environment = readLiveControlsEnvironment();
const { human, controls } = environment;
// A missing private native witness is a failed live run, never a skipped assertion.
const native = readReviewNativeConfig();

async function send(page: Page, body: string) {
  await page.getByLabel('Message').fill(body);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText(body, { exact: true })).toBeVisible();
}

function pendingRow(page: Page, body: string) {
  const review = page.locator('section.review').filter({ hasText: `To: ${controls.agentParticipantId}` });
  return review.getByRole('list', { name: 'Pending messages' })
    .locator('li.review-item').filter({ hasText: body });
}

async function approveOne(page: Page, body: string) {
  const review = page.locator('section.review').filter({ hasText: `To: ${controls.agentParticipantId}` });
  const row = pendingRow(page, body);
  await expect(row).toHaveCount(1);
  const eventId = await row.getAttribute('data-event-id');
  expect(eventId).toBeTruthy();
  const captured: { operationId: string; selection: Array<{ eventId: string }> }[] = [];
  const capture = (request: import('@playwright/test').Request) => {
    if (new URL(request.url()).pathname !== '/api/human/owner-mailbox/submit') return;
    const value = request.postDataJSON() as { kind?: string; operationId?: string;
      body?: { selection?: Array<{ eventId: string }> } };
    if (value.kind === 'review_approve' && typeof value.operationId === 'string'
      && Array.isArray(value.body?.selection)) captured.push({ operationId: value.operationId,
        selection: value.body.selection });
  };
  page.on('request', capture);
  try {
    await row.locator('input[type="checkbox"]').check();
    await review.getByRole('button', { name: 'Release 1 selected' }).click();
    await expect.poll(() => captured.length).toBe(1);
    expect(captured[0]!.selection.map(item => item.eventId)).toEqual([eventId]);
    const result = await mailboxOutcome(page, controls.bindingId, captured[0]!.operationId) as {
      ok?: boolean; releaseIds?: unknown };
    expect(result.ok).toBe(true);
    expect(result.releaseIds).toHaveLength(1);
    return { eventId: eventId!, releaseId: (result.releaseIds as string[])[0]! };
  } finally { page.off('request', capture); }
}

async function absentFromPinnedNative(baseline: Awaited<ReturnType<typeof nativeReviewBaseline>>, body: string) {
  const current = await nativeReviewBaseline(native, baseline.sessionId);
  expect(current).toMatchObject({ startTicks: baseline.startTicks,
    rolloutDevice: baseline.rolloutDevice, rolloutInode: baseline.rolloutInode });
  expect(current.offset).toBeGreaterThanOrEqual(baseline.offset);
  const raw = await readFile(native.rolloutFile, 'utf8');
  if (raw.length < current.offset) throw new Error('native_controls_rollout_changed');
  return !raw.slice(baseline.offset).includes(body);
}

async function absentFromNativeInbox(bindingId: string, generation: number, releaseId: string) {
  const directory = createHash('sha256').update(JSON.stringify([bindingId, generation])).digest('base64url');
  const filename = join(native.xdgStateHome, 'khala', 'bindings', directory, 'inbox.jsonl');
  let raw: string;
  try { raw = await readFile(filename, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
  // A partial or malformed inbox line is unknown, never evidence of absence.
  if (raw.length > 0 && !raw.endsWith('\n')) throw new Error('native_controls_inbox_incomplete');
  const records = raw.split('\n').filter(Boolean).map(line => {
    const record: unknown = JSON.parse(line);
    if (typeof record !== 'object' || record === null || Array.isArray(record)) {
      throw new Error('native_controls_inbox_invalid');
    }
    return record as { releaseId?: unknown };
  });
  return !records.some(record => record.releaseId === releaseId);
}

function command(status: Awaited<ReturnType<typeof controlsStatus>>, paused: boolean) {
  if (status.policy.effectiveVersion === null || status.policy.effectiveMode !== 'review') {
    throw new Error('live controls require an enforced review baseline');
  }
  return {
    v: 1, commandId: `policy_${crypto.randomUUID().replaceAll('-', '')}`,
    roomId: controls.roomId, bindingId: controls.bindingId,
    peerParticipantId: controls.agentParticipantId,
    expectedPolicyVersion: status.policy.effectiveVersion,
    expectedBindingGeneration: status.binding.generation,
    mode: 'review', paused, issuedAt: new Date().toISOString(),
  };
}

async function setPolicy(page: Page, paused: boolean) {
  const before = await controlsStatus(page, controls.bindingId);
  const body = command(before, paused);
  const submitted = await mailbox(page, controls.bindingId, 'controls_set', body, body.commandId);
  expect(submitted.status).toBe(200);
  const outcome = await mailboxOutcome(page, controls.bindingId, body.commandId) as {
    ok?: boolean; ack?: { commandId?: string; connectorState?: string; errorCode?: string | null;
      requestedVersion?: number; effectiveVersion?: number; generation?: number };
  };
  expect(outcome.ok).toBe(true);
  expect(outcome.ack).toMatchObject({ commandId: body.commandId, connectorState: 'effective',
    errorCode: null, generation: before.binding.generation });
  expect(outcome.ack?.effectiveVersion).toBe(outcome.ack?.requestedVersion);
  const after = await controlsStatus(page, controls.bindingId);
  expect(after.policy).toMatchObject({ effectiveVersion: outcome.ack?.effectiveVersion, paused,
    effectiveMode: 'review' });
  return after;
}

async function ownerPage(browser: Browser, user: typeof human.users[number]) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${human.appOrigin}/new`, { waitUntil: 'networkidle' });
  await signIn(page, human, user);
  return { context, page };
}

function panel(page: Page) {
  return page.locator('section.panel').filter({ has: page.getByRole('heading', { name: 'Agent delivery controls' }) })
    .filter({ hasText: controls.agentParticipantId });
}

test('real owner browser and connector acknowledge manual controls across races and restart', async ({ browser }) => {
  test.setTimeout(300_000);
  const owner = await ownerPage(browser, human.users[0]);
  const other = await ownerPage(browser, human.users[1]);
  const secondTab = await owner.context.newPage();
  try {
    const firstProcess = await connectorWitness(controls, 'status');
    await owner.page.goto(`${human.appOrigin}/channels/${encodeURIComponent(controls.roomId)}`);
    await secondTab.goto(`${human.appOrigin}/channels/${encodeURIComponent(controls.roomId)}`);
    const discovery = await owner.page.evaluate(async roomId => {
      const response = await fetch(`/api/human/owner-mailbox/review-bindings?room_id=${encodeURIComponent(roomId)}`,
        { credentials: 'same-origin' });
      return { status: response.status, body: await response.json() as { bindings?: Array<{ bindingId: string;
        generation: number; agentParticipantId: string }> } };
    }, controls.roomId);
    expect(discovery.status).toBe(200);
    const selected = discovery.body.bindings?.find(binding => binding.bindingId === controls.bindingId);
    expect(selected?.agentParticipantId).toBe(controls.agentParticipantId);
    expect(selected?.generation).toBe(firstProcess.generation);

    const initial = await controlsStatus(owner.page, controls.bindingId);
    expect(initial.binding).toMatchObject({ bindingId: controls.bindingId,
      generation: firstProcess.generation, agentParticipantId: controls.agentParticipantId,
      sessionId: firstProcess.sessionId });
    expect(initial.bindingStatus).toBe('active');
    if (initial.policy.paused) await setPolicy(owner.page, false);

    // The first policy change is made through the mounted production browser panel.
    const ownerPanel = panel(owner.page);
    await expect(ownerPanel.getByRole('button', { name: 'Request pause' })).toBeEnabled();
    const beforePause = await controlsStatus(owner.page, controls.bindingId);
    await ownerPanel.getByRole('button', { name: 'Request pause' }).click();
    await expect.poll(async () => (await controlsStatus(owner.page, controls.bindingId)).policy.paused).toBe(true);
    const paused = await controlsStatus(owner.page, controls.bindingId);
    expect(paused.policy.effectiveVersion).toBeGreaterThan(beforePause.policy.effectiveVersion!);
    await expect(ownerPanel.locator('.agent-controls__effective')).toContainText(`v${paused.policy.effectiveVersion}`);
    await expect(ownerPanel.getByRole('button', { name: 'Resume review delivery' })).toBeEnabled();

    // Another real OAuth owner cannot address the binding, even with its exact ID.
    const wrongOwner = await mailbox(other.page, controls.bindingId, 'controls_set',
      command(paused, false));
    expect(wrongOwner.status).toBe(403);
    expect((await controlsStatus(owner.page, controls.bindingId)).policy.effectiveVersion)
      .toBe(paused.policy.effectiveVersion);

    // Two browser tabs submit from the same observed version. Exactly one wins.
    const competing = [command(paused, false), command(paused, true)] as const;
    const submitted = await Promise.all(competing.map((body, index) => mailbox(
      index === 0 ? owner.page : secondTab, controls.bindingId, 'controls_set', body, body.commandId)));
    expect(submitted.map(answer => answer.status)).toEqual([200, 200]);
    const outcomes = await Promise.all(competing.map((body, index) => mailboxOutcome(
      index === 0 ? owner.page : secondTab, controls.bindingId, body.commandId))) as Array<{
      ok?: boolean; ack?: { connectorState?: string; errorCode?: string | null; effectiveVersion?: number } }>;
    expect(outcomes.filter(answer => answer.ack?.connectorState === 'effective')).toHaveLength(1);
    expect(outcomes.filter(answer => answer.ack?.errorCode === 'stale_policy')).toHaveLength(1);
    const raced = await controlsStatus(owner.page, controls.bindingId);
    expect(raced.policy.effectiveVersion).toBe(outcomes.find(answer => answer.ack?.connectorState === 'effective')?.ack?.effectiveVersion);

    // Drop only the browser reply after the real HTTPS submit reached the service.
    // The browser must reconcile or retry the same command without claiming a lost write failed.
    if (raced.policy.paused) await setPolicy(owner.page, false);
    const beforeLost = await controlsStatus(owner.page, controls.bindingId);
    expect(beforeLost.policy.paused).toBe(false);
    expect(beforeLost.policy.effectiveVersion).not.toBeNull();
    await expect(ownerPanel.getByRole('button', { name: 'Request pause' })).toBeEnabled();
    let lostBody: { operationId?: string; kind?: string; body?: unknown } | null = null;
    await owner.page.route('**/api/human/owner-mailbox/submit', async route => {
      const body = route.request().postDataJSON() as { kind?: string; operationId?: string; body?: unknown };
      if (body.kind !== 'controls_set' || lostBody !== null) return route.continue();
      lostBody = body;
      await route.fetch();
      await route.abort('failed');
    });
    await ownerPanel.getByRole('button', { name: 'Request pause' }).click();
    await expect.poll(() => lostBody).not.toBeNull();
    await owner.page.unrouteAll({ behavior: 'wait' });
    const lostCommandId = lostBody!.operationId!;
    const retryBodies: unknown[] = [];
    owner.page.on('request', request => {
      if (new URL(request.url()).pathname !== '/api/human/owner-mailbox/submit') return;
      const body = request.postDataJSON() as { kind?: string };
      if (body.kind === 'controls_set') retryBodies.push(body);
    });
    await expect(ownerPanel.getByRole('button', { name: 'Retry' })).toBeVisible();
    await ownerPanel.getByRole('button', { name: 'Retry' }).click();
    await expect.poll(() => retryBodies.length).toBe(1);
    expect(retryBodies[0]).toEqual(lostBody);
    const lostOutcome = await mailboxOutcome(owner.page, controls.bindingId, lostCommandId);
    expect(lostOutcome).toMatchObject({ ok: true, ack: { commandId: lostCommandId, connectorState: 'effective' } });
    await expect(ownerPanel.locator('.agent-controls__requested')).toContainText('confirmed');
    await expect.poll(async () => (await controlsStatus(owner.page, controls.bindingId)).policy.paused).toBe(true);
    const afterLost = await controlsStatus(owner.page, controls.bindingId);
    expect(afterLost.policy.effectiveVersion).toBe(beforeLost.policy.effectiveVersion! + 1);

    const beforeRestart = await controlsStatus(owner.page, controls.bindingId);
    const restarted = await connectorWitness(controls, 'restart');
    expect(sameProcessRunning(firstProcess)).toBe(false);
    expect(restarted.pid).not.toBe(firstProcess.pid);
    expect(restarted.startTicks).not.toBe(firstProcess.startTicks);
    expect(restarted).toMatchObject({ bindingId: firstProcess.bindingId,
      generation: firstProcess.generation, sessionId: firstProcess.sessionId });
    const afterRestart = await controlsStatus(owner.page, controls.bindingId);
    expect(afterRestart.policy).toEqual(beforeRestart.policy);

    // An exact approval made while paused must stay outside the native session.
    // The same native session must later consume it after effective resume.
    await other.page.goto(`${human.appOrigin}/channels/${encodeURIComponent(controls.roomId)}`);
    await expect(other.page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
    const pausedBaseline = await nativeReviewBaseline(native, restarted.sessionId);
    const pausedApproved = syntheticCanary('pausedApproved');
    const pausedPending = syntheticCanary('pausedPending');
    await send(other.page, pausedApproved);
    await send(other.page, pausedPending);
    const pendingEvent = await pendingRow(owner.page, pausedPending).getAttribute('data-event-id');
    expect(pendingEvent).toBeTruthy();
    const approved = await approveOne(owner.page, pausedApproved);
    expect((await controlsStatus(owner.page, controls.bindingId)).policy.paused).toBe(true);
    await owner.page.waitForTimeout(1_500);
    expect(await absentFromPinnedNative(pausedBaseline, pausedApproved)).toBe(true);
    expect(await absentFromPinnedNative(pausedBaseline, pausedPending)).toBe(true);
    expect(await absentFromNativeInbox(controls.bindingId, restarted.generation, approved.releaseId)).toBe(true);

    // Resume is still review mode: the prior exact approval may proceed, while
    // the unapproved neighbor remains outside the model and the durable inbox.
    await setPolicy(owner.page, false);
    await expect.poll(async () => {
      try {
        await nativeSelectedOnlyProof(native, pausedBaseline, {
          withheld: pausedPending, released: pausedApproved,
          withheldEventId: pendingEvent!, releasedEventId: approved.eventId,
          bindingId: controls.bindingId, generation: restarted.generation, releaseId: approved.releaseId,
        });
        return true;
      } catch { return false; }
    }, { timeout: 45_000, intervals: [250, 500, 1_000] }).toBe(true);

    // An event arriving after the effective review boundary remains pending
    // while a separately approved event reaches the same native session.
    const reviewBaseline = await nativeReviewBaseline(native, restarted.sessionId);
    const postReviewPending = syntheticCanary('postReviewPending');
    const postReviewApproved = syntheticCanary('postReviewApproved');
    await send(other.page, postReviewPending);
    await send(other.page, postReviewApproved);
    const postPendingEvent = await pendingRow(owner.page, postReviewPending).getAttribute('data-event-id');
    expect(postPendingEvent).toBeTruthy();
    const postApproved = await approveOne(owner.page, postReviewApproved);
    await expect.poll(async () => {
      try {
        await nativeSelectedOnlyProof(native, reviewBaseline, {
          withheld: postReviewPending, released: postReviewApproved,
          withheldEventId: postPendingEvent!, releasedEventId: postApproved.eventId,
          bindingId: controls.bindingId, generation: restarted.generation, releaseId: postApproved.releaseId,
        });
        return true;
      } catch { return false; }
    }, { timeout: 45_000, intervals: [250, 500, 1_000] }).toBe(true);
    expect(await absentFromPinnedNative(reviewBaseline, postReviewPending)).toBe(true);
    await expect(pendingRow(owner.page, postReviewPending)).toHaveCount(1);
    await expect(ownerPanel.locator('.agent-controls__effective')).toContainText('Review');
    await expect(ownerPanel.getByRole('button', { name: 'Request pause' })).toBeEnabled();
  } finally {
    await Promise.all([owner.context.close(), other.context.close()]);
  }
});
