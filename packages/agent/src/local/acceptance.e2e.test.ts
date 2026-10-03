/**
 * Scripted AE1–AE12 acceptance. KI-161 covers the live model/harness halves:
 * a free port replaces 47830; this driver runs Claude's CLI; helper stop/start
 * replaces reboot; content links remain unconsumed rather than testing model
 * reasoning; the production local bundle renders, while visual parity is KI-145.
 * Three quiet windows jointly cover self wake, async wake and content-link join.
 * No product code is mocked. Only the external codex queue executable is fake.
 */
import { randomBytes, createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LocalChannelCreated, LocalChannelSummary, LocalMember, ChannelSecrets } from '@khala/contracts/m1/local';
import type { AgentCredentials } from '@khala/contracts/m1/agent-join';
import type { InboxEntry } from '@khala/contracts/m1/inbox';
import { ensureStateDir, readJson, writeJsonAtomic } from '../state';
import { eventually, readEgressLog, nonLoopbackAttempts, matrixModules } from './fixtures/egress';
import { createWorld, cleanupWorld, cli, raw, admin, deliver, armClaudeWake, inbox, mode, codexCalls, helperFile,
  openBrowser, ownerOpen, McpProcess, type World } from './fixtures/e2e-harness';

const owners: Record<string, string> = { AE1: 'KI-120/KI-136/KI-137', AE2: 'KI-120/KI-121/KI-133', AE3: 'KI-121/KI-133',
  AE4: 'KI-121', AE5: 'KI-140/KI-141/KI-142/KI-143/KI-144', AE6: 'KI-121/KI-133/KI-134/KI-142',
  AE7: 'KI-134/KI-135/KI-141', AE8: 'KI-121/KI-136', AE9: 'KI-132/KI-133', AE10: 'KI-151', AE11: 'KI-131/KI-133/KI-134', AE12: 'KI-130/KI-134' };
const nonce = randomBytes(4).toString('hex');
const outputDir = path.resolve('test-results/local-e2e');
type Result = { id: string; owner: string; status: 'PASS' | 'FAIL' | 'BLOCKED'; durationMs: number; error?: string };
const results: Result[] = [];
let world: World;
let channel: LocalChannelCreated;
let claudeId: string;
let codexId: string;
let probe: McpProcess;
let failed = false;
let contentLink: string;
const sentBodies: string[] = [];
const message = (name: string) => `${name}-${nonce}`;
const context = (id: string) => `${id} (${owners[id]})`;
const enc = encodeURIComponent;
const channelPath = () => `/api/local/channels/${enc(channel.roomId)}`;
const roomDir = () => path.join(world.state, 'khala/local/channels', channel.roomId.slice(1, -6));
const toolData = <T>(result: { structuredContent?: unknown }): T => result.structuredContent as T;
const frameText = (frame: unknown) => JSON.stringify(frame);
async function members(): Promise<LocalMember[]> {
  const response = await admin(world, 'GET', channelPath());
  expect(response.status, 'owner channel route (KI-134)').toBe(200);
  return (response.body as LocalChannelSummary & { members: LocalMember[] }).members;
}
async function send(agent: McpProcess, name: string) {
  const text = message(name);
  const result = await agent.call('khala_send', { text });
  expect(toolData<{ eventId?: string }>(result).eventId?.startsWith('$'), `${name} send (KI-121/KI-133)`).toBe(true);
  sentBodies.push(text);
  return text;
}
async function received(agent: McpProcess, body: string): Promise<InboxEntry> {
  await eventually(async () => (await inbox(agent)).some(entry => entry.body.includes(body)));
  const entries = (await inbox(agent)).filter(entry => entry.body.includes(body));
  expect(entries.length, 'inbox exactly once (KI-121/KI-133)').toBe(1);
  return entries[0]!;
}
async function setMode(agent: McpProcess, label: string, next: 'steer' | 'sync' | 'async') {
  const page = world.page!;
  await page.getByRole('button', { name: new RegExp(`^Listening mode for ${label}:`) }).click();
  await page.getByRole('menuitemradio', { name: new RegExp(`^${next}`, 'i') }).click();
  await eventually(async () => await mode(agent) === next && (await members()).find(member => member.userId === (agent === world.claude ? claudeId : codexId))?.listeningMode === next);
  expect(await page.getByRole('button', { name: new RegExp(`^Listening mode for ${label}: ${next}`, 'i') }).count(), 'confirmed roster mode (KI-142)').toBe(1);
}
async function profileDialog() {
  const page = world.page!;
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Profile/ }).click();
  return page.getByRole('dialog', { name: 'Profile', exact: true });
}
async function screenshot(name: string) {
  // Content can include share links in AE9. Mask whole message bodies with links,
  // and any join/open href, so evidence never persists credentials.
  await world.page!.screenshot({ path: path.join(outputDir, name), fullPage: true,
    mask: [world.page!.getByText(/http:\/\/127\.0\.0\.1:\d+\/(?:join|open)\//), world.page!.locator('a[href*="/join/"],a[href*="/open/"]')] });
}
function acceptance(id: string, name: string, run: () => Promise<void>) {
  it(`${id} ${name}`, async test => {
    const start = Date.now();
    if (failed) { results.push({ id, owner: owners[id]!, status: 'BLOCKED', durationMs: 0 }); test.skip(); return; }
    const result: Result = { id, owner: owners[id]!, status: 'FAIL', durationMs: 0 };
    try { await run(); result.status = 'PASS'; }
    catch (error) {
      failed = true;
      // Do not forward assertion diffs: those can contain tokens or complete links.
      const knownFailure = error instanceof Error && /^(?:helper_unavailable|web_not_built|eventually_timeout|claude_wake_exited_before_armed|mcp_rpc_timeout)$/.test(error.message) ? `: ${error.message}` : '';
      result.error = `${context(id)} failed${knownFailure}; inspect the failing assertion locally`;
      throw new Error(result.error, { cause: error instanceof Error ? new Error(error.name) : undefined });
    } finally { result.durationMs = Date.now() - start; results.push(result); }
  }, 45_000);
}

describe.skipIf(process.env.KHALA_LOCAL_E2E !== '1')('local product acceptance AE1–AE12', () => {
  beforeAll(async () => { await mkdir(outputDir, { recursive: true }); world = await createWorld(); }, 120_000);
  afterAll(async () => {
    try { if (world) await cleanupWorld(world); }
    finally {
      await mkdir(outputDir, { recursive: true });
      await writeFile(path.join(outputDir, 'results.json'), JSON.stringify({ version: 1, results, durationMs: results.reduce((sum, row) => sum + row.durationMs, 0) }, null, 2) + '\n');
      process.stdout.write('\nAE    Result    Duration  Owner\n' + results.map(row =>
        `${row.id.padEnd(6)}${row.status.padEnd(10)}${`${row.durationMs}ms`.padEnd(10)}${row.owner}`
      ).join('\n') + '\n');
    }
  }, 30_000);

  acceptance('AE1', 'create starts a guarded helper and Claude joins', async () => {
    expect((await cli(world, 'status')).data, context('AE1')).toMatchObject({ running: false });
    const created = await cli(world, 'create', 'refactor');
    if (created.code !== 0 && (created.data as { error?: string } | undefined)?.error === 'helper_unavailable') throw new Error('helper_unavailable');
    expect(created.code, context('AE1')).toBe(0);
    channel = created.data as LocalChannelCreated;
    expect(channel.roomId, context('AE1')).toMatch(/^![A-Za-z0-9_-]{22}:local$/);
    expect(channel.name, context('AE1')).toBe('refactor');
    for (const link of [channel.selfLink, channel.shareLink]) expect(new RegExp(`^${world.origin.replaceAll('.', '\\.')}/join/[A-Za-z0-9_-]{43}$`).test(link), context('AE1')).toBe(true);
    expect(channel.selfLink !== channel.shareLink, context('AE1')).toBe(true);
    expect(new RegExp(`^${world.origin.replaceAll('.', '\\.')}/open/[A-Za-z0-9_-]{43}$`).test(channel.openUrl), context('AE1')).toBe(true);
    const status = (await cli(world, 'status')).data as { running: boolean; pid: number };
    expect(status.running, context('AE1')).toBe(true);
    expect((await readEgressLog(world.log)).some(record => record.kind === 'guard' && record.event === 'installed' && record.pid === status.pid && record.argv.includes('serve')), context('AE1')).toBe(true);
    const joined = await world.claude.call('khala_join', { link: channel.selfLink });
    expect(toolData(joined), context('AE1')).toMatchObject({ state: 'connected', channelName: 'refactor' });
    expect(joined.content, context('AE1')).toContainEqual({ type: 'text', text: 'Connected to refactor.' });
  });
  acceptance('AE2', 'Codex joins without browser and announces its membership', async () => {
    expect(world.browser, context('AE2')).toBeUndefined();
    const joined = await world.codex.call('khala_join', { link: channel.shareLink });
    expect(toolData(joined), context('AE2')).toMatchObject({ state: 'connected', channelName: 'refactor' });
    expect(joined.content, context('AE2')).toContainEqual({ type: 'text', text: 'Connected to refactor.' });
    const roster = await members();
    expect(roster.map(member => member.displayName).sort(), context('AE2')).toEqual(['kevin', 'kevin-Claude', 'kevin-Codex']);
    for (const [agent, harness] of [[world.claude, 'claude'], [world.codex, 'codex']] as const) {
      const status = toolData<{ state: string; agentUserId: string }>(await agent.call('khala_status', {}));
      expect(status.state, context('AE2')).toBe('connected');
      expect(status.agentUserId, context('AE2')).toMatch(/^@agent-[0-9a-f]{8}:local$/);
      expect(roster.find(member => member.userId === status.agentUserId), context('AE2')).toMatchObject({ kind: 'agent', harness });
      if (harness === 'claude') claudeId = status.agentUserId; else codexId = status.agentUserId;
    }
    expect((await received(world.claude, 'kevin-Codex joined')).kind, context('AE2')).toBe('event');
  });
  acceptance('AE3', 'messages are attributed, ordered, unique and exclude self', async () => {
    const ping = await send(world.claude, 'ae3-ping');
    expect(await received(world.codex, ping), context('AE3')).toMatchObject({ senderLabel: 'kevin-Claude', senderKind: 'agent' });
    const read = toolData<{ messages: InboxEntry[] }>(await world.codex.call('khala_read', { limit: 30 }));
    expect(read.messages.at(-1)?.body, context('AE3')).toBe(ping);
    expect(await received(world.claude, await send(world.codex, 'ae3-pong')), context('AE3')).toMatchObject({ senderLabel: 'kevin-Codex' });
    const a = await send(world.claude, 'ae3-a'); const b = await send(world.claude, 'ae3-b');
    await received(world.codex, b);
    expect((await inbox(world.codex)).filter(entry => entry.body === a || entry.body === b).map(entry => entry.body), context('AE3')).toEqual([a, b]);
    for (const [agent, id] of [[world.claude, claudeId], [world.codex, codexId]] as const) {
      const entries = await inbox(agent);
      expect(new Set(entries.map(entry => entry.eventId)).size, context('AE3')).toBe(entries.length);
      expect(entries.some(entry => entry.sender === id), context('AE3')).toBe(false);
    }
  });
  acceptance('AE4', 'real idle watchers wake and own messages do not wake', async () => {
    await deliver(world.claude, 'UserPromptSubmit');
    expect(await deliver(world.claude, 'Stop'), context('AE4')).toBeNull();
    const wake = await armClaudeWake(world.claude);
    const body = await send(world.codex, 'ae4-wake-claude');
    const woke = await wake.exited;
    expect(woke.code, context('AE4')).toBe(2);
    expect(woke.stderr, context('AE4')).toBe('Khala: new channel messages. They arrive in the next hook context.\n');
    const frame = frameText(await deliver(world.claude, 'UserPromptSubmit'));
    expect(frame, context('AE4')).toContain('channel=\\"refactor\\"');
    expect(frame, context('AE4')).toContain(`kevin-Codex (agent): ${body}`);
    expect(await deliver(world.claude, 'Stop'), context('AE4')).toBeNull();
    const own = await armClaudeWake(world.claude);
    await send(world.claude, 'ae4-self');
    // Quiet window 1: own Claude message cannot wake Claude.
    await new Promise(resolve => setTimeout(resolve, 3000));
    expect(own.running, context('AE4')).toBe(true); own.kill();
    expect((await own.exited).code, context('AE4')).not.toBe(2);
    await deliver(world.codex, 'UserPromptSubmit');
    expect(await deliver(world.codex, 'Stop'), context('AE4')).toBeNull();
    const before = (await codexCalls(world)).length;
    const codexWake = await send(world.claude, 'ae4-wake-codex');
    await eventually(async () => (await codexCalls(world)).length === before + 1);
    expect((await codexCalls(world)).at(-1), context('AE4')).toBe('queue --thread e2e-codex --message Khala: channel messages are waiting. Continue.');
    expect(frameText(await deliver(world.codex, 'UserPromptSubmit')), context('AE4')).toContain(`kevin-Claude (agent): ${codexWake}`);
    expect(await deliver(world.codex, 'Stop'), context('AE4')).toBeNull();
    const selfBefore = (await codexCalls(world)).length;
    await send(world.codex, 'ae4-self-codex');
    // Quiet window 2: own Codex message cannot queue Codex.
    await new Promise(resolve => setTimeout(resolve, 3000));
    expect((await codexCalls(world)).length, context('AE4')).toBe(selfBefore);
  });
  acceptance('AE5', 'the owner uses the actual local browser app and wakes both agents', async () => {
    const page = await openBrowser(world);
    const response = await page.goto(channel.openUrl);
    if (response?.status() === 503) throw new Error('web_not_built');
    expect(response?.status(), context('AE5')).toBeLessThan(400);
    expect(new URL(page.url()).pathname, context('AE5')).toBe(`/channels/${enc(channel.roomId)}`);
    expect(await page.getByRole('button', { name: /sign in/i }).count(), context('AE5')).toBe(0);
    await page.getByRole('heading', { level: 1, name: 'refactor', exact: true }).waitFor();
    for (const name of ['ae3-ping', 'ae3-pong']) await page.getByText(message(name), { exact: true }).waitFor();
    await page.getByText('kevin-Codex joined', { exact: true }).first().waitFor();
    for (const name of ['kevin-Claude', 'kevin-Codex']) await page.getByRole('button', { name: new RegExp(`^Listening mode for ${name}:`) }).waitFor();
    await page.goto(`${world.origin}/conversations`);
    await page.getByText('refactor', { exact: true }).first().waitFor();
    await page.goto(`${world.origin}/channels/${enc(channel.roomId)}`);
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    expect(await page.getByRole('menuitem', { name: /Profile.*@kevin/ }).count(), context('AE5')).toBe(1);
    expect(await page.getByRole('menuitem', { name: /Log out/ }).count(), context('AE5')).toBe(0);
    await page.keyboard.press('Escape');
    await deliver(world.claude, 'UserPromptSubmit'); await deliver(world.codex, 'UserPromptSubmit');
    expect(await deliver(world.claude, 'Stop'), context('AE5')).toBeNull();
    expect(await deliver(world.codex, 'Stop'), context('AE5')).toBeNull();
    const wake = await armClaudeWake(world.claude); const queues = (await codexCalls(world)).length;
    const composer = page.getByRole('combobox', { name: 'Message', exact: true });
    await composer.fill('@kevin-Co');
    await page.getByRole('listbox', { name: 'Mention suggestions' }).getByRole('option', { name: /kevin-Codex/ }).click();
    await composer.press('End'); await composer.pressSequentially(` ${message('ae5-human')}`);
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    expect(await received(world.codex, message('ae5-human')), context('AE5')).toMatchObject({ senderKind: 'human', senderLabel: 'kevin' });
    expect((await wake.exited).code, context('AE5')).toBe(2);
    await eventually(async () => (await codexCalls(world)).length > queues);
    await page.setViewportSize({ width: 1280, height: 900 }); await screenshot('ae5-channel-1280.png');
    await page.setViewportSize({ width: 390, height: 844 }); await screenshot('ae5-channel-390.png');
    await page.setViewportSize({ width: 1280, height: 900 });
    await deliver(world.claude, 'UserPromptSubmit'); await deliver(world.codex, 'UserPromptSubmit');
  });
  acceptance('AE6', 'owner mode commands are confirmed and hook boundaries obey them', async () => {
    await setMode(world.claude, 'kevin-Claude', 'steer');
    await screenshot('ae6-roster-steer.png');
    await received(world.claude, await send(world.codex, 'ae6-steer'));
    const steer = await deliver(world.claude, 'PostToolUse');
    expect(steer, context('AE6')).toMatchObject({ hookSpecificOutput: { hookEventName: 'PostToolUse' } });
    expect(frameText(steer), context('AE6')).toContain(message('ae6-steer'));
    await setMode(world.claude, 'kevin-Claude', 'sync');
    await received(world.claude, await send(world.codex, 'ae6-sync'));
    expect(await deliver(world.claude, 'PostToolUse'), context('AE6')).toBeNull();
    const sync = await deliver(world.claude, 'Stop');
    expect(sync, context('AE6')).toMatchObject({ decision: 'block' });
    expect(frameText(sync), context('AE6')).toContain(message('ae6-sync'));
    await setMode(world.claude, 'kevin-Claude', 'async');
    await setMode(world.codex, 'kevin-Codex', 'async');
    expect(await deliver(world.claude, 'Stop'), context('AE6')).toBeNull();
    expect(await deliver(world.codex, 'Stop'), context('AE6')).toBeNull();
    const wake = await armClaudeWake(world.claude); const queues = (await codexCalls(world)).length;
    await received(world.claude, await send(world.codex, 'ae6-async'));
    await received(world.codex, await send(world.claude, 'ae6-codex-async'));
    contentLink = ((await cli(world, 'link', 'refactor')).data as { shareLink: string }).shareLink;
    const rosterBefore = (await members()).map(member => member.userId).sort();
    await world.page!.getByRole('combobox', { name: 'Message', exact: true }).fill(`join me: ${contentLink}`);
    await world.page!.getByRole('button', { name: 'Send', exact: true }).click();
    // Quiet window 3 combines both async watchers and the AE9 content-link rule.
    await new Promise(resolve => setTimeout(resolve, 3000));
    expect(wake.running, context('AE6')).toBe(true); wake.kill();
    expect((await wake.exited).code, context('AE6')).not.toBe(2);
    expect((await codexCalls(world)).length, context('AE6')).toBe(queues);
    expect((await members()).map(member => member.userId).sort(), context('AE9')).toEqual(rosterBefore);
    expect(await deliver(world.claude, 'UserPromptSubmit'), context('AE6')).toBeNull();
    expect(await deliver(world.claude, 'PostToolUse'), context('AE6')).toBeNull();
    expect(toolData<{ messages: InboxEntry[] }>(await world.claude.call('khala_read', {})).messages.some(entry => entry.body === message('ae6-async')), context('AE6')).toBe(true);
    await send(world.claude, 'ae6-async-reply');
    await setMode(world.claude, 'kevin-Claude', 'sync');
    expect(await deliver(world.claude, 'UserPromptSubmit'), context('AE6')).toBeNull();
    await setMode(world.codex, 'kevin-Codex', 'sync');
  });
  acceptance('AE7', 'profile and roster rename persist through reload and restart', async () => {
    let dialog = await profileDialog();
    await dialog.getByRole('textbox', { name: 'Username', exact: true }).fill('kev');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    async function names() { return (await members()).map(member => member.displayName); }
    // Poll actual member state; profile updates cascade to default agent names.
    await eventually(async () => { const current = await names(); return ['kev', 'kev-Claude', 'kev-Codex'].every(name => current.includes(name)); });
    expect((await received(world.claude, await send(world.codex, 'ae7-name'))).senderLabel, context('AE7')).toBe('kev-Codex');
    const before = (await admin(world, 'GET', '/api/local/profile')).body as { color: string; initials: string };
    dialog = await profileDialog();
    const radios = dialog.getByRole('radiogroup', { name: 'Color' }).getByRole('radio');
    let selectedLabel = '';
    for (let index = 0; index < await radios.count(); index++) if (await radios.nth(index).getAttribute('aria-checked') !== 'true') { selectedLabel = (await radios.nth(index).getAttribute('aria-label'))!; await radios.nth(index).click(); break; }
    expect(selectedLabel.length > 0, context('AE7')).toBe(true);
    await dialog.getByRole('textbox', { name: 'Initials', exact: true }).fill('KW');
    await screenshot('ae7-settings.png');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    const profile = (await admin(world, 'GET', '/api/local/profile')).body as { color: string; initials: string };
    expect(profile.color !== before.color, context('AE7')).toBe(true); expect(profile.initials, context('AE7')).toBe('KW');
    await world.page!.getByRole('button', { name: 'Rename kev-Codex', exact: true }).click();
    await world.page!.getByRole('textbox', { name: 'Name for kev-Codex', exact: true }).fill('reviewer');
    await world.page!.getByRole('button', { name: 'Rename', exact: true }).click();
    await eventually(async () => (await names()).includes('reviewer'));
    expect((await received(world.claude, await send(world.codex, 'ae7-renamed'))).senderLabel, context('AE7')).toBe('reviewer');
    await world.page!.reload();
    await world.page!.getByRole('button', { name: /^Listening mode for reviewer:/ }).waitFor();
    await world.page!.getByRole('button', { name: /^Listening mode for kev-Claude:/ }).waitFor();
    expect((await cli(world, 'stop')).data, context('AE7')).toMatchObject({ stopped: true });
    expect((await cli(world, 'status')).data, context('AE7')).toMatchObject({ running: false });
    await ownerOpen(world, world.page!, 'refactor');
    expect((await admin(world, 'GET', '/api/local/profile')).body, context('AE7')).toMatchObject({ username: 'kev', color: profile.color, initials: 'KW' });
    expect((await names()).sort(), context('AE7')).toEqual(['kev', 'kev-Claude', 'reviewer']);
    await world.page!.getByRole('button', { name: 'Settings', exact: true }).click();
    expect(await world.page!.getByRole('menuitem', { name: /Profile.*@kev/ }).count(), context('AE7')).toBe(1);
    await world.page!.keyboard.press('Escape');
  });
  acceptance('AE9', 'single-use and expired links fail while browser GET preserves a link', async () => {
    probe = await McpProcess.start(world, 'claude', 'e2e-probe'); world.probe = probe;
    expect(toolData(await probe.call('khala_join', { link: channel.selfLink })), context('AE9')).toEqual({ error: 'link_unavailable' });
    const expired = ((await cli(world, 'link', 'refactor')).data as { shareLink: string }).shareLink;
    await cli(world, 'stop');
    const secretsPath = path.join(roomDir(), 'secrets.json');
    const secrets = (await readJson<ChannelSecrets>(secretsPath))!;
    const hash = (link: string) => createHash('sha256').update(new URL(link).pathname.split('/').at(-1)!).digest('hex');
    secrets.links[hash(expired)]!.expiresAt = '2000-01-01T00:00:00.000Z';
    await writeJsonAtomic(secretsPath, secrets);
    await cli(world, 'list');
    expect(toolData(await probe.call('khala_join', { link: expired })), context('AE9')).toEqual({ error: 'link_unavailable' });
    await ownerOpen(world, world.page!, 'refactor');
    const untouched = ((await cli(world, 'link', 'refactor')).data as { shareLink: string }).shareLink;
    expect((await world.page!.goto(untouched))?.status(), context('AE9')).toBe(200);
    await eventually(async () => (await world.page!.locator('#root').textContent())!.length > 0);
    await world.page!.goto(`${world.origin}/channels/${enc(channel.roomId)}`);
    expect(toolData(await probe.call('khala_join', { link: untouched })), context('AE9')).toMatchObject({ state: 'connected', channelName: 'refactor' });
    expect((await members()).some(member => member.displayName === 'kev-Claude-2'), context('AE9')).toBe(true);
    // AE6's third quiet window posted this link and proved membership unchanged.
    expect((await readJson<ChannelSecrets>(secretsPath))!.links[hash(contentLink)]!.consumedAt, context('AE9')).toBeUndefined();
  });
  acceptance('AE11', 'permissions, host, origin and membership boundaries hold', async () => {
    for (const dir of [path.join(world.state, 'khala/local'), roomDir()]) expect((await stat(dir)).mode & 0o777, context('AE11')).toBe(0o700);
    for (const file of [path.join(world.state, 'khala/local/helper.json'), path.join(world.state, 'khala/local/owner.json'), path.join(roomDir(), 'log.jsonl'), path.join(roomDir(), 'secrets.json')]) expect((await stat(file)).mode & 0o777, context('AE11')).toBe(0o600);
    await ensureStateDir(roomDir());
    expect(await raw(world, { method: 'GET', path: '/healthz', headers: { host: `evil.example:${world.port}` } }), context('AE11')).toMatchObject({ status: 421, body: { error: 'misdirected' } });
    const open = ((await cli(world, 'open', 'refactor')).data as { openUrl: string }).openUrl;
    const opened = await raw(world, { method: 'GET', path: new URL(open).pathname });
    const setCookie = opened.headers['set-cookie'];
    const cookie = String(Array.isArray(setCookie) ? setCookie[0]! : setCookie!).split(';')[0]!;
    for (const headers of [{ cookie }, { cookie, 'x-khala-local': '1', origin: 'http://evil.example' }]) expect(await raw(world, { method: 'POST', path: `${channelPath()}/links`, headers, body: {} }), context('AE11')).toMatchObject({ status: 403, body: { error: 'forbidden_origin' } });
    expect((await raw(world, { method: 'POST', path: `${channelPath()}/links`, headers: { cookie, 'x-khala-local': '1', origin: world.origin }, body: {} })).status, context('AE11')).toBe(200);
    const credentials = (await readJson<AgentCredentials>(world.claude.files.session))!;
    for (const [method, requestPath] of [['GET', '/api/local/channels'], ['POST', `${channelPath()}/links`]] as const) expect(await raw(world, { method, path: requestPath, headers: { authorization: `Bearer ${credentials.accessToken}` }, body: {} }), context('AE11')).toMatchObject({ status: 403, body: { error: 'forbidden' } });
    const probeCredentials = (await readJson<AgentCredentials>(probe.files.session))!;
    expect((await admin(world, 'DELETE', `${channelPath()}/members/${enc(probeCredentials.userId)}`)).status, context('AE11')).toBe(204);
    expect(await raw(world, { method: 'GET', path: `/api/local/rooms/${enc(channel.roomId)}/members`, headers: { authorization: `Bearer ${probeCredentials.accessToken}` } }), context('AE11')).toMatchObject({ status: 403, body: { error: 'not_member' } });
    expect(toolData(await probe.call('khala_send', { text: 'x' })), context('AE11')).toEqual({ error: 'send_failed' });
    expect((await received(world.claude, 'kev-Claude-2 left')).kind, context('AE11')).toBe('event');
    const logs = [await readFile(path.join(world.state, 'khala/local/helper.log'), 'utf8'), world.claude.stderr, world.codex.stderr, probe.stderr].join('\n');
    const helper = (await helperFile(world))!;
    for (const secret of [helper.adminToken, credentials.accessToken, probeCredentials.accessToken, cookie.split('=').slice(1).join('='), ...sentBodies]) expect(logs.includes(secret), context('AE11')).toBe(false);
  });
  acceptance('AE8', 'agent reconnection restarts a killed helper without replay or cursor loss', async () => {
    await received(world.codex, await send(world.claude, 'ae8-before'));
    const agents = [world.claude, world.codex];
    const before = await Promise.all(agents.map(async agent => ({ lines: await readFile(agent.files.inbox, 'utf8'), cursor: await readFile(agent.files.cursor, 'utf8') })));
    const killed = (await helperFile(world))!.pid; process.kill(killed, 'SIGKILL');
    // No CLI until the agent-owned LocalSession has respawned the helper.
    await eventually(async () => { try { const helper = (await helperFile(world))!; if (helper.pid === killed) return false; const health = await raw(world, { method: 'GET', path: '/healthz' }); return health.status === 200 && (health.body as { pid: number }).pid === helper.pid; } catch { return false; } }, 15_000);
    const restarted = (await helperFile(world))!.pid;
    expect((await readEgressLog(world.log)).some(record => record.kind === 'guard' && record.event === 'installed' && record.pid === restarted && record.argv.includes('serve')), context('AE8')).toBe(true);
    await received(world.claude, await send(world.codex, 'ae8-after'));
    for (let index = 0; index < agents.length; index++) {
      const agent = agents[index]!;
      expect((await readFile(agent.files.inbox, 'utf8')).startsWith(before[index]!.lines), context('AE8')).toBe(true);
      expect(await readFile(agent.files.cursor, 'utf8'), context('AE8')).toBe(before[index]!.cursor);
      const entries = await inbox(agent); expect(new Set(entries.map(entry => entry.eventId)).size, context('AE8')).toBe(entries.length);
    }
    const history = toolData<{ messages: InboxEntry[] }>(await world.claude.call('khala_read', { limit: 100 })).messages.map(entry => entry.body);
    expect(history.filter(body => sentBodies.includes(body)), context('AE8')).toEqual(sentBodies);
    await ownerOpen(world, world.page!, 'refactor'); await world.page!.getByText(message('ae8-after'), { exact: true }).waitFor();
  });
  acceptance('AE12', 'restart preserves the channel and delete removes storage and ends membership', async () => {
    const listed = (await cli(world, 'list')).data as { channels: LocalChannelSummary[] };
    const seq = listed.channels.find(item => item.roomId === channel.roomId)!.lastSeq;
    await cli(world, 'stop');
    const restarted = (await cli(world, 'list')).data as { channels: LocalChannelSummary[] };
    expect(restarted.channels.find(item => item.roomId === channel.roomId)?.lastSeq, context('AE12')).toBe(seq);
    await ownerOpen(world, world.page!, 'refactor');
    expect((await cli(world, 'delete', 'refactor')).data, context('AE12')).toEqual({ deleted: channel.roomId });
    expect(existsSync(roomDir()), context('AE12')).toBe(false);
    for (const agent of [world.claude, world.codex]) await eventually(async () => toolData<{ error: string }>(await agent.call('khala_send', { text: 'x' })).error === 'send_failed');
    await world.page!.goto(`${world.origin}/conversations`);
    await eventually(async () => await world.page!.getByText('refactor', { exact: true }).count() === 0, 30_000);
    await screenshot('ae12-after-delete.png');
  });
  acceptance('AE10', 'all processes and the actual browser have zero non-loopback egress', async () => {
    const records = await readEgressLog(world.log);
    expect(nonLoopbackAttempts(records).length, context('AE10')).toBe(0);
    expect(matrixModules(records).length, context('AE10')).toBe(0);
    const installed = records.filter(record => record.kind === 'guard' && record.event === 'installed');
    for (const terms of [['mcp', 'claude'], ['mcp', 'codex'], ['hook', 'deliver'], ['hook', 'claude-wake'], ['local', 'create']]) expect(installed.some(record => record.kind === 'guard' && record.event === 'installed' && terms.every(term => record.argv.includes(term))), context('AE10')).toBe(true);
    expect(new Set(installed.filter(record => record.kind === 'guard' && record.event === 'installed' && record.argv.includes('serve')).map(record => record.pid)).size, context('AE10')).toBeGreaterThanOrEqual(2);
    expect(world.blocked.length, context('AE10')).toBe(0);
    expect(world.requests.length, context('AE10')).toBeGreaterThan(0);
    for (const request of world.requests) { const url = new URL(request); expect(url.origin === world.origin || ['data:', 'blob:'].includes(url.protocol), context('AE10')).toBe(true); expect(/\/api\/human\/|\/_matrix\/|khala\.aiur\.team|google|gstatic/i.test(request), context('AE10')).toBe(false); }
    for (const agent of [world.claude, world.codex]) expect(records.some(record => record.kind === 'tcp' && record.pid === agent.pid && record.host === '127.0.0.1' && record.port === world.port), context('AE10')).toBe(true);
  });
});
