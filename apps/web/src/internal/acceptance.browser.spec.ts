// Browser acceptance for the internal channel (AC2): the production local bundle
// served by the real `khala internal` runtime, driven in Chromium. The owner
// works only in the browser; the agents are externally started CLI sessions
// (see fixtures/acceptance.ts). Covers create and confirm, grants, agent
// exchange, the human message, listening-mode delivery, the owner's mode and pause
// controls, Stop and the view it
// leaves, launcher close and `khala internal --resume`, with keyboard, focus and
// announcement checks along the way.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from '@playwright/test';
import { build } from 'vite';
import { AgentSession, freePort, internalRootOf, khala, startLauncher, type RunningLauncher } from './fixtures/acceptance';

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const focused = (page: Page) => page.evaluate(() => document.activeElement?.textContent?.trim() ?? '');
const rowWith = (page: Page, text: string) => page.locator('.timeline__row:not(.timeline__row--pending)', { hasText: text });

/** The owner approves the one pending request from `agent` in the inbox, by keyboard only. */
async function approveByKeyboard(page: Page, origin: string, agent: string, dialogName: RegExp | string, approve: string) {
  await page.getByRole('link', { name: /Channel requests/ }).click();
  await page.waitForURL(`${origin}/channel-requests`);
  const row = page.locator('.channel-requests__row', { hasText: agent });
  await row.waitFor();
  const review = row.getByRole('button', { name: 'Review request' });
  await review.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: dialogName });
  await dialog.waitFor();
  assert.equal(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]'))), true, 'focus moves into the dialog');
  const approveButton = dialog.getByRole('button', { name: approve });
  // Tab to the approve action rather than clicking it.
  for (let step = 0; step < 12 && !(await approveButton.evaluate(node => node === document.activeElement)); step += 1) {
    await page.keyboard.press('Tab');
  }
  assert.equal(await approveButton.evaluate(node => node === document.activeElement), true, `${approve} is reachable by Tab`);
  await page.keyboard.press('Enter');
  await dialog.locator('.decision-dialog__status').getByText(/^Approved\./).waitFor();
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('channel-requests__row') ?? false), true,
    'focus returns to the decided request');
}

/** A binding's own pull of its releases, exactly as the agent CLI's delivery makes it. */
async function pullReleases(agent: AgentSession, origin: string) {
  const { channelId, bindingCapability } = agent.granted();
  const response = await fetch(`${origin}/api/v1/channels/${channelId}/releases`, { headers: { authorization: `Bearer ${bindingCapability}` } });
  return { status: response.status, body: response.status === 200 ? await response.json() as { releases: Array<{ wake: boolean; events: Array<{ eventId: string }> }> } : null };
}

async function reachable(origin: string): Promise<boolean> {
  try {
    await fetch(`${origin}/__khala/bootstrap`, { signal: AbortSignal.timeout(2_000) });
    return true;
  } catch {
    return false;
  }
}

test('internal channel acceptance: create, grants, exchange, human message, modes, Stop, launcher close and resume', { timeout: 300_000 }, async () => {
  const base = fs.realpathSync(fs.mkdtempSync('/tmp/khala-acceptance-'));
  const chromiumProfileRoot = fs.mkdtempSync('/tmp/khala-acceptance-profile-');
  const bundleDirectory = path.join(base, 'internal-web');
  const ownerHome = path.join(base, 'owner-state');
  fs.mkdirSync(ownerHome, { mode: 0o700 });
  let launcher: RunningLauncher | undefined;
  let browser: Browser | undefined;
  try {
    await build({ configFile: path.join(webRoot, 'vite.internal.config.mjs'), logLevel: 'silent', build: { outDir: bundleDirectory, emptyOutDir: true } });

    // Create: `khala internal` makes one private channel and serves it. Both launches
    // share one port so resume keeps the origin, as the default port does for a user.
    const port = await freePort();
    launcher = await startLauncher([], { stateHome: ownerHome, bundleDirectory, startPort: port });
    const { channelId, origin, url } = launcher.report;
    assert.match(launcher.report.resumeCommand, new RegExp(`^khala internal --resume ${channelId}$`));

    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
      headless: true,
      args: ['--no-sandbox'],
      env: { ...process.env, TMPDIR: chromiumProfileRoot },
    });
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
    const violations: string[] = [];
    page.on('console', entry => {
      if (/Content Security Policy|Refused to/i.test(entry.text())) violations.push(entry.text());
    });

    await page.goto(url);
    await page.waitForURL(`${origin}/channels/${channelId}`);
    await page.getByText('No messages yet.').waitFor();
    await page.getByRole('heading', { name: 'Local channel' }).waitFor();
    const channelText = await page.locator('body').innerText();
    assert.match(channelText, /channel/i);
    assert.doesNotMatch(channelText, /\broom\b/i, 'the UI says channel, never room');

    // Two externally started agent sessions ask for access through the channel URL.
    const channelUrl = `${origin}/channels/${channelId}`;
    const agent = (name: string, harness: string) => AgentSession.start({
      name, harness, sessionId: `session-${name.toLowerCase()}`, launcherStateHome: ownerHome,
      stateHome: path.join(base, `${name.toLowerCase()}-state`), bundleDirectory,
    });
    const ada = await agent('Ada', 'codex');
    const bea = await agent('Bea', 'claude');
    assert.equal(await ada.join(channelUrl), 'pending_owner');
    assert.equal(await bea.join(channelUrl), 'pending_owner');
    // Nothing is granted before the owner decides.
    assert.equal((await ada.send('too early')).code, 3, 'an ungranted agent cannot post');

    // Grants: the owner approves each request in the inbox, by keyboard.
    await approveByKeyboard(page, origin, 'Ada', /Let this agent session join/, 'Approve access');
    await approveByKeyboard(page, origin, 'Bea', /Let this agent session join/, 'Approve access');
    assert.equal(await ada.join(channelUrl), 'connected');
    assert.equal(await bea.join(channelUrl), 'connected');
    await page.getByRole('heading', { name: /Waiting for you \(0\)/ }).waitFor();

    // Confirm: an agent's channel-creation request creates nothing until the owner confirms it.
    const createOperation = 'op-acceptance-create';
    const creator = ada.channelCreate();
    const requested = await creator.request({ title: 'Ada scratch', operationId: createOperation, origin: null });
    assert.deepEqual(requested.ok && requested.outcome, 'pending_owner');
    await approveByKeyboard(page, origin, 'Ada scratch', 'Create a secret channel for this agent session?', 'Approve and create');
    const confirmed = await creator.status({ operationId: createOperation, origin: null });
    assert.ok(confirmed.ok && confirmed.outcome !== 'pending_owner', `the confirmed create advanced: ${JSON.stringify(confirmed)}`);

    // Exchange: Ada writes, Bea reads it exactly once and answers, and the owner sees both, attributed.
    await page.goto(channelUrl);
    await page.getByRole('heading', { name: 'Local channel' }).waitFor();
    assert.equal((await ada.send('Ada: hello Bea')).code, 0);
    assert.deepEqual(await bea.readAll(), ['Ada: hello Bea']);
    assert.deepEqual(await bea.readAll(), [], 'a read message is not delivered again');
    assert.equal((await bea.send('Bea: hello Ada')).code, 0);
    assert.deepEqual(await ada.readAll(), ['Bea: hello Ada']);
    await rowWith(page, 'Bea: hello Ada').waitFor();
    const rows = await page.locator('.timeline__row').allInnerTexts();
    assert.ok(rows.some(row => row.includes('Ada') && row.includes('Ada: hello Bea')), rows.join('\n'));
    assert.ok(rows.some(row => row.includes('Bea') && row.includes('Bea: hello Ada')), rows.join('\n'));

    // Human message: typed and sent by keyboard, then read once by each agent.
    const composer = page.getByRole('textbox', { name: 'Message' });
    await composer.focus();
    await page.keyboard.type('Owner: both of you, please hold');
    await page.keyboard.press('Tab');
    assert.equal(await focused(page), 'Send', 'Send follows the composer in tab order');
    await page.keyboard.press('Enter');
    await rowWith(page, 'Owner: both of you, please hold').waitFor();
    assert.deepEqual(await ada.readAll(), ['Owner: both of you, please hold']);
    assert.deepEqual(await bea.readAll(), ['Owner: both of you, please hold']);

    // Modes: in the default (sync) mode a human message may wake the agent; another
    // agent's message never does, because nothing bounds agent-to-agent wake loops.
    const pulled = await pullReleases(ada, origin);
    assert.equal(pulled.status, 200);
    const wakes = pulled.body!.releases.map(release => release.wake);
    assert.deepEqual(wakes, [false, true], 'Bea’s message does not wake Ada; the owner’s does');

    // Listening modes in the owner's panel. Ada's Codex CLI reports its installed version and
    // hook trust, exactly the observation its `khala` calls send; the server derives the
    // released claim from it. Bea's Claude has no proven route, so nothing is offered for her.
    const ada$ = ada.granted();
    const reported = await fetch(`${origin}/api/v1/agent/harness`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ada$.bindingCapability}`, 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1, version: '0.156.1', hookReview: 'trusted' }),
    });
    assert.equal(reported.status, 200);
    await page.reload();
    await page.getByRole('heading', { name: 'Listening modes' }).waitFor();
    const modeStatus = page.locator('.listening-control__status[role="status"]');

    // Supported: Ada's sync is in effect; the owner moves her to steer by keyboard and hears it.
    const adaModes = page.getByRole('group', { name: 'Listening mode for Ada' });
    await adaModes.waitFor();
    const adaAgent = page.locator('.listening-control__agent', { has: adaModes });
    await adaAgent.getByText('In effect: Sync.').waitFor();
    const adaSync = adaModes.getByRole('radio', { name: 'Sync', exact: true });
    assert.equal(await adaSync.isChecked(), true);
    await adaSync.focus();
    await page.keyboard.press('ArrowUp');
    await page.getByText('Ada: Steer requested.').waitFor();
    assert.equal(await adaModes.getByRole('radio', { name: 'Steer', exact: true }).isChecked(), true);
    await adaAgent.getByText('In effect: Steer.').waitFor();
    await adaAgent.getByText('Last changed by you (owner) (v2)').waitFor();
    assert.equal(await adaModes.getByRole('radio', { name: 'Async (not proven for this agent)', exact: true }).isDisabled(), true,
      'async stays unproven without a receipt proof');

    // Ada moves herself back to sync with `khala mode set`; the owner's panel names her as the one who changed it.
    const agentSet = await ada.mode(['set', 'sync', '--expected-version', '2']);
    assert.equal(agentSet.code, 0, `khala mode set: ${agentSet.out}${agentSet.err}`);
    await page.reload();
    await adaAgent.getByText('In effect: Sync.').waitFor();
    assert.match(await adaAgent.innerText(), /Last changed by the agent \(Codex CLI 0\.156\.1 · [0-9a-f]+\) \(v3\)/);

    // Unproven: every Bea mode is shown, disabled, unclaimed, with the idle-delivery reason.
    const beaModes = page.getByRole('group', { name: 'Listening mode for Bea' });
    for (const mode of ['Steer', 'Sync', 'Async']) {
      const radio = beaModes.getByRole('radio', { name: `${mode} (not proven for this agent)`, exact: true });
      assert.equal(await radio.isDisabled(), true, `${mode} is disabled for Bea`);
      assert.equal(await radio.isChecked(), false, `${mode} is not claimed for Bea`);
    }
    const beaAgent = page.locator('.listening-control__agent', { has: beaModes });
    assert.match(await beaAgent.innerText(), /Idle agents receive messages only at their next turn\./);
    await beaAgent.getByText(/Requested: none\. Not in effect/).waitFor();

    // Pause: announced, and the owner's next message is held before Ada can claim it; resume releases it once.
    const pauseAda = page.getByRole('button', { name: 'Pause delivery to Ada' });
    await pauseAda.focus();
    await page.keyboard.press('Enter');
    await page.getByText('Delivery to Ada is paused. New messages wait until you resume.').waitFor();
    assert.match(await modeStatus.innerText(), /Delivery to Ada is paused\./);
    await composer.fill('Owner: held for Ada');
    await page.getByRole('button', { name: 'Send' }).click();
    await rowWith(page, 'Owner: held for Ada').waitFor();
    const heldResponse = await fetch(`${origin}/api/v1/channels/${ada$.channelId}/releases`, { headers: { authorization: `Bearer ${ada$.bindingCapability}` } });
    assert.equal(heldResponse.status, 200);
    assert.deepEqual(await heldResponse.json().then(body => [body.held, body.releases.length]), ['paused', 0], 'nothing reaches Ada while paused');
    assert.deepEqual(await ada.readAll(), [], 'Ada cannot read a held message');
    const resumeAda = page.getByRole('button', { name: 'Resume delivery to Ada' });
    await resumeAda.focus();
    await page.keyboard.press('Enter');
    await page.getByText('Delivery to Ada resumed.').waitFor();
    assert.deepEqual(await ada.readAll(), ['Owner: held for Ada'], 'resume releases the held message');
    assert.deepEqual(await bea.readAll(), ['Owner: held for Ada'], 'Bea was never paused');

    // Stop: keyboard only, confirmed, announced, and focus lands on the outcome.
    const stopButton = page.getByRole('button', { name: 'Stop agent delivery' });
    await stopButton.focus();
    await page.keyboard.press('Enter');
    await page.getByRole('group', { name: 'Stop delivery to agents in this channel?' }).waitFor();
    assert.equal(await focused(page), 'Stop delivery to agents in this channel?');
    await page.keyboard.press('Tab');
    assert.equal(await focused(page), 'Stop delivery');
    await page.keyboard.press('Enter');
    await page.getByRole('heading', { name: 'Agent delivery stopped' }).waitFor();
    assert.equal(await focused(page), 'Agent delivery stopped');
    const stopStatus = page.locator('.stop-control__status[role="status"]');
    assert.match(await stopStatus.innerText(), /Agent delivery stopped\. 2 agent bindings were revoked\./);

    // Stop revoked delivery, not the server: bindings can no longer read or write,
    assert.equal(await reachable(origin), true, 'the server is still running after Stop');
    assert.equal((await pullReleases(ada, origin)).status, 401, 'a revoked binding receives no delivery');
    assert.equal((await pullReleases(bea, origin)).status, 401, 'a revoked binding receives no delivery');
    assert.notEqual((await bea.send('Bea: after Stop')).code, 0, 'a revoked binding cannot post');
    // …while the channel stays viewable, with its history, and the owner can still write in it.
    await page.reload();
    await rowWith(page, 'Owner: both of you, please hold').waitFor();
    await rowWith(page, 'Ada: hello Bea').waitFor();
    await composer.fill('Owner: noted after Stop');
    await page.getByRole('button', { name: 'Send' }).click();
    await rowWith(page, 'Owner: noted after Stop').waitFor();
    assert.equal(await page.getByText('Bea: after Stop').count(), 0);

    // Launcher close: the server goes away, and the page says so and how to resume.
    const closed = await launcher.close();
    launcher = undefined;
    assert.equal(closed.code, 0);
    assert.equal(await reachable(origin), false, 'the launcher closed its server');
    const stopped = page.getByRole('heading', { name: 'The local Khala server stopped' });
    await stopped.waitFor({ timeout: 30_000 });
    assert.equal(await focused(page), 'The local Khala server stopped', 'the terminal state takes focus');
    await page.getByText(`khala internal --resume ${channelId}`).waitFor();
    assert.equal(fs.existsSync(path.join(internalRootOf(ownerHome), 'active.json')), false, 'no runtime descriptor outlives the launcher');

    // Resume: the same persisted channel reopens, with its history, and Stop still holds.
    launcher = await startLauncher(['--resume', channelId], { stateHome: ownerHome, bundleDirectory, startPort: port });
    assert.equal(launcher.report.channelId, channelId, 'resume reopens the persisted channel');
    assert.equal(launcher.report.origin, origin, 'resume keeps the origin');
    await page.goto(launcher.report.url);
    await page.waitForURL(`${origin}/channels/${channelId}`);
    await rowWith(page, 'Owner: noted after Stop').waitFor();
    await rowWith(page, 'Bea: hello Ada').waitFor();
    assert.equal(await page.getByText('No messages yet.').count(), 0);
    // The agent picks up the resumed launcher's descriptor and rejoins: its stopped
    // binding is revoked in the store, not merely absent from the descriptor.
    fs.copyFileSync(path.join(internalRootOf(ownerHome), 'active.json'), ada.activePath);
    assert.equal(await ada.join(channelUrl), 'revoked', 'a stopped binding is not re-activated on resume');
    assert.notEqual((await ada.send('Ada: after resume')).code, 0, 'a stopped binding stays revoked after resume');

    // Narrow viewport: the channel and its Stop outcome fit without horizontal scrolling.
    await page.setViewportSize({ width: 320, height: 800 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'no horizontal overflow at 320px');

    assert.deepEqual(violations, []);
    const again = await launcher.close();
    launcher = undefined;
    assert.equal(again.code, 0);
  } finally {
    await browser?.close();
    await launcher?.close();
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(chromiumProfileRoot, { recursive: true, force: true });
  }
});

test('khala internal refuses a second launcher and an unknown channel', { timeout: 120_000 }, async () => {
  const base = fs.realpathSync(fs.mkdtempSync('/tmp/khala-acceptance-lease-'));
  const bundleDirectory = path.join(base, 'internal-web');
  const stateHome = path.join(base, 'state');
  fs.mkdirSync(stateHome, { mode: 0o700 });
  let launcher: RunningLauncher | undefined;
  try {
    await build({ configFile: path.join(webRoot, 'vite.internal.config.mjs'), logLevel: 'silent', build: { outDir: bundleDirectory, emptyOutDir: true } });
    launcher = await startLauncher([], { stateHome, bundleDirectory });
    const second = await khala(['internal', '--resume', launcher.report.channelId], { stateHome, bundleDirectory });
    assert.equal(second.code, 3);
    assert.equal(JSON.parse(second.err).error, 'launcher_running');
    await launcher.close();
    launcher = undefined;
    const unknown = await khala(['internal', '--resume', 'ch_unknown'], { stateHome, bundleDirectory });
    assert.equal(unknown.code, 3, 'resume never opens a fresh channel in place of a missing one');
    assert.equal(fs.readdirSync(path.join(internalRootOf(stateHome), 'channels')).length, 1);
  } finally {
    await launcher?.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
});
