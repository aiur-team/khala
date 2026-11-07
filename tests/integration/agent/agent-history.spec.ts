import { randomUUID } from 'node:crypto';
import { access, mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import type { InboxEntry } from '../../../packages/contracts/src/m1/inbox';
import { freshPage, readLiveHumanEnvironment, signIn } from '../human/fixtures';
import { startMcp } from './mcp-stdio';

async function send(page: Page, text: string) {
  await page.getByLabel('Message', { exact: true }).fill(text);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('.timeline__row:not(.timeline__row--pending)', { hasText: text }).first()).toBeVisible({ timeout: 30_000 });
}

// Run alone on a local stack (`pnpm stack:up`, `source .khala-local/e2e.env`), on the owner's first
// (cross-signed) browser device. Messages are sent before the agent exists; the owner's open tab hands
// their keys to the agent (MSC4268) when the control server invites it, so the agent reads them.
test.use({ actionTimeout: 20_000 });

test('an agent added after messages were sent reads the earlier history', async ({ browser }) => {
  test.setTimeout(300_000);
  const environment = readLiveHumanEnvironment();
  const cert = process.env.NODE_EXTRA_CA_CERTS ?? fileURLToPath(new URL('../../../.khala-local/certs/tls.crt', import.meta.url));
  await access(cert);
  const id = randomUUID();
  const context = await browser.newContext();
  const mcp = startMcp({ env: { ...process.env, XDG_STATE_HOME: await mkdtemp(path.join(os.tmpdir(), 'khala-agent-')),
    CLAUDE_CODE_SESSION_ID: `hist-${id}`, NODE_EXTRA_CA_CERTS: cert } });
  try {
    const page = await freshPage(context, environment);
    await signIn(page, environment, environment.users[0]);
    await page.getByRole('button', { name: 'New channel', exact: true }).click();
    await page.getByLabel('Channel name', { exact: true }).fill(`History ${id.slice(0, 8)}`);
    await page.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page).toHaveURL(/\/channels\//u, { timeout: 60_000 });
    const channelUrl = page.url();
    const history = [1, 2, 3].map(n => `before-agent-${n}-${id}`);
    for (const text of history) await send(page, text);

    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: environment.appOrigin });
    const roster = page.locator('#kh-head-btn');
    if (await roster.getAttribute('aria-expanded') !== 'true') await roster.click();
    await page.getByRole('button', { name: 'Add agent', exact: true }).click();
    await page.getByRole('button', { name: 'Copy link', exact: true }).click();
    await expect(page.getByText('Copied', { exact: true })).toBeVisible();
    const link = await page.evaluate(() => navigator.clipboard.readText());
    await page.keyboard.press('Escape');
    const joined = await mcp.call('join', { link, label: 'Agent' });
    expect(joined.isError).not.toBe(true);
    if (joined.structuredContent.state !== 'connected' && joined.structuredContent.autoConfirmed !== true) {
      // Confirm in a second tab so the channel tab (the key holder) stays open.
      const confirm = await context.newPage();
      await confirm.goto(joined.structuredContent.confirmUrl as string, { waitUntil: 'commit' });
      await confirm.getByRole('button', { name: 'Confirm', exact: true }).click({ timeout: 15_000 }).catch(() => undefined);
    }
    await expect.poll(async () => (await mcp.call('status', {})).structuredContent.state,
      { timeout: 120_000, intervals: [2000] }).toBe('connected');
    await expect(page).toHaveURL(channelUrl);
    await expect.poll(async () => {
      const read = await mcp.call('read', { limit: 30 });
      const messages = read.structuredContent.messages as InboxEntry[] | undefined;
      return (messages ?? []).map(message => message.body).filter(body => history.includes(body));
    }, { timeout: 60_000, intervals: [2000] }).toEqual(history);
  } finally {
    await mcp.close();
    await context.close();
  }
});
