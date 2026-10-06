import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, describe, expect, it } from 'vitest';
import type { LocalChannelCreated } from '@khala/contracts/m1/local';
import { harnessInfo } from '@khala/contracts/m1/harness';
import { defaultAgentName } from '@khala/contracts/m1/names';
import { adapterFor } from '../index';
import { cursorSessionId } from '../../cursor';
import { channelFiles, stateRoot } from '../../state';
import { readCursor, unread } from '../../inbox';
import { writeActivity } from '../../activity';
import { readWakeState, writeWakeSettings } from '../../wake/shared';
import { conformanceDrivers } from './drivers';
import type { FakeHarnessDriver } from './driver';
import type { Feature } from './run';
import { createWorld, cleanupWorld, cli, admin, hook, inbox, mode, McpProcess, prepareTmux, wakeCalls,
  type World } from '../../local/fixtures/e2e-harness';
import { eventually } from '../../local/fixtures/egress';

// Local rows use the checkout CLI and real helper. Hosted join uses the same
// fake transport boundary as Tier A inside a spawned CLI/MCP process; this does
// not claim live Matrix or model verification (U36 owns that evidence).
const features: Feature[] = ['join (local)', 'join (hosted)', 'read', 'send', 'you=', 'rename event', 'rejoin', 'steer', 'sync', 'async', 'idle wake'];
type Result = { harness: string; feature: Feature; status: 'PASS' | 'FAIL' | 'ABSENT' | 'NOT RUN'; durationMs: number };
const results: Result[] = [];
const data = (value: { structuredContent: Record<string, unknown> }) => value.structuredContent;
const fixedLine = /^Khala: channel messages are waiting\. Continue\. \(k-[a-f0-9]{8}\)$/;

function isolatedDriver(harness: string, root: string): FakeHarnessDriver {
  const driver = conformanceDrivers[harness]!;
  return { ...driver, newSession: () => {
    const sample = driver.newSession(root);
    if (harness === 'cursor') {
      const workspace = path.join(root, 'workspace');
      return { id: cursorSessionId(workspace), workspace, mcpEnv: { KHALA_CURSOR_WORKSPACE: workspace } };
    }
    return sample;
  } };
}

describe.skipIf(process.env.KHALA_LOCAL_E2E !== '1')('Tier B spawned-process local conformance', () => {
  it.each(['claude', 'codex', 'cursor'] as const)('%s passes the local matrix', async harness => {
    let world: World | undefined;
    const row = async (feature: Feature, check: () => Promise<void>, absent = false) => {
      const result: Result = { harness, feature, status: 'FAIL', durationMs: 0 };
      const start = Date.now();
      try { await check(); result.status = absent ? 'ABSENT' : 'PASS'; }
      finally { result.durationMs = Date.now() - start; results.push(result); }
    };
    try {
      // Wake probes may execute only world-local fake binaries. This lane uses
      // the same isolated process-group cleanup as the acceptance wake proof.
      world = await createWorld();
      const driver = isolatedDriver(harness, world.root);
      const adapter = adapterFor(harness)!;
      const capabilities = harnessInfo(harness);
      let agent = await McpProcess.start(world, adapter, driver);
      let peer = world.claude;
      let channel!: LocalChannelCreated;
      let userId!: string;
      let transaction = 0;
      const status = async () => data(await agent.call('khala_status'));
      const publish = async (text: string) => {
        expect(data(await peer.call('khala_send', { text }))).toHaveProperty('eventId');
        await eventually(async () => (await inbox(agent)).some(entry => entry.body === text));
      };
      const setMode = async (next: 'async' | 'sync' | 'steer') => {
        expect((await admin(world!, 'POST', `/api/local/channels/${encodeURIComponent(channel.roomId)}/mode`,
          { agent: userId, mode: next, txnId: `conformance-${++transaction}` })).status).toBe(200);
        await eventually(async () => await mode(agent) === next);
      };
      const files = () => channelFiles(agent.files, channel.roomId);
      await row('join (local)', async () => {
        const created = await cli(world!, 'create', 'conformance');
        expect(created.code).toBe(0); channel = created.data as LocalChannelCreated;
        expect(data(await peer.call('khala_join', { link: channel.selfLink }))).toMatchObject({ state: 'connected' });
        expect(data(await agent.call('khala_join', { link: channel.shareLink }))).toMatchObject({ state: 'connected' });
        const joined = await status(); userId = joined.agentUserId as string;
        // The peer is also Claude, so the local name allocator gives this
        // second Claude the documented collision suffix.
        expect(joined.displayName).toBe(defaultAgentName('kevin', harness) + (harness === 'claude' ? '-2' : ''));
      });
      await row('join (hosted)', async () => {
        const hostedDriver = isolatedDriver(harness, path.join(world!.root, 'hosted'));
        const sample = hostedDriver.newSession();
        sample.mcpEnv.XDG_STATE_HOME = path.join(world!.root, 'hosted-state');
        const hosted = await McpProcess.start(world!, adapter, hostedDriver, sample,
          fileURLToPath(new URL('./hosted-mcp.mjs', import.meta.url)));
        try {
          expect(data(await hosted.call('khala_join', { link: 'https://khala.example/join/abcdefgh' }))).toMatchObject({ state: 'awaiting_confirmation' });
          await eventually(async () => data(await hosted.call('khala_status')).state === 'connected');
          expect(data(await hosted.call('khala_status'))).toMatchObject({ displayName: defaultAgentName('kevin', harness), you: defaultAgentName('kevin', harness) });
        } finally { await hosted.close(); }
      });
      await row('read', async () => {
        await publish('tier-b-read'); const before = await readCursor(files());
        const read = data(await agent.call('khala_read', { limit: 100 }));
        expect(read.messages).toEqual(expect.arrayContaining([expect.objectContaining({ body: 'tier-b-read', senderLabel: 'kevin-Claude' })]));
        expect(await readCursor(files())).toEqual(before);
      });
      await row('send', async () => {
        expect(data(await agent.call('khala_send', { text: 'tier-b-own' }))).toHaveProperty('eventId');
        await eventually(async () => (await inbox(peer)).some(entry => entry.body === 'tier-b-own'));
        expect((await inbox(agent)).some(entry => entry.body === 'tier-b-own')).toBe(false);
      });
      await row('you=', async () => {
        const you = (await status()).you;
        expect(data(await agent.call('khala_read')).you).toBe(you);
        await setMode('sync');
        expect((await hook(agent, 'stop')).frame).toContain(` you="${you}" `);
      });
      await row('rename event', async () => {
        expect((await admin(world!, 'POST', `/api/local/agents/${encodeURIComponent(userId)}/name`, { name: 'Reviewer' })).status).toBe(200);
        await eventually(async () => (await status()).you === 'Reviewer');
        await publish('tier-b-renamed');
        expect(data(await agent.call('khala_read')).you).toBe('Reviewer');
        const output = await hook(agent, 'stop');
        expect(output.frame).toContain(' you="Reviewer" '); expect(output.frame).toContain(' is now Reviewer');
      });
      await row('rejoin', async () => {
        await agent.close(); agent = await McpProcess.start(world!, adapter, driver);
        expect(data(await agent.call('khala_join', { link: channel.shareLink }))).toMatchObject({ state: 'connected' });
        expect((await status()).agentUserId).toBe(userId); expect((await status()).you).toBe('Reviewer');
      });
      await row('steer', async () => {
        await setMode('steer'); await publish('tier-b-steer');
        const output = await hook(agent, 'tool');
        expect(output.kind).toBe(capabilities.steer ? 'context' : 'none');
        if (capabilities.steer) expect(output.frame).toContain('tier-b-steer');
        else expect((await unread(files())).entries.some(entry => entry.body === 'tier-b-steer')).toBe(true);
      }, !capabilities.steer);
      await row('sync', async () => {
        await setMode('sync'); await publish('tier-b-sync');
        expect((await hook(agent, 'tool')).kind).toBe('none');
        const output = await hook(agent, 'stop'); expect(output.kind).toBe('continue'); expect(output.frame).toContain('tier-b-sync');
        expect((await hook(agent, 'stop')).kind).toBe('none');
        await publish('tier-b-continuation');
        expect((await hook(agent, 'stop', { continuation: true })).kind).toBe(driver.syncGuard === 'cursor' ? 'continue' : 'none');
        expect((await hook(agent, 'stop', { continuation: true })).kind).toBe('none');
      });
      await row('async', async () => {
        await setMode('async'); await publish('tier-b-async');
        const before = await readCursor(files());
        for (const event of ['prompt', 'tool', 'stop'] as const) expect((await hook(agent, event)).kind).toBe('none');
        expect(await readCursor(files())).toEqual(before);
        const calls = await wakeCalls(world!);
        await delay(1000); expect(await wakeCalls(world!)).toEqual(calls);
      });
      await row('idle wake', async () => {
        await cleanupWorld(world!);
        world = await createWorld({ guard: false });
        const wakeDriver = isolatedDriver(harness, world.root);
        agent = await McpProcess.start(world, adapter, wakeDriver); peer = world.claude;
        channel = (await cli(world, 'create', 'wake-conformance')).data as LocalChannelCreated;
        expect(data(await peer.call('khala_join', { link: channel.selfLink }))).toMatchObject({ state: 'connected' });
        expect(data(await agent.call('khala_join', { link: channel.shareLink }))).toMatchObject({ state: 'connected' });
        userId = (await status()).agentUserId as string;
        // Start with async suppression on a clean wake budget.
        await setMode('async'); await hook(agent, 'prompt'); await hook(agent, 'stop');
        if (harness === 'claude') {
          await writeWakeSettings(stateRoot(world!.env), { consent: { 'claude/terminal': { at: new Date().toISOString() } }, off: {} });
          await prepareTmux(agent);
        }
        await writeActivity(agent.files, 'idle', () => new Date(Date.now() - 31_000));
        const quiet = await wakeCalls(world);
        await publish('tier-b-async-wake'); await delay(1000);
        expect(await wakeCalls(world)).toEqual(quiet); expect(await readWakeState(agent.files.dir)).toEqual({});
        await writeActivity(agent.files, 'busy');
        await setMode('sync'); await hook(agent, 'prompt'); await hook(agent, 'stop');
        if (harness === 'claude') await prepareTmux(agent);
        await writeActivity(agent.files, 'busy', () => new Date(Date.now() - 31_000));
        const busyCalls = await wakeCalls(world!);
        await publish('tier-b-busy'); await delay(1000);
        expect(await wakeCalls(world!)).toEqual(busyCalls); expect(await readWakeState(agent.files.dir)).toEqual({});
        if (harness === 'claude') {
          await writeWakeSettings(stateRoot(world!.env), { consent: {}, off: {} });
          await writeActivity(agent.files, 'idle', () => new Date(Date.now() - 31_000));
          await publish('tier-b-no-consent'); await delay(1000);
          expect(await wakeCalls(world!)).toEqual(busyCalls); expect(await readWakeState(agent.files.dir)).toEqual({});
        }
        await hook(agent, 'prompt'); await hook(agent, 'stop');
        if (harness === 'claude') {
          await writeWakeSettings(stateRoot(world!.env), { consent: { 'claude/terminal': { at: new Date().toISOString() } }, off: {} });
          await prepareTmux(agent);
        }
        // Exercise the 30s safety boundary without spending 30s per harness.
        await writeActivity(agent.files, 'idle', () => new Date(Date.now() - 31_000));
        const before = await wakeCalls(world!);
        expect(data(await agent.call('khala_send', { text: 'tier-b-self-idle' }))).toHaveProperty('eventId');
        await eventually(async () => (await inbox(peer)).some(entry => entry.body === 'tier-b-self-idle'));
        await delay(1000); expect(await wakeCalls(world!)).toEqual(before);
        await publish('tier-b-idle');
        if (capabilities.idleWake === 'none') {
          await delay(1000); expect(await wakeCalls(world!)).toEqual(before); expect(adapter.wakeLadder ?? []).toHaveLength(0); return;
        }
        const transport = harness === 'codex' ? 'codex' : 'tmux';
        await eventually(async () => (await wakeCalls(world!)).slice(before.length).some(call => call.command === transport &&
          (transport === 'codex' ? call.argv[0] === 'queue' : call.argv.at(-1) === 'Enter')));
        const calls = (await wakeCalls(world!)).slice(before.length);
        let line: string;
        if (harness === 'codex') {
          const call = calls.find(call => call.command === 'codex')!;
          line = call.argv[4]!; expect(call.argv).toEqual(['queue', '--thread', agent.sessionId, '--message', line]);
        } else {
          const call = calls.find(call => call.command === 'tmux' && call.argv.includes('-l'))!;
          line = call.argv[call.argv.indexOf('-l') + 1]!;
          const target = ['-S', path.join(world!.root, 'tmux.sock'), 'send-keys', '-t', '%7'];
          expect(call.argv).toEqual([...target, '-l', line]);
          expect(calls.filter(call => call.command === 'tmux' && call.argv.at(-1) === 'Enter').map(call => call.argv))
            .toEqual([[...target, 'Enter']]);
        }
        expect(line).toMatch(fixedLine); expect(line).not.toContain('tier-b-idle');
        expect((await hook(agent, 'prompt', { promptText: line })).frame).toContain('tier-b-idle');
        await eventually(async () => (await readWakeState(agent.files.dir))[harness === 'codex' ? 'queue' : 'terminal']?.failures === 0);
      }, harnessInfo(harness).idleWake === 'none');
    } finally {
      if (world) await cleanupWorld(world);
      for (const feature of features) if (!results.some(row => row.harness === harness && row.feature === feature))
        results.push({ harness, feature, status: 'NOT RUN', durationMs: 0 });
    }
  }, 120_000);
  afterAll(async () => {
    if (results.length === 0) return;
    const directory = path.resolve('test-results/local-e2e'); await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'conformance-results.json'), JSON.stringify({ version: 1, tier: 'B', transport: 'local + hosted fixture', results }, null, 2) + '\n');
    process.stdout.write('\nHarness   Feature         Result    Duration\n' + results.map(row =>
      `${row.harness.padEnd(10)}${row.feature.padEnd(16)}${row.status.padEnd(10)}${row.durationMs}ms`).join('\n') + '\n');
  });
});
