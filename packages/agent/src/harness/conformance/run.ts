import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { harnessInfo, type HarnessInfo } from '@khala/contracts/m1/harness';
import { defaultAgentName } from '@khala/contracts/m1/names';
import type { AgentCredentials, Harness } from '@khala/contracts/m1/agent-join';
import { createKhalaAgentClient } from '../../client-impl';
import type { KhalaAgentClient } from '../../client';
import type { ChannelSession, SessionMessage } from '../../transport';
import { channelFiles, openSessionDir, readStateFile, stateRoot, writeStateFile } from '../../state';
import { appendEntries, readCursor, unread } from '../../inbox';
import { readActivity, writeActivity } from '../../activity';
import { createWakeLadder } from '../../wake/ladder';
import { readWakeState, writeWakeSettings } from '../../wake/shared';
import type { HarnessAdapter } from '../adapter';
import { processSource, resolveSources, recordHookSession } from '../session-sources';
import { deliverCore } from '../deliver-core';
import type { FakeHarnessDriver, FakeSession, HookEvent } from './driver';

export type Feature = 'join (local)' | 'join (hosted)' | 'read' | 'send' | 'you=' | 'rename event' | 'rejoin' | 'steer' | 'sync' | 'async' | 'idle wake';
export type ConformanceRow = { feature: Feature; status: 'pass' | 'absent' | 'pending'; detail?: string };
export type ConformanceResult = { harness: string; rows: ConformanceRow[] };
const now = () => new Date('2026-10-05T12:00:00Z');

async function until(check: () => Promise<boolean>, message: string) {
  const deadline = Date.now() + 1500;
  while (!await check()) {
    assert(Date.now() < deadline, message);
    await delay(5);
  }
}

/** Transport boundaries are faked; client identity, inbox, rename and hook state are real. */
export function transportFixture(adapter: HarnessAdapter, transport: 'local' | 'matrix') {
  let sequence = 0;
  let ownName = defaultAgentName('kevin', adapter.id);
  const members = new Map<string, string>();
  const joins = new Map<string, AgentCredentials>();
  const requests: { harness: string; sessionId?: string; rejoinSecret?: string }[] = [];
  const handlers = new Set<(message: SessionMessage) => void>();
  const history: SessionMessage[] = [];
  const sent: { roomId: string; text: string; userId: string }[] = [];
  let own = '';
  const session = (creds: AgentCredentials): ChannelSession => ({
    userId: creds.userId,
    inviter: () => '@owner:local',
    listeningMode: () => 'sync',
    onListeningModeCommand: () => () => {},
    publishListeningMode: async () => {},
    onMessage(handler) { handlers.add(handler); return () => { handlers.delete(handler); }; },
    waitForInvite: async () => {}, join: async () => {},
    history: async (_room, limit) => ({ messages: history.slice(-limit) }),
    send: async (roomId, text) => {
      sent.push({ roomId, text, userId: creds.userId });
      return { eventId: '$sent' };
    },
    sendChannelEvent: async () => ({ eventId: '$event' }),
    roomName: () => 'Conformance channel',
    displayName: id => id === creds.userId ? ownName : 'Maya',
    stop: async () => {},
  });
  return {
    requests, sent,
    startSession: async (creds: AgentCredentials) => { own = creds.userId; return session(creds); },
    joinApi: {
      async requestJoin(input: { link: string; harness: string; sessionId?: string; rejoinSecret?: string }) {
        requests.push(input);
        assert.equal(input.harness, adapter.id);
        const key = input.sessionId && input.rejoinSecret ? `${input.sessionId}/${input.rejoinSecret}` : undefined;
        const userId = key && members.get(key) || `@agent-${++sequence}:local`;
        if (key) members.set(key, userId);
        const joinId = `join-${requests.length}`;
        const origin = new URL(input.link).origin;
        joins.set(joinId, { homeserver: 'https://matrix.example', userId, accessToken: 'fixture-token', deviceId: 'device',
          roomId: '!conformance:local', ...(transport === 'local' ? { transport: 'local' as const } : {}) });
        return { origin, joinId, pollSecret: 'fixture-poll', confirmUrl: `${origin}/agent/confirm`, expiresAt: '2026-10-06T12:00:00Z' };
      },
      async pollJoin(input: { joinId: string }) { return joins.get(input.joinId)!; },
      reportReady: async () => {},
    },
    emit(id: string, sender = '@maya:local', rename?: string) {
      const message: SessionMessage = { eventId: id, roomId: '!conformance:local', sender,
        ts: now().getTime(), type: rename ? 'm.room.member' : 'm.room.message', body: id,
        content: rename ? { membership: 'join', displayname: rename } : {} };
      if (rename) { message.previousContent = { membership: 'join', displayname: ownName }; ownName = rename; }
      history.push(message);
      for (const handler of handlers) handler(message);
    },
    own: () => own,
  };
}

export async function runConformance(adapter: HarnessAdapter, driver: FakeHarnessDriver,
  options: { capabilities?: HarnessInfo } = {}): Promise<ConformanceResult> {
  const capabilities = options.capabilities ?? harnessInfo(adapter.id);
  assert.equal(capabilities.id, adapter.id, 'capabilities must describe this adapter');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'khala-conformance-'));
  const rows: ConformanceRow[] = [];
  const clients = new Set<KhalaAgentClient>();
  const sample = driver.newSession(root);
  const env = { ...sample.mcpEnv, XDG_STATE_HOME: root };
  try {
    await driver.prepareSession?.(sample, env);
    let hookAt = now().getTime();
    if (adapter.sessionSources.some(source => source.kind === 'hook-map')) {
      await recordHookSession(adapter.id, sample.id, env, { now, ...(sample.workspace ? { workspace: sample.workspace } : {}) });
    }
    const resolved = await resolveSources(adapter.sessionSources, sample.mcpMeta, env, { harness: adapter.id });
    assert.equal(resolved?.sessionId, sample.id, 'driver session must resolve through the adapter');
    for (const source of adapter.sessionSources) {
      if (source.kind !== 'meta' && source.kind !== 'env' && source.kind !== 'workspace') continue;
      const isolated = await resolveSources([source], sample.mcpMeta, env, { harness: adapter.id });
      assert.equal(isolated?.sessionId, sample.id, `driver must exercise the ${source.kind} session source`);
    }
    // U8 opens client/state wire ids; keep this adapter-facing runner ready for that widening.
    const harness = adapter.id as Harness;
    const files = await openSessionDir(harness, sample.id, env);
    const hook = async (event: HookEvent, extra: Partial<FakeSession & { continuation: boolean; promptText: string }> = {}, stdin?: string) => {
      let stdout = '', stderr = '';
      assert.equal(await deliverCore(stdin ?? driver.hookStdin(event, { ...sample, ...extra }), adapter, {
        env, now: () => new Date(hookAt), stdout: { write: text => { stdout += text; } }, stderr: { write: text => { stderr += text; } },
      }), 0);
      assert.equal(stderr, '', 'hook diagnostics');
      return driver.readHookStdout(stdout);
    };
    const row = async (feature: Feature, check: () => Promise<void>, status: ConformanceRow['status'] = 'pass', detail?: string) => {
      try { await check(); }
      catch (error) { throw new Error(`${adapter.id} ${feature}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
      rows.push({ feature, status, ...(detail ? { detail } : {}) });
    };
    const connected = async (fixture: ReturnType<typeof transportFixture>, sessionId: string, rejoinable: boolean, transport: 'local' | 'matrix') => {
      const client = createKhalaAgentClient({ harness, sessionId, rejoinable, env, now,
        joinApi: fixture.joinApi, startSession: fixture.startSession });
      clients.add(client);
      const result = await client.join(transport === 'local' ? 'http://127.0.0.1:47830/join/abcdefgh' : 'https://khala.example/join/abcdefgh', 'Scout');
      assert.equal(result.state, 'awaiting_confirmation');
      await until(async () => (await client.status()).state === 'connected', 'join never connected');
      return client;
    };
    const local = transportFixture(adapter, 'local');
    const hosted = transportFixture(adapter, 'matrix');
    let client!: KhalaAgentClient;
    await row('join (local)', async () => {
      client = await connected(local, sample.id, resolved!.rejoinable, 'local');
      const status = await client.status();
      assert.equal(status.displayName, defaultAgentName('kevin', adapter.id));
      assert.equal(status.agentUserId, local.own());
      assert.equal(local.requests[0]?.harness, adapter.id);
    });
    await row('join (hosted)', async () => {
      const other = await connected(hosted, 'hosted-session', true, 'matrix');
      assert.equal((await other.status()).displayName, defaultAgentName('kevin', adapter.id));
      assert.equal(hosted.requests[0]?.harness, adapter.id);
      await other.close();
    });
    const channel = channelFiles(files, '!conformance:local');
    const emit = async (id: string, sender?: string, rename?: string) => { local.emit(id, sender, rename); await client.status(); };
    await row('read', async () => {
      await emit('$read');
      const before = await readCursor(channel);
      const read = await client.read(10);
      assert.equal(read.messages[0]?.body, '$read');
      assert.equal(read.messages[0]?.senderLabel, 'Maya');
      assert.deepEqual(await readCursor(channel), before, 'read must not acknowledge hook backlog');
    });
    await row('send', async () => {
      assert.deepEqual(await client.send('conformance reply'), { eventId: '$sent' });
      assert.deepEqual(local.sent, [{ roomId: '!conformance:local', text: 'conformance reply', userId: local.own() }]);
      const before = (await unread(channel)).entries.length;
      await emit('$own', local.own());
      assert.equal((await unread(channel)).entries.length, before, 'own messages must not enter hook inbox');
    });
    const hookSupported = !!adapter.codec && (capabilities.sync || capabilities.steer);
    const identityHook = async () => {
      await writeStateFile(channel.dir, 'mode.json', { mode: capabilities.sync ? 'sync' : capabilities.steer ? 'steer' : 'async' });
      return hook(capabilities.sync ? 'stop' : 'tool');
    };
    await row('you=', async () => {
      assert.equal((await client.read(10)).you, defaultAgentName('kevin', adapter.id));
      assert.equal((await client.status()).you, defaultAgentName('kevin', adapter.id));
      const output = await identityHook();
      if (hookSupported) assert(output.frame?.includes(` you="${defaultAgentName('kevin', adapter.id)}" `));
      else assert.equal(output.kind, 'none');
    });
    await row('rename event', async () => {
      await emit('$rename', local.own(), 'Reviewer');
      await emit('$after-rename');
      assert.equal((await client.read(10)).you, 'Reviewer');
      assert.equal((await client.status()).you, 'Reviewer');
      const pending = (await unread(channel)).entries;
      assert(pending.some(entry => entry.kind === 'event' && entry.body.endsWith(' is now Reviewer')));
      const output = await identityHook();
      if (hookSupported) {
        assert(output.frame?.includes(' you="Reviewer" '));
        assert(output.frame?.includes(' is now Reviewer'));
      } else assert.equal(output.kind, 'none');
    });
    await row('rejoin', async () => {
      const prior = local.own();
      await client.close();
      client = await connected(local, sample.id, resolved!.rejoinable, 'local');
      assert.equal(local.own() === prior, resolved!.rejoinable);
      if (resolved!.rejoinable) assert.equal(local.requests[0]?.rejoinSecret, local.requests[1]?.rejoinSecret);
      const process = await resolveSources([processSource], undefined, env, { harness: adapter.id, pid: 200,
        readProcess: async pid => ({ pid, ppid: pid === 200 ? 100 : 0, command: 'agent', startTime: 'start' }) });
      assert.equal(process?.rejoinable, false);
      const ephemeral = transportFixture(adapter, 'matrix');
      const first = await connected(ephemeral, process!.sessionId, process!.rejoinable, 'matrix');
      const member = ephemeral.own();
      await first.close();
      const second = await connected(ephemeral, process!.sessionId, process!.rejoinable, 'matrix');
      assert.notEqual(ephemeral.own(), member);
      assert(ephemeral.requests.every(request => request.sessionId === undefined && request.rejoinSecret === undefined));
      assert.equal(await readStateFile(path.join(stateRoot(env), adapter.id, process!.sessionId), 'rejoin.json'), null);
      await second.close();
    });
    await row('steer', async () => {
      await writeStateFile(channel.dir, 'mode.json', { mode: 'steer' });
      await emit('$steer');
      const output = await hook('tool');
      assert.equal(output.kind, capabilities.steer ? 'context' : 'none');
      if (capabilities.steer) assert(output.frame?.includes('$steer'));
      else assert((await unread(channel)).entries.some(entry => entry.body === '$steer'));
    }, capabilities.steer ? 'pass' : 'absent');
    await row('sync', async () => {
      await writeStateFile(channel.dir, 'mode.json', { mode: 'sync' });
      await emit('$sync');
      assert.equal((await hook('tool')).kind, 'none', 'sync tool hooks cannot steer');
      const before = await readCursor(channel);
      const output = await hook('stop');
      assert.equal(output.kind, capabilities.sync ? 'continue' : 'none');
      if (!capabilities.sync) {
        assert.deepEqual(await readCursor(channel), before, 'absent sync must not consume backlog');
        assert((await unread(channel)).entries.some(entry => entry.body === '$sync'));
      }
      if (capabilities.sync) {
        assert(output.frame?.includes('$sync'));
        // Repeated callbacks cannot replay the delivered batch, even without a retry flag.
        assert.equal((await hook('stop')).kind, 'none');
        await emit('$continuation');
        const retry = await hook('stop', { continuation: true });
        if (driver.syncGuard === 'cursor') {
          assert.equal(retry.kind, 'continue');
          assert(retry.frame?.includes('$continuation'));
          assert.equal((await hook('stop', { continuation: true })).kind, 'none');
        } else {
          assert.equal(retry.kind, 'none');
          assert((await unread(channel)).entries.some(entry => entry.body === '$continuation'));
        }
        assert.equal((await readActivity(files)).state, 'idle');
      }
    }, capabilities.sync ? 'pass' : 'absent');
    await row('async', async () => {
      await writeStateFile(channel.dir, 'mode.json', { mode: 'async' });
      await emit('$async');
      for (const event of ['prompt', 'tool', 'stop'] as const) assert.equal((await hook(event)).kind, 'none');
      assert((await unread(channel)).entries.some(entry => entry.body === '$async'));
      if (hookSupported) assert.equal((await readActivity(files)).state, 'idle');
    });
    await row('idle wake', async () => {
      const probe = driver.wakeProbe?.(adapter, env);
      if (capabilities.idleWake === 'none') {
        assert.equal(adapter.wakeLadder?.length ?? 0, 0, 'idle wake declared absent but adapter has drivers');
        return;
      }
      assert(probe?.drivers.length, 'idle wake declared but not delivered');
      assert.deepEqual(probe.drivers.map(d => [d.id, d.verification, d.optIn]),
        adapter.wakeLadder?.map(d => [d.id, d.verification, d.optIn]), 'probe must preserve wake policy');
      // Agent-armed watcher completion is a native tool notification, not a typed wake.
      assert(probe.drivers.every(d => d.verification !== 'none' || (adapter.id === 'claude' && d.id === 'watcher')
        || (adapter.id === 'qwen' && d.id === 'background-shell')),
        'idle wake declared but not delivered: unverified transport');
      if (capabilities.idleWake === 'opt-in') assert(probe.drivers.every(d => d.optIn),
        'opt-in idle wake must require recorded consent for every driver');
      // Independent state prevents the positive wake's backlog from masking exclusions.
      for (const excluded of ['async', 'own', 'busy', ...(capabilities.idleWake === 'opt-in' || probe.drivers.every(d => d.optIn) ? ['no-consent'] : [])]) {
        const guard = await openSessionDir(harness, `wake-guard-${excluded}`, env);
        await writeStateFile(guard.dir, 'session.json', { roomId: '!guard:local', userId: '@self:local' });
        await writeStateFile(guard.dir, 'mode.json', { mode: excluded === 'async' ? 'async' : 'sync' });
        await writeActivity(guard, excluded === 'busy' ? 'busy' : 'idle', now);
        await appendEntries(guard, [{ eventId: '$guard', roomId: '!guard:local', ts: now().toISOString(),
          sender: excluded === 'own' ? '@self:local' : '@peer:local', senderLabel: 'Peer', senderKind: 'human',
          kind: 'message', body: 'Channel text must never be in a wake line' }]);
        // Consent is required for all suppression cases except the explicit decline case.
        await writeWakeSettings(stateRoot(env), { consent: excluded === 'no-consent' ? {} : Object.fromEntries(
          probe.drivers.filter(d => d.optIn).map(d => [`${adapter.id}/${d.id}`, { at: now().toISOString() }])), off: {} });
        await probe.prepare?.(guard);
        const blocked = createWakeLadder({ files: guard, harness: adapter.id, sessionId: `wake-guard-${excluded}`,
          drivers: probe.drivers, env, pollMs: 10, now: () => now().getTime() + 60_000, stderr: () => {} });
        try {
          blocked.notify();
          await delay(100);
        } finally { await blocked.stop(); await probe.stop?.(); }
        assert.equal(probe.prompt(), undefined, `idle wake must be suppressed for ${excluded}`);
        assert.deepEqual(await readWakeState(guard.dir), {}, 'suppression must not settle a wake');
      }
      await writeWakeSettings(stateRoot(env), { consent: Object.fromEntries(probe.drivers.filter(d => d.optIn)
        .map(d => [`${adapter.id}/${d.id}`, { at: now().toISOString() }])), off: {} });
      await writeStateFile(channel.dir, 'mode.json', { mode: 'sync' });
      await writeActivity(files, 'idle', now);
      await emit('$idle-wake');
      await probe.prepare?.(files);
      const ladder = createWakeLadder({ files, harness: adapter.id, sessionId: sample.id, drivers: probe.drivers, env,
        pollMs: 10, now: () => now().getTime() + 60_000, stderr: () => {} });
      try {
        ladder.notify();
        await until(async () => probe.prompt() !== undefined, 'idle wake declared but not delivered');
        assert.match(probe.prompt()!, /^Khala: channel messages are waiting\. Continue\. \(k-[0-9a-f]{8}\)$/);
        hookAt = now().getTime() + 60_001;
        if (driver.wakeHook) await hook('stop', {}, await driver.wakeHook(sample, probe.prompt()!));
        else await hook(probe.verificationEvent ?? 'prompt', { promptText: probe.prompt()! });
        if (probe.afterPrompt) { await probe.afterPrompt(); await hook('tool'); }
        const states = await readWakeState(files.dir);
        assert(probe.drivers.some(d => states[d.id]?.failures === 0), 'idle wake declared but not delivered: nonce not verified');
      } finally { await ladder.stop(); await probe.stop?.(); }
    }, capabilities.idleWake === 'none' ? 'absent' : 'pass');
    return { harness: adapter.id, rows };
  } finally {
    try { await Promise.all([...clients].map(client => client.close())); }
    finally { await fs.rm(root, { recursive: true, force: true }); }
  }
}
