import { expect, test } from '@playwright/test';
import { signIn } from '../human/fixtures';
import { controlsStatus, mailbox, mailboxOutcome, readLiveControlsEnvironment } from './fixtures';

const provider = process.env.KHALA_E2E_MANUAL_PROVIDER;
test.skip(provider !== 'codex' && provider !== 'claude',
  'Run explicitly with a disposable native MCP connector and KHALA_E2E_MANUAL_PROVIDER.');

const { human, controls } = readLiveControlsEnvironment();

test('owner sees and sets only the exact native MCP mode proved by its receipt ledger', async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  try {
    const page = await context.newPage();
    await page.goto(`${human.appOrigin}/new`, { waitUntil: 'networkidle' });
    await signIn(page, human, human.users[0]);
    await page.goto(`${human.appOrigin}/channels/${encodeURIComponent(controls.roomId)}`);
    await page.locator('.channel-roster > summary').click();
    const detail = page.locator('.agent-presence__details').filter({ hasText: controls.agentParticipantId });
    await detail.locator('summary').click();

    const before = await controlsStatus(page, controls.bindingId);
    expect(before.binding).toMatchObject({ bindingId: controls.bindingId,
      agentParticipantId: controls.agentParticipantId });
    expect(before.listening).toMatchObject({ bindingId: controls.bindingId,
      generation: before.binding.generation, effective: null,
      support: { steer: { status: 'unsupported' }, sync: { status: 'unsupported' } } });
    for (const mode of ['steer', 'sync'] as const) {
      await expect(detail.getByRole('radio', { name: new RegExp(`^${mode}`, 'i') })).toBeDisabled();
    }
    const command = { v: 1, commandId: `manual_${crypto.randomUUID().replaceAll('-', '')}`,
      bindingId: controls.bindingId, expectedBindingGeneration: before.binding.generation,
      expectedVersion: before.listening.version, requested: 'async', issuedAt: new Date().toISOString() };
    if (before.listening.support.async.status === 'unsupported') {
      await expect(detail.getByRole('radio', { name: /^async/i })).toBeDisabled();
      expect((await mailbox(page, controls.bindingId, 'listening_set', command, command.commandId)).status).toBe(200);
      expect(await mailboxOutcome(page, controls.bindingId, command.commandId))
        .toMatchObject({ outcome: 'refused', effective: null,
          reason: expect.stringContaining('receipt proof') });
      expect((await controlsStatus(page, controls.bindingId)).listening.effective).toBeNull();
      return;
    }

    expect(before.listening.support.async.status, `${provider} needs a current explicit-pull receipt`).toBe('proven');
    await detail.getByRole('radio', { name: /^async/i }).check();
    await detail.getByRole('button', { name: 'Apply listening mode' }).click();
    await expect.poll(async () => {
      const current = await controlsStatus(page, controls.bindingId);
      return [current.listening.version > before.listening.version, current.listening.requested,
        current.listening.effective, current.policy.effectiveMode];
    }).toEqual([true, 'async', 'async', 'async']);
    await expect(detail.locator('.agent-controls__listening-status'))
      .toContainText('Requested: async · Effective: async');
  } finally { await context.close(); }
});
