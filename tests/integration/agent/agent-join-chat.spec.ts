import { randomUUID } from 'node:crypto';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { channelFiles, readStatus, sessionFiles } from '../../../packages/agent/src/state';
import type { AgentCredentials } from '../../../packages/contracts/src/m1/agent-join';
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
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('.timeline__row:not(.timeline__row--pending)', { hasText: text }).first()).toBeVisible({ timeout: 30_000 });
}

async function chooseUsername(page: Page) {
  // The profile gate is asynchronous and may keep the requested URL unchanged.
  await expect(page.getByRole('heading', { name: 'Choose your username' })
    .or(page.locator('.khala-owner-shell:has(button[aria-label="New channel"]:enabled)'))).toBeVisible({ timeout: 120_000 });
  const heading = page.getByRole('heading', { name: 'Choose your username' });
  if (await heading.isVisible()) {
    await page.getByRole('textbox', { name: 'Username', exact: true }).fill(`e2e${randomUUID().replaceAll('-', '').slice(0, 12)}`);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(heading).toBeHidden();
  }
}
async function agentLink(page: Page): Promise<string> {
  const roster = page.locator('#kh-head-btn');
  if (await roster.getAttribute('aria-expanded') !== 'true') await roster.click();
  await page.getByRole('button', { name: 'Add agent', exact: true }).click();
  await page.getByRole('button', { name: 'Copy link', exact: true }).click();
  await expect(page.getByText('Copied', { exact: true })).toBeVisible();
  const link = await page.evaluate(() => navigator.clipboard.readText());
  expect(link).toMatch(/\/join\/[^/?#]+$/u);
  await page.keyboard.press('Escape');
  return link;
}

// Run this spec alone on a fresh operator-started stack. Each human must use
// their first browser device so MSC4268 can share the owner's historical keys.
test.use({ actionTimeout: 15_000 });

test('a real MCP agent chats and restores two channel inboxes without tool calls', async ({ browser }) => {
  test.setTimeout(300_000);
  const environment = readLiveHumanEnvironment();
  const cert = process.env.NODE_EXTRA_CA_CERTS
    ?? fileURLToPath(new URL('../../../.khala-local/certs/tls.crt', import.meta.url));
  try { await access(cert); }
  catch { throw new Error('Local stack certificate is absent; run pnpm stack:up and source .khala-local/e2e.env.'); }
  const stateHome = await mkdtemp(path.join(os.tmpdir(), 'khala-agent-'));
  const sessionId = `km150-${randomUUID()}`;
  let inboxFile = '';
  let sessionFile = '';
  const files = sessionFiles('claude', sessionId, { XDG_STATE_HOME: stateHome });
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  let mcp: ReturnType<typeof startMcp> | undefined;
  let failure: unknown;
  try {
    const alice = await freshPage(aliceContext, environment);
    await signIn(alice, environment, environment.users[0]);
    await chooseUsername(alice);
    await alice.getByRole('button', { name: 'New channel', exact: true }).click();
    await alice.getByLabel('Channel name', { exact: true }).fill(`Agent ${environment.environmentId}`);
    await alice.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(alice).toHaveURL(/\/channels\//u);
    const channelUrl = alice.url();
    await aliceContext.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: environment.appOrigin });
    await alice.locator('.kh-hacts').getByRole('button', { name: 'Invite', exact: true }).click();
    await alice.getByRole('button', { name: 'Copy link', exact: true }).click();
    await expect(alice.getByText('Copied', { exact: true })).toBeVisible();
    const humanLink = await alice.evaluate(() => navigator.clipboard.readText());
    await alice.keyboard.press('Escape');
    const link = await agentLink(alice);

    const bob = await bobContext.newPage();
    await bob.goto(humanLink, { waitUntil: 'networkidle' });
    await signIn(bob, environment, environment.users[1]);
    await chooseUsername(bob);
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
    await alice.goto(confirmUrl as string);
    await alice.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(alice.locator('.kh-fin-ok')).toContainText('joined', { timeout: 120_000 });
    await alice.goto(channelUrl);
    const agent = mcp;
    let agentUserId: unknown;
    await expect.poll(async () => {
      const result = await agent.call('khala_status', {});
      agentUserId = result.structuredContent.agentUserId;
      return result.structuredContent.state;
    }, { timeout: 120_000, intervals: [2000] }).toBe('connected');
    expect(agentUserId).toMatch(/^@agent-[0-9a-f]{8}-[a-z0-9]{6}:/u);
    const status = await agent.call('khala_status', {});
    const channels = status.structuredContent.channels as { roomId: string; you: string }[];
    const nested = channelFiles(files, channels[0]!.roomId);
    inboxFile = nested.inbox; sessionFile = nested.session;
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
    // A later human append proves sync passed the reply before checking AE4.
    const afterReply = `after-reply-${id}`;
    await send(alice, afterReply);
    await expect.poll(async () => (await inbox(inboxFile)).some(entry => entry.body === afterReply),
      { timeout: 30_000, intervals: [2000] }).toBe(true);
    const entries = await inbox(inboxFile);
    expect(entries.some(entry => entry.eventId === sent.structuredContent.eventId || entry.body === reply || entry.sender === agentUserId)).toBe(false);
    await bob.goto(channelUrl);
    const row = bob.locator('.timeline__row:not(.timeline__row--pending)', { hasText: reply });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await expect(row).toContainText(channels[0]!.you);
    await expect(row.getByRole('img', { name: 'Agent', exact: true })).toBeVisible();
    for (const page of [alice, bob]) {
      await page.reload();
      await expect(page.locator('.timeline__row', { hasText: reply })).toBeVisible({ timeout: 30_000 });
    }
    for (const text of history) await expect(bob.locator('.timeline__row', { hasText: text })).toBeVisible();

    // Join a second channel with the same MCP session, then prove startup restores
    // both independent inboxes without a status/read/join tool call.
    await alice.goto(`${environment.appOrigin}/new`);
    await alice.getByRole('button', { name: 'New channel', exact: true }).click();
    await alice.getByLabel('Channel name', { exact: true }).fill(`Restore ${id.slice(0, 8)}`);
    await alice.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(alice).toHaveURL(/\/channels\//u);
    const secondUrl = alice.url();
    const secondLink = await agentLink(alice);
    const secondJoin = await agent.call('khala_join', { link: secondLink, label: 'Agent' });
    expect(secondJoin.isError).not.toBe(true);
    if (secondJoin.structuredContent.autoConfirmed !== true && secondJoin.structuredContent.state !== 'connected') {
      await alice.goto(secondJoin.structuredContent.confirmUrl as string);
      await alice.getByRole('button', { name: 'Confirm', exact: true }).click();
      await expect(alice.locator('.kh-fin-ok')).toContainText('joined', { timeout: 120_000 });
    }
    let joinedChannels: { roomId: string; state: string; you: string }[] = [];
    await expect.poll(async () => {
      const result = await agent.call('khala_status', {});
      joinedChannels = result.structuredContent.channels as typeof joinedChannels;
      return joinedChannels.filter(channel => channel.state === 'connected').length;
    }, { timeout: 120_000, intervals: [2000] }).toBe(2);
    const first = joinedChannels.find(channel => channel.roomId === channels[0]!.roomId)!;
    const second = joinedChannels.find(channel => channel.roomId !== first.roomId)!;
    const secondFiles = channelFiles(files, second.roomId);
    await agent.close(); mcp = undefined;
    await expect(access(sessionFile)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(secondFiles.session)).rejects.toMatchObject({ code: 'ENOENT' });
    mcp = startMcp({ env: { ...process.env, XDG_STATE_HOME: stateHome,
      CLAUDE_CODE_SESSION_ID: sessionId, NODE_EXTRA_CA_CERTS: cert } });
    // Read files, never call a tool on the fresh process before the mentions.
    await expect.poll(async () => Promise.all([first, second].map(async channel => {
      try { return (await readStatus(channelFiles(files, channel.roomId)))?.state ?? null; }
      catch { return null; }
    })), { timeout: 120_000, intervals: [2000] }).toEqual(['connected', 'connected']);
    const mentions = [`@${first.you} restore-first-${id}`, `@${second.you} restore-second-${id}`];
    for (const [url, text] of [[channelUrl, mentions[0]!], [secondUrl, mentions[1]!] ] as const) {
      await alice.goto(url);
      await send(alice, text);
    }
    await expect.poll(async () => (await inbox(inboxFile)).filter(entry => entry.body === mentions[0]).length,
      { timeout: 30_000, intervals: [2000] }).toBe(1);
    await expect.poll(async () => (await inbox(secondFiles.inbox)).filter(entry => entry.body === mentions[1]).length,
      { timeout: 30_000, intervals: [2000] }).toBe(1);
    expect((await inbox(inboxFile)).some(entry => entry.body === mentions[1])).toBe(false);
    expect((await inbox(secondFiles.inbox)).some(entry => entry.body === mentions[0])).toBe(false);
    test.info().annotations.push({ type: 'acceptance', description: 'join, AE1 history, live intake, AE4 own-sender filter, attributed reply, reload and two-channel startup restore with isolated mentions passed' });
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      await mcp?.close();
      if (sessionFile) await expect(access(sessionFile)).rejects.toMatchObject({ code: 'ENOENT' });
    } catch (cleanupError) {
      if (failure === undefined) throw cleanupError;
      test.info().annotations.push({ type: 'cleanup failure', description: cleanupError instanceof Error ? cleanupError.message : 'unknown' });
    } finally {
      await Promise.allSettled([aliceContext.close(), bobContext.close()]);
      await rm(stateHome, { recursive: true, force: true });
    }
  }
});

test('an agent rename and real MCP restart preserve Steer and confirm a later owner switch to Async', async ({ browser }) => {
  test.setTimeout(180_000);
  const environment = readLiveHumanEnvironment();
  const stateHome = await mkdtemp(path.join(os.tmpdir(), 'khala-mode-restore-'));
  const sessionId = `mode-restore-${randomUUID()}`;
  const env = { ...process.env, XDG_STATE_HOME: stateHome, CLAUDE_CODE_SESSION_ID: sessionId };
  const files = sessionFiles('claude', sessionId, { XDG_STATE_HOME: stateHome });
  const context = await browser.newContext();
  let mcp: ReturnType<typeof startMcp> | undefined;
  try {
    const alice = await freshPage(context, environment);
    await signIn(alice, environment, environment.users[0]);
    await chooseUsername(alice);
    await alice.getByRole('button', { name: 'New channel', exact: true }).click();
    await alice.getByLabel('Channel name', { exact: true }).fill(`Mode restore ${sessionId.slice(-8)}`);
    await alice.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(alice).toHaveURL(/\/channels\//u);
    const channelUrl = alice.url();
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: environment.appOrigin });
    const link = await agentLink(alice);
    mcp = startMcp({ env });
    const join = await mcp.call('khala_join', { link, label: 'Agent' });
    expect(join.isError).not.toBe(true);
    await alice.goto(join.structuredContent.confirmUrl as string);
    await alice.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(alice.locator('.kh-fin-ok')).toContainText('joined', { timeout: 120_000 });
    const agent = mcp;
    let channels: { roomId: string; you: string }[] = [];
    await expect.poll(async () => {
      const status = await agent.call('khala_status', {});
      channels = status.structuredContent.channels as typeof channels;
      return status.structuredContent.state;
    }, { timeout: 120_000, intervals: [2000] }).toBe('connected');
    const channel = channels[0]!;
    const nested = channelFiles(files, channel.roomId);
    const memberState = async () => {
      // Keep credentials out of assertion output and artifacts.
      const credentials: AgentCredentials = JSON.parse(await readFile(nested.session, 'utf8'));
      const response = await fetch(`${credentials.homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(channel.roomId)}/state/m.room.member/${encodeURIComponent(credentials.userId)}`,
        { headers: { authorization: `Bearer ${credentials.accessToken}` }, signal: AbortSignal.timeout(5000) });
      expect(response.status).toBe(200);
      return await response.json() as Record<string, unknown>;
    };
    await alice.goto(channelUrl);
    await expect(alice.getByLabel('Message', { exact: true })).toBeEnabled({ timeout: 30_000 });
    await alice.locator('#kh-head-btn').click();
    const row = alice.locator('.kh-rrow').filter({ has: alice.getByText(channel.you, { exact: true }) });
    const modeStatus = row.locator('+ .kh-mode-status');
    await row.locator('[role="radio"][data-v="steer"]').click();
    await expect.poll(async () => (await memberState())['com.khala.listening_mode'], { timeout: 30_000 }).toBe('steer');
    await expect(modeStatus).toBeHidden({ timeout: 30_000 });
    const before = await memberState();
    expect(typeof before['com.khala.invited_by']).toBe('string');
    const renamed = `Reviewer-${sessionId.slice(-8)}`;
    await row.getByRole('button', { name: `Rename ${channel.you}`, exact: true }).click();
    await alice.getByRole('textbox', { name: `Name for ${channel.you}`, exact: true }).fill(renamed);
    await alice.getByRole('button', { name: 'Rename', exact: true }).click();
    await expect.poll(async () => (await memberState()).displayname, { timeout: 30_000 }).toBe(renamed);
    expect((await memberState())['com.khala.invited_by']).toBe(before['com.khala.invited_by']);
    expect((await memberState())['com.khala.listening_mode']).toBe('steer');
    await alice.getByRole('button', { name: 'Close details', exact: true }).click();
    const renamedRow = alice.locator('.kh-rrow').filter({ has: alice.getByText(renamed, { exact: true }) });
    const renamedModeStatus = renamedRow.locator('+ .kh-mode-status');
    await agent.close();
    mcp = startMcp({ env });
    // Startup must restore without any tool call before the owner's next command.
    await expect.poll(async () => (await readStatus(nested))?.state, { timeout: 120_000, intervals: [2000] }).toBe('connected');
    expect(JSON.parse(await readFile(nested.mode, 'utf8')).mode).toBe('steer');
    const restored = await memberState();
    expect(restored['com.khala.invited_by']).toBe(before['com.khala.invited_by']);
    expect(restored['com.khala.listening_mode']).toBe('steer');
    expect(restored.displayname).toBe(renamed);
    await renamedRow.locator('[role="radio"][data-v="async"]').click();
    await expect.poll(async () => (await memberState())['com.khala.listening_mode'], { timeout: 30_000 }).toBe('async');
    await expect(renamedModeStatus).toBeHidden({ timeout: 30_000 });
    await expect(renamedRow.locator('[role="radio"][data-v="async"]')).toHaveAttribute('aria-checked', 'true');
    expect((await mcp.call('khala_status', {})).structuredContent.listeningMode).toBe('async');
  } finally {
    try { await mcp?.close(); }
    finally { await context.close(); await rm(stateHome, { recursive: true, force: true }); }
  }
});

test('the first owner mode change after a username change succeeds', async ({ browser }) => {
  test.setTimeout(180_000);
  const environment = readLiveHumanEnvironment();
  const stateHome = await mkdtemp(path.join(os.tmpdir(), 'khala-mode-restore-'));
  const sessionId = `mode-restore-${randomUUID()}`;
  const env = { ...process.env, XDG_STATE_HOME: stateHome, CLAUDE_CODE_SESSION_ID: sessionId };
  const files = sessionFiles('claude', sessionId, { XDG_STATE_HOME: stateHome });
  const context = await browser.newContext();
  let mcp: ReturnType<typeof startMcp> | undefined;
  try {
    const alice = await freshPage(context, environment);
    await signIn(alice, environment, environment.users[0]);
    await chooseUsername(alice);
    await alice.getByRole('button', { name: 'New channel', exact: true }).click();
    await alice.getByLabel('Channel name', { exact: true }).fill(`Mode restore ${sessionId.slice(-8)}`);
    await alice.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(alice).toHaveURL(/\/channels\//u);
    const channelUrl = alice.url();
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: environment.appOrigin });
    const link = await agentLink(alice);
    mcp = startMcp({ env });
    const join = await mcp.call('khala_join', { link, label: 'Agent' });
    expect(join.isError).not.toBe(true);
    await alice.goto(join.structuredContent.confirmUrl as string);
    await alice.getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(alice.locator('.kh-fin-ok')).toContainText('joined', { timeout: 120_000 });
    const agent = mcp;
    let channels: { roomId: string; you: string }[] = [];
    await expect.poll(async () => {
      const status = await agent.call('khala_status', {});
      channels = status.structuredContent.channels as typeof channels;
      return status.structuredContent.state;
    }, { timeout: 120_000, intervals: [2000] }).toBe('connected');
    const channel = channels[0]!;
    const nested = channelFiles(files, channel.roomId);
    const memberState = async () => {
      // Keep credentials out of assertion output and artifacts.
      const credentials: AgentCredentials = JSON.parse(await readFile(nested.session, 'utf8'));
      const response = await fetch(`${credentials.homeserver}/_matrix/client/v3/rooms/${encodeURIComponent(channel.roomId)}/state/m.room.member/${encodeURIComponent(credentials.userId)}`,
        { headers: { authorization: `Bearer ${credentials.accessToken}` }, signal: AbortSignal.timeout(5000) });
      expect(response.status).toBe(200);
      return await response.json() as Record<string, unknown>;
    };
    await alice.goto(channelUrl);
    await expect(alice.getByLabel('Message', { exact: true })).toBeEnabled({ timeout: 30_000 });
    await alice.locator('#kh-head-btn').click();
    const row = alice.locator('.kh-rrow').filter({ has: alice.getByText(channel.you, { exact: true }) });
    const modeStatus = row.locator('+ .kh-mode-status');
    await row.locator('[role="radio"][data-v="steer"]').click();
    await expect.poll(async () => (await memberState())['com.khala.listening_mode'], { timeout: 30_000 }).toBe('steer');
    await expect(modeStatus).toBeHidden({ timeout: 30_000 });
    // Exercise the default name cascade, then an agent with a custom name.
    const customName = `Custom-${sessionId.slice(-8)}`;
    for (const mode of ['async', 'sync', 'steer']) {
      await alice.getByRole('button', { name: 'Settings', exact: true }).click();
      await alice.getByRole('menuitem', { name: /^Profile/u }).click();
      const dialog = alice.getByRole('dialog', { name: 'Profile' });
      await dialog.getByRole('textbox', { name: 'Username', exact: true }).fill(`mode${randomUUID().replaceAll('-', '').slice(0, 12)}`);
      await dialog.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(dialog).toBeHidden();
      await alice.reload();
      await expect(alice.getByLabel('Message', { exact: true })).toBeEnabled({ timeout: 30_000 });
      await alice.locator('#kh-head-btn').click();
      const currentRow = alice.locator('.kh-rrow').filter({ has: alice.locator('[role="radio"][data-v="async"]') });
      await currentRow.locator(`[role="radio"][data-v="${mode}"]`).click();
      await expect(currentRow.locator('+ .kh-mode-status')).not.toContainText("Couldn't send");
      await expect.poll(async () => (await memberState())['com.khala.listening_mode'], { timeout: 30_000 }).toBe(mode);
      await expect(currentRow.locator('+ .kh-mode-status')).toBeHidden({ timeout: 30_000 });
      if (mode === 'async') {
        const currentName = (await memberState()).displayname as string;
        await currentRow.getByRole('button', { name: `Rename ${currentName}`, exact: true }).click();
        await alice.getByRole('textbox', { name: `Name for ${currentName}`, exact: true }).fill(customName);
        await alice.getByRole('button', { name: 'Rename', exact: true }).click();
        await expect.poll(async () => (await memberState()).displayname).toBe(customName);
        await alice.getByRole('button', { name: 'Close details', exact: true }).click();
      } else {
        expect((await memberState()).displayname).toBe(customName);
      }
      await alice.locator('#kh-head-btn').click();
    }
  } finally {
    try { await mcp?.close(); }
    finally { await context.close(); await rm(stateHome, { recursive: true, force: true }); }
  }
});
