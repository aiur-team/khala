import { expect, test, type Browser, type Page } from '@playwright/test';
import { signIn } from '../human/fixtures';
import { controlsStatus, mailbox, mailboxOutcome, readLiveControlsEnvironment } from './fixtures';

const { human, controls } = readLiveControlsEnvironment();
type Mode = 'steer' | 'sync' | 'async';

async function ownerPage(browser: Browser, phone: boolean) {
  const context = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, isMobile: true,
    hasTouch: true } : { viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${human.appOrigin}/new`, { waitUntil: 'networkidle' });
  await signIn(page, human, human.users[0]);
  await page.goto(`${human.appOrigin}/channels/${encodeURIComponent(controls.roomId)}`);
  await page.locator('.channel-roster > summary').click();
  const detail = page.locator('.agent-presence__details').filter({ hasText: controls.agentParticipantId });
  await detail.locator('summary').click();
  return { context, page, detail };
}

function modeCommand(status: Awaited<ReturnType<typeof controlsStatus>>, requested: Mode) {
  return { v: 1, commandId: `mode_${crypto.randomUUID().replaceAll('-', '')}`,
    bindingId: controls.bindingId, expectedBindingGeneration: status.binding.generation,
    expectedVersion: status.listening.version, requested, issuedAt: new Date().toISOString() };
}

for (const phone of [false, true]) {
  test(`${phone ? 'phone' : 'desktop'} owner switches an exact hosted listening session`, async ({ browser }) => {
    test.setTimeout(180_000);
    const owner = await ownerPage(browser, phone);
    let restore: Mode | null = null;
    try {
      const before = await controlsStatus(owner.page, controls.bindingId);
      expect(before.listening).toMatchObject({ bindingId: controls.bindingId,
        generation: before.binding.generation });
      const target = (['steer', 'sync', 'async'] as const).find(mode => mode !== before.listening.requested
        && before.listening.support[mode].status === 'proven');
      expect(target, 'the live disposable connector must prove another interactive mode').toBeDefined();
      restore = before.listening.requested;
      await expect(owner.detail.getByRole('heading', { name: 'Listening mode' })).toBeVisible();
      await owner.detail.getByRole('radio', { name: new RegExp(`^${target}`, 'i') }).check();
      await owner.detail.getByRole('button', { name: 'Apply listening mode' }).click();
      await expect.poll(async () => {
        const current = await controlsStatus(owner.page, controls.bindingId);
        return [current.listening.version > before.listening.version, current.listening.requested,
          current.listening.effective];
      }).toEqual([true, target, target]);
      await expect(owner.detail.locator('.agent-controls__listening-status'))
        .toContainText(`Requested: ${target} · Effective: ${target}`);
      for (const mode of ['steer', 'sync', 'async'] as const) {
        if (before.listening.support[mode].status === 'proven') continue;
        await expect(owner.detail.getByRole('radio', { name: new RegExp(`^${mode}`, 'i') })).toBeDisabled();
      }
    } finally {
      if (restore !== null) {
        const current = await controlsStatus(owner.page, controls.bindingId);
        if (current.listening.requested !== restore) {
          const command = modeCommand(current, restore);
          expect((await mailbox(owner.page, controls.bindingId, 'listening_set', command, command.commandId)).status).toBe(200);
          expect((await mailboxOutcome(owner.page, controls.bindingId, command.commandId) as { outcome: string }).outcome)
            .toBe('applied');
        }
      }
      await owner.context.close();
    }
  });
}

test('hosted listening rejects stale owner writes and another signed-in owner', async ({ browser }) => {
  test.setTimeout(120_000);
  const owner = await ownerPage(browser, false);
  const otherContext = await browser.newContext();
  const other: Page = await otherContext.newPage();
  try {
    const before = await controlsStatus(owner.page, controls.bindingId);
    const requested = before.listening.requested ?? 'sync';
    const staleVersion = modeCommand(before, requested);
    const staleGeneration = { ...modeCommand(before, requested), expectedBindingGeneration: before.binding.generation + 1 };
    expect((await mailbox(owner.page, controls.bindingId, 'listening_set', staleGeneration,
      staleGeneration.commandId)).status).toBe(409);
    await other.goto(`${human.appOrigin}/new`, { waitUntil: 'networkidle' });
    await signIn(other, human, human.users[1]);
    expect((await mailbox(other, controls.bindingId, 'listening_set', staleVersion, staleVersion.commandId)).status).toBe(403);
    const stale = { ...staleVersion, expectedVersion: before.listening.version + 1 };
    expect((await mailbox(owner.page, controls.bindingId, 'listening_set', stale, stale.commandId)).status).toBe(200);
    expect((await mailboxOutcome(owner.page, controls.bindingId, stale.commandId) as { outcome: string }).outcome)
      .toBe('conflict');
  } finally { await otherContext.close(); await owner.context.close(); }
});
