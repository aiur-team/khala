import { expect, type Browser, type Page } from '@playwright/test';
import { signIn, syntheticCanary, type LiveHumanEnvironment } from '../human/fixtures';
import { connectorWitness, controlsStatus, mailboxOutcome } from '../controls/fixtures';
import { nativeReviewBaseline, nativeSelectedOnlyProof, type NativeReviewConfig } from './native-witness';

export type ReviewControls = Readonly<{
  roomId: string; bindingId: string; agentParticipantId: string;
  connectorControl: Readonly<{ executable: string; args: readonly string[];
    processExecutable: string; processCwd: string; processCgroup: string }>;
}>;

export async function signedIn(browser: Browser, human: LiveHumanEnvironment, index: 0 | 1) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${human.appOrigin}/new`, { waitUntil: 'networkidle' });
  await signIn(page, human, human.users[index]);
  return { context, page };
}

export async function prepareRoute(owner: Page, controls: ReviewControls, native: NativeReviewConfig) {
  const connector = await connectorWitness(controls, 'status');
  await owner.goto(`${new URL(owner.url()).origin}/channels/${encodeURIComponent(controls.roomId)}`);
  const status = await controlsStatus(owner, controls.bindingId);
  expect(status.binding).toMatchObject({ bindingId: controls.bindingId,
    generation: connector.generation, sessionId: connector.sessionId,
    agentParticipantId: controls.agentParticipantId });
  expect(status.bindingStatus).toBe('active');
  expect(status.policy).toMatchObject({ effectiveMode: 'review', paused: false });
  const baseline = await nativeReviewBaseline(native, connector.sessionId);
  return { connector, baseline, controls, native };
}

export type PreparedRoute = Awaited<ReturnType<typeof prepareRoute>>;

async function send(page: Page, value: string): Promise<void> {
  await page.getByLabel('Message').fill(value);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Messages' }).getByText(value, { exact: true })).toBeVisible();
}

export async function releaseOnlyB(owner: Page, sender: Page, route: PreparedRoute) {
  const { controls, connector, native, baseline } = route;
  const withheld = syntheticCanary('withheldA');
  const released = syntheticCanary('approvedB');
  await send(sender, withheld);
  await send(sender, released);
  const recipient = owner.locator('section.review').filter({ hasText: `To: ${controls.agentParticipantId}` });
  const list = recipient.getByRole('list', { name: 'Pending messages' });
  const rowA = list.locator('li.review-item').filter({ hasText: withheld });
  const rowB = list.locator('li.review-item').filter({ hasText: released });
  await expect(rowA).toHaveCount(1);
  await expect(rowB).toHaveCount(1);
  const eventA = await rowA.getAttribute('data-event-id');
  const eventB = await rowB.getAttribute('data-event-id');
  expect(eventA).toBeTruthy();
  expect(eventB).toBeTruthy();
  expect(eventA).not.toBe(eventB);

  // This listener observes the real browser command; it cannot authorize it.
  const captured: { approval: { operationId: string; body: { commandId: string;
    selection: Array<{ eventId: string }> } } | null } = { approval: null };
  owner.on('request', request => {
    if (new URL(request.url()).pathname !== '/api/human/owner-mailbox/submit') return;
    const value = request.postDataJSON() as { kind?: string; operationId?: string; body?: unknown };
    if (value.kind === 'review_approve' && typeof value.operationId === 'string'
      && typeof value.body === 'object' && value.body !== null) {
      captured.approval = value as typeof captured.approval;
    }
  });
  await rowB.locator('input[type="checkbox"]').check();
  await expect(recipient.getByRole('button', { name: 'Release 1 selected' })).toBeEnabled();
  await recipient.getByRole('button', { name: 'Release 1 selected' }).click();
  await expect.poll(() => captured.approval !== null).toBe(true);
  const approval = captured.approval!;
  expect(approval.operationId).toBe(approval.body.commandId);
  expect(approval.body.selection.map(ref => ref.eventId)).toEqual([eventB]);
  const result = await mailboxOutcome(owner, controls.bindingId, approval.operationId) as {
    ok?: boolean; releaseIds?: unknown;
  };
  expect(result.ok).toBe(true);
  expect(Array.isArray(result.releaseIds)).toBe(true);
  expect(result.releaseIds).toHaveLength(1);
  const releaseId = (result.releaseIds as string[])[0]!;
  await expect(recipient.getByText('Released', { exact: true })).toBeVisible();
  await expect(rowA).toHaveCount(1);

  const proof = { withheld, released, withheldEventId: eventA!, releasedEventId: eventB!,
    bindingId: controls.bindingId, generation: connector.generation, releaseId };
  await expect.poll(async () => {
    try { await nativeSelectedOnlyProof(native, baseline, proof); return true; }
    catch { return false; }
  }, { timeout: 45_000, intervals: [250, 500, 1_000] }).toBe(true);
  await owner.waitForTimeout(1_500);
  await nativeSelectedOnlyProof(native, baseline, proof);
  const stillBound = await connectorWitness(controls, 'status');
  expect(stillBound).toMatchObject({ bindingId: connector.bindingId,
    generation: connector.generation, sessionId: connector.sessionId });
  return proof;
}

/** The same real inbox and rollout must also exclude a neighboring owner's event. */
export async function assertForeignWithheld(route: PreparedRoute,
  own: Awaited<ReturnType<typeof releaseOnlyB>>, foreign: { canary: string; eventId: string }) {
  await nativeSelectedOnlyProof(route.native, route.baseline, {
    ...own, withheld: foreign.canary, withheldEventId: foreign.eventId,
  });
}
