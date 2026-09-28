import { expect, test, type Browser, type Page } from '@playwright/test';
import { signIn } from '../human/fixtures';
import { connectorWitness, controlsStatus, mailbox, mailboxOutcome, readLiveControlsEnvironment,
  sameProcessRunning } from './fixtures';

const environment = readLiveControlsEnvironment();
const { human, controls } = environment;

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
  test.setTimeout(180_000);
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
    expect(afterLost.policy.effectiveVersion).toBe(raced.policy.effectiveVersion! + 1);

    const beforeRestart = await controlsStatus(owner.page, controls.bindingId);
    const restarted = await connectorWitness(controls, 'restart');
    expect(sameProcessRunning(firstProcess)).toBe(false);
    expect(restarted.pid).not.toBe(firstProcess.pid);
    expect(restarted.startTicks).not.toBe(firstProcess.startTicks);
    expect(restarted).toMatchObject({ bindingId: firstProcess.bindingId,
      generation: firstProcess.generation, sessionId: firstProcess.sessionId });
    const afterRestart = await controlsStatus(owner.page, controls.bindingId);
    expect(afterRestart.policy).toEqual(beforeRestart.policy);

    // Resume is still a review-mode policy change, not an automatic release.
    await setPolicy(owner.page, false);
    await expect(ownerPanel.locator('.agent-controls__effective')).toContainText('Review');
    await expect(ownerPanel.getByRole('button', { name: 'Request pause' })).toBeEnabled();
  } finally {
    await Promise.all([owner.context.close(), other.context.close()]);
  }
});
