import { randomUUID } from 'node:crypto';
import { access, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import type { InboxEntry } from '../../../packages/contracts/src/m1/inbox';
import { freshPage, readLiveHumanEnvironment, signIn } from './fixtures';
import { startMcp } from '../agent/mcp-stdio';

async function send(page: Page, text: string) {
  await page.getByLabel('Message', { exact: true }).fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('.timeline__row:not(.timeline__row--pending)', { hasText: text }).first()).toBeVisible({ timeout: 30_000 });
}
const emoji = (page: Page) => page.getByRole('list', { name: 'Emoji' }).innerText();

// Run alone on a freshly wiped local stack (`pnpm stack:down --wipe && pnpm stack:up`,
// `source .khala-local/e2e.env`): the first device must be the user's first (C13).
// One human, two devices. The new device cannot read earlier messages until the first device approves it
// by emoji comparison; then it restores the encrypted key backup. Once approved, it is cross-signed,
// so an agent added from it alone also receives the earlier history (#1419 from a later device).
test.use({ actionTimeout: 20_000 });

test('a new device reads earlier history after another device approves it', async ({ browser }) => {
  test.setTimeout(300_000);
  const environment = readLiveHumanEnvironment();
  const cert = process.env.NODE_EXTRA_CA_CERTS ?? fileURLToPath(new URL('../../../.khala-local/certs/tls.crt', import.meta.url));
  await access(cert);
  const id = randomUUID();
  const contexts = [await browser.newContext(), await browser.newContext()];
  const mcp = startMcp({ env: { ...process.env, XDG_STATE_HOME: await mkdtemp(path.join(os.tmpdir(), 'khala-agent-')),
    CLAUDE_CODE_SESSION_ID: `dev-${id}`, NODE_EXTRA_CA_CERTS: cert } });
  try {
    const first = await freshPage(contexts[0]!, environment);
    await signIn(first, environment, environment.users[0]);
    await first.getByRole('button', { name: 'New channel', exact: true }).click();
    await first.getByLabel('Channel name', { exact: true }).fill(`Device ${id.slice(0, 8)}`);
    await first.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(first).toHaveURL(/\/channels\//u, { timeout: 60_000 });
    const channelUrl = first.url();
    const history = [1, 2, 3].map(n => `earlier-${n}-${id}`);
    for (const text of history) await send(first, text);

    const second = await freshPage(contexts[1]!, environment);
    await signIn(second, environment, environment.users[0]);
    await second.goto(channelUrl);
    await expect(second.getByLabel('Message', { exact: true })).toBeEnabled({ timeout: 60_000 });
    await expect(second.locator('.timeline__row', { hasText: history[0]! })).toHaveCount(0);
    await second.getByRole('button', { name: 'Unlock with another device', exact: true }).click({ timeout: 60_000 });
    await first.getByRole('button', { name: 'Approve', exact: true }).click({ timeout: 60_000 });
    await expect(first.getByRole('list', { name: 'Emoji' })).toBeVisible({ timeout: 30_000 });
    await expect(second.getByRole('list', { name: 'Emoji' })).toBeVisible({ timeout: 30_000 });
    expect(await emoji(second)).toBe(await emoji(first));
    await first.getByRole('button', { name: 'They match', exact: true }).click();
    await second.getByRole('button', { name: 'They match', exact: true }).click();
    await expect(second.getByText('Device approved. Earlier messages are unlocking.')).toBeVisible({ timeout: 30_000 });
    for (const text of history) {
      await expect(second.locator('.timeline__row', { hasText: text }).first(), `new device shows ${text}`).toBeVisible({ timeout: 60_000 });
    }

    // The first device goes away; the approved device alone adds an agent, which reads the earlier history.
    await contexts[0]!.close();
    await contexts[1]!.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: environment.appOrigin });
    const roster = second.locator('#kh-head-btn');
    if (await roster.getAttribute('aria-expanded') !== 'true') await roster.click();
    await second.getByRole('button', { name: 'Add agent', exact: true }).click();
    await second.getByRole('button', { name: 'Copy link', exact: true }).click();
    const link = await second.evaluate(() => navigator.clipboard.readText());
    await second.keyboard.press('Escape');
    const joined = await mcp.call('join', { link, label: 'Agent' });
    expect(joined.isError).not.toBe(true);
    if (joined.structuredContent.state !== 'connected' && joined.structuredContent.autoConfirmed !== true) {
      // Confirm in another tab so the channel tab (the key holder) stays open.
      const confirm = await contexts[1]!.newPage();
      await confirm.goto(joined.structuredContent.confirmUrl as string, { waitUntil: 'commit' });
      await confirm.getByRole('button', { name: 'Confirm', exact: true }).click({ timeout: 15_000 }).catch(() => undefined);
    }
    await expect.poll(async () => (await mcp.call('status', {})).structuredContent.state,
      { timeout: 120_000, intervals: [2000] }).toBe('connected');
    await expect.poll(async () => {
      const read = await mcp.call('read', { limit: 30 });
      return ((read.structuredContent.messages as InboxEntry[] | undefined) ?? []).map(m => m.body).filter(body => history.includes(body));
    }, { timeout: 60_000, intervals: [2000] }).toEqual(history);
  } finally {
    await mcp.close();
    for (const context of contexts) await context.close().catch(() => undefined);
  }
});
