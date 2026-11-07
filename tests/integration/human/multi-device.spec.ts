import { randomUUID } from 'node:crypto';
import { access, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { freshPage, readLiveHumanEnvironment, signIn } from './fixtures';
import { startMcp } from '../agent/mcp-stdio';

async function send(page: Page, text: string) {
  await page.getByLabel('Message', { exact: true }).fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('.timeline__row:not(.timeline__row--pending)', { hasText: text }).first()).toBeVisible({ timeout: 30_000 });
}

async function agentLink(page: Page): Promise<string> {
  const roster = page.locator('#kh-head-btn');
  if (await roster.getAttribute('aria-expanded') !== 'true') await roster.click();
  await page.getByRole('button', { name: 'Add agent', exact: true }).click();
  await page.getByRole('button', { name: 'Copy link', exact: true }).click();
  await expect(page.getByText('Copied', { exact: true })).toBeVisible();
  const link = await page.evaluate(() => navigator.clipboard.readText());
  await page.keyboard.press('Escape');
  return link;
}

// Run alone on a local stack (`pnpm stack:up`, `source .khala-local/e2e.env`).
// One human on two browser devices. An agent added from the first is removed
// (its Matrix device is logged out) and re-added from the second, so it rejoins
// with a new device. Every message must still render on both devices.
test.use({ actionTimeout: 20_000 });

test('every signed-in device of one human reads new human and agent messages', async ({ browser }) => {
  test.setTimeout(300_000);
  const environment = readLiveHumanEnvironment();
  const cert = process.env.NODE_EXTRA_CA_CERTS ?? fileURLToPath(new URL('../../../.khala-local/certs/tls.crt', import.meta.url));
  await access(cert);
  const id = randomUUID();
  const contexts = [await browser.newContext(), await browser.newContext()];
  const agents: ReturnType<typeof startMcp>[] = [];
  async function addAgent(page: Page, channelUrl: string, existing?: ReturnType<typeof startMcp>) {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: environment.appOrigin });
    const link = await agentLink(page);
    const mcp = existing ?? startMcp({ env: { ...process.env, XDG_STATE_HOME: await mkdtemp(path.join(os.tmpdir(), 'khala-agent-')),
      CLAUDE_CODE_SESSION_ID: `md-${id}`, NODE_EXTRA_CA_CERTS: cert } });
    if (!existing) agents.push(mcp);
    const joined = await mcp.call('join', { link, label: 'Agent' });
    expect(joined.isError).not.toBe(true);
    if (joined.structuredContent.state !== 'connected' && joined.structuredContent.autoConfirmed !== true) {
      await page.goto(joined.structuredContent.confirmUrl as string, { waitUntil: 'commit' });
      // The owner's own agent may confirm without a button.
      await page.getByRole('button', { name: 'Confirm', exact: true }).click({ timeout: 15_000 }).catch(() => undefined);
    }
    await expect.poll(async () => (await mcp.call('status', {})).structuredContent.state,
      { timeout: 120_000, intervals: [2000] }).toBe('connected');
    await page.goto(channelUrl);
    await expect(page.getByLabel('Message', { exact: true })).toBeEnabled({ timeout: 60_000 });
    return mcp;
  }
  try {
    let oldPhone = await freshPage(contexts[0]!, environment);
    await signIn(oldPhone, environment, environment.users[0]);
    await oldPhone.getByRole('button', { name: 'New channel', exact: true }).click();
    await oldPhone.getByLabel('Channel name', { exact: true }).fill(`Devices ${id.slice(0, 8)}`);
    await oldPhone.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(oldPhone).toHaveURL(/\/channels\//u, { timeout: 60_000 });
    const channelUrl = oldPhone.url();
    const agent = await addAgent(oldPhone, channelUrl);
    await send(oldPhone, `old-before-${id}`);
    expect((await agent.call('send', { text: `agent-before-${id}` })).isError).not.toBe(true);
    await expect(oldPhone.locator('.timeline__row', { hasText: `agent-before-${id}` }).first()).toBeVisible({ timeout: 30_000 });
    // Removing an agent logs out its device; its earlier messages stay in the channel.
    const roster = oldPhone.locator('#kh-head-btn');
    if (await roster.getAttribute('aria-expanded') !== 'true') await roster.click();
    await oldPhone.getByRole('group', { name: 'Channel members' }).getByRole('button', { name: /Claude Code/u }).first().click();
    await oldPhone.getByRole('button', { name: 'Remove from channel', exact: true }).click();
    await oldPhone.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect.poll(async () => (await agent.call('status', {})).structuredContent.state,
      { timeout: 60_000, intervals: [2000] }).not.toBe('connected');
    await oldPhone.close(); // The old phone's tab closes; its IndexedDB stays.

    const newPhone = await freshPage(contexts[1]!, environment);
    await signIn(newPhone, environment, environment.users[0]);
    await newPhone.goto(channelUrl);
    await expect(newPhone.getByLabel('Message', { exact: true })).toBeEnabled({ timeout: 60_000 });
    // Re-added from the new device, the same agent rejoins with a new Matrix device.
    await addAgent(newPhone, channelUrl, agent);
    const texts = [`new-phone-${id}`, `agent-reply-${id}`, `old-phone-${id}`];
    await send(newPhone, texts[0]!);
    expect((await agent.call('send', { text: texts[1] })).isError).not.toBe(true);

    oldPhone = await contexts[0]!.newPage(); // The old phone reopens: same crypto store, fresh sync.
    await oldPhone.goto(channelUrl);
    await expect(oldPhone.getByLabel('Message', { exact: true })).toBeEnabled({ timeout: 60_000 });
    await send(oldPhone, texts[2]!);
    for (const [name, page] of [['new', newPhone], ['old', oldPhone]] as const) {
      // The new device has no key for messages from before it existed (no backup yet).
      for (const text of name === 'old' ? [...texts, `agent-before-${id}`] : texts) {
        await expect(page.locator('.timeline__row', { hasText: text }).first(), `${name} device shows ${text}`)
          .toBeVisible({ timeout: 30_000 });
      }
    }
  } finally {
    for (const agent of agents) await agent.close();
    for (const context of contexts) await context.close();
  }
});
