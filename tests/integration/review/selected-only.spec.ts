import { expect, test, type Browser, type Page } from '@playwright/test';
import { signIn, syntheticCanary } from '../human/fixtures';
import { connectorWitness, controlsStatus, mailboxOutcome, readLiveControlsEnvironment } from '../controls/fixtures';
import { nativeReviewBaseline, nativeSelectedOnlyProof, readReviewNativeConfig } from './native-witness';

const { human, controls } = readLiveControlsEnvironment();
const native = readReviewNativeConfig();

async function signedIn(browser: Browser, user: typeof human.users[number]) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${human.appOrigin}/new`, { waitUntil: 'networkidle' });
  await signIn(page, human, user);
  return { context, page };
}

async function send(page: Page, text: string): Promise<void> {
  await page.getByLabel('Message').fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByText(text, { exact: true })).toBeVisible();
}

test('real owner browser releases only B into the same native Sol session while A stays pending', async ({ browser }) => {
  test.setTimeout(180_000);
  const owner = await signedIn(browser, human.users[0]);
  const sender = await signedIn(browser, human.users[1]);
  try {
    // The descriptor is a pre-paired owner/session, never a test-created binding.
    const connector = await connectorWitness(controls, 'status');
    await owner.page.goto(`${human.appOrigin}/channels/${encodeURIComponent(controls.roomId)}`);
    await sender.page.goto(`${human.appOrigin}/channels/${encodeURIComponent(controls.roomId)}`);
    await expect(sender.page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
    const status = await controlsStatus(owner.page, controls.bindingId);
    expect(status.binding).toMatchObject({ bindingId: controls.bindingId,
      generation: connector.generation, sessionId: connector.sessionId,
      agentParticipantId: controls.agentParticipantId });
    expect(status.bindingStatus).toBe('active');
    expect(status.policy).toMatchObject({ effectiveMode: 'review', paused: false });
    const baseline = await nativeReviewBaseline(native, connector.sessionId);

    const withheld = syntheticCanary('withheldA');
    const released = syntheticCanary('approvedB');
    await send(sender.page, withheld);
    await send(sender.page, released);
    const recipient = owner.page.locator('section.review').filter({ hasText: `To: ${controls.agentParticipantId}` });
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
    owner.page.on('request', request => {
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
    const result = await mailboxOutcome(owner.page, controls.bindingId, approval.operationId) as {
      ok?: boolean; releaseIds?: unknown;
    };
    expect(result.ok).toBe(true);
    expect(Array.isArray(result.releaseIds)).toBe(true);
    expect(result.releaseIds).toHaveLength(1);
    const releaseId = (result.releaseIds as string[])[0]!;
    await expect(recipient.getByText('Released', { exact: true })).toBeVisible();
    await expect(rowA).toHaveCount(1); // A was an actual pending neighbor, not a never-enqueued marker.

    await expect.poll(async () => {
      try {
        await nativeSelectedOnlyProof(native, baseline, { withheld, released,
          withheldEventId: eventA!, releasedEventId: eventB!,
          bindingId: controls.bindingId, generation: connector.generation, releaseId });
        return true;
      } catch { return false; }
    }, { timeout: 45_000, intervals: [250, 500, 1_000] }).toBe(true);
    // A later native turn is not allowed to leak the already-pending neighbor.
    await owner.page.waitForTimeout(1_500);
    await nativeSelectedOnlyProof(native, baseline, { withheld, released,
      withheldEventId: eventA!, releasedEventId: eventB!,
      bindingId: controls.bindingId, generation: connector.generation, releaseId });
    const stillBound = await connectorWitness(controls, 'status');
    expect(stillBound).toMatchObject({ bindingId: connector.bindingId,
      generation: connector.generation, sessionId: connector.sessionId });
  } finally {
    await Promise.all([owner.context.close(), sender.context.close()]);
  }
});
