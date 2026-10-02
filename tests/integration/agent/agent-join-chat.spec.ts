import { randomUUID } from 'node:crypto';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import type { InboxEntry } from '../../../packages/contracts/src/m1/inbox';
import { freshPage, readLiveHumanEnvironment, signIn } from '../human/fixtures';
import { startMcp } from './mcp-stdio';

async function inbox(file: string): Promise<InboxEntry[]> {
  let text: string;
  try { text = await readFile(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  // The last append may still be in progress; only parse complete JSONL lines.
  return text.split('\n').slice(0, -1).filter(Boolean).map(line => JSON.parse(line) as InboxEntry);
}
async function send(page: Page, text: string) {
  await page.getByLabel('Message', { exact: true }).fill(text);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.timeline__row:not(.timeline__row--pending)', { hasText: text })).toBeVisible({ timeout: 30_000 });
}

// Run this spec alone on a fresh operator-started stack. Each human must use
// their first browser device so MSC4268 can share the owner's historical keys.
test('a real MCP agent joins, reads owner history, receives and sends attributed chat', async ({ browser }) => {
  test.setTimeout(300_000);
  const environment = readLiveHumanEnvironment();
  const cert = process.env.NODE_EXTRA_CA_CERTS
    ?? fileURLToPath(new URL('../../../.khala-local/certs/tls.crt', import.meta.url));
  try { await access(cert); }
  catch { throw new Error('Local stack certificate is absent; run pnpm stack:up and source .khala-local/e2e.env.'); }
  const stateHome = await mkdtemp(path.join(os.tmpdir(), 'khala-agent-'));
  const sessionId = `km150-${randomUUID()}`;
  const dir = path.join(stateHome, 'khala', 'claude', sessionId);
  const inboxFile = path.join(dir, 'inbox.jsonl');
  const sessionFile = path.join(dir, 'session.json');
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  let mcp: ReturnType<typeof startMcp> | undefined;
  try {
    const alice = await freshPage(aliceContext, environment);
    await signIn(alice, environment, environment.users[0]);
    await alice.getByRole('button', { name: 'Create channel', exact: true }).last().click();
    await alice.getByLabel('Channel name (optional)').fill(`Agent ${environment.environmentId}`);
    await alice.getByRole('button', { name: 'Create channel', exact: true }).last().click();
    await expect(alice).toHaveURL(/\/channels\//u);
    const channelUrl = alice.url();
    await aliceContext.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: environment.appOrigin });
    await alice.getByRole('button', { name: 'Copy my channel link' }).click();
    await expect(alice.getByText('Copied', { exact: true })).toBeVisible();
    const link = await alice.evaluate(() => navigator.clipboard.readText());
    expect(link).toMatch(/\/join\/[^/?#]+$/u);

    const bob = await bobContext.newPage();
    await bob.goto(link, { waitUntil: 'networkidle' });
    await signIn(bob, environment, environment.users[1]);
    await expect(bob.getByText("You're in.")).toBeVisible();
    await bob.getByRole('button', { name: 'Open channel' }).click();
    await expect(bob).toHaveURL(channelUrl);
    await expect(bob.getByLabel('Message', { exact: true })).toBeEnabled();
    const id = randomUUID();
    const history = [1, 2, 3].map(n => `hist-${n}-${id}`);
    for (const text of history) {
      await send(alice, text);
      await expect(bob.locator('.timeline__row', { hasText: text })).toBeVisible({ timeout: 30_000 });
    }

    mcp = startMcp({ env: { ...process.env, XDG_STATE_HOME: stateHome,
      CLAUDE_CODE_SESSION_ID: sessionId, NODE_EXTRA_CA_CERTS: cert } });
    const joined = await mcp.call('khala_join', { link, label: 'Agent' });
    expect(joined.isError).not.toBe(true);
    expect(joined.structuredContent.state).toBe('awaiting_confirmation');
    const confirmUrl = joined.structuredContent.confirmUrl;
    expect(typeof confirmUrl).toBe('string');
    expect((confirmUrl as string).startsWith(`${environment.appOrigin}/agent/confirm?joinId=`)).toBe(true);
    await bob.goto(confirmUrl as string);
    await bob.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(bob.getByText(/Agent joined/u)).toBeVisible({ timeout: 120_000 });
    const agent = mcp;
    let agentUserId: unknown;
    await expect.poll(async () => {
      const result = await agent.call('khala_status', {});
      agentUserId = result.structuredContent.agentUserId;
      return result.structuredContent.state;
    }, { timeout: 120_000, intervals: [2000] }).toBe('connected');
    expect(agentUserId).toMatch(/^@agent-[0-9a-f]{8}-[a-z0-9]{6}:/u);
    // Assert existence only: session.json contains credentials, never print it.
    await access(sessionFile);
    await expect.poll(async () => {
      const read = await agent.call('khala_read', { limit: 30 });
      const messages = read.structuredContent.messages as InboxEntry[] | undefined;
      return (messages ?? []).map(message => message.body).filter(body => history.includes(body));
    }, { timeout: 30_000, intervals: [2000] }).toEqual(history);

    const live = `live-${id}`;
    await send(alice, live);
    await expect.poll(async () => (await inbox(inboxFile))
      .filter(entry => entry.body === live && entry.senderKind === 'human').length,
    { timeout: 30_000, intervals: [2000] }).toBe(1);
    const reply = `agent-reply-${id}`;
    const sent = await agent.call('khala_send', { text: reply });
    expect(sent.isError).not.toBe(true);
    expect(sent.structuredContent.eventId).toMatch(/^\$/u);
    await delay(5000);
    const entries = await inbox(inboxFile);
    expect(entries.some(entry => entry.body === reply || entry.sender === agentUserId)).toBe(false);
    await bob.goto(channelUrl);
    const row = bob.locator('.timeline__row:not(.timeline__row--pending)', { hasText: reply });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row).toContainText('Agent · ');
    await expect(row).toContainText('Claude Code agent');
    for (const page of [alice, bob]) {
      await page.reload();
      await expect(page.locator('.timeline__row', { hasText: reply })).toBeVisible({ timeout: 30_000 });
    }
    for (const text of history) await expect(bob.locator('.timeline__row', { hasText: text })).toBeVisible();
  } finally {
    try {
      await mcp?.close();
      await expect(access(sessionFile)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await Promise.all([aliceContext.close(), bobContext.close(), rm(stateHome, { recursive: true, force: true })]);
    }
  }
});
