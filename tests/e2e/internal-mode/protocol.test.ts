// Acceptance 1, protocol lane (docs/product/internal-mode/acceptance.md, AC1).
//
// Real composition: the `khala` CLI entry starts the internal launcher, which owns
// the loopback server and the SQLite channel store. Two agents are externally
// started CLI sessions (fake native harnesses) that reach Khala only through the
// production `khala` commands; the test acts as the human through the owner API.
// Stop revokes bindings and ends delivery while every CLI keeps running
// (executor decision 36); Khala never launches, wraps or signals an agent.

import path from 'node:path';
import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { channelDirectory } from '../../../apps/internal/src/lifecycle/paths';
import { openChannelStore } from '../../../apps/internal/src/store/open';
import { controlsFor } from '../../conformance/subjects';
import {
  type HumanSession, type KhalaProfile, type ProcessAudit, type RunningLauncher, freePort, humanSession,
  installProcessAudit, khalaOnce, processAlive, reachable, startLauncher,
} from '../harness/internal';
import { type ScenarioHarness, assertCleanClose, createScenarioHarness } from '../harness/scenario';
import { type DeliveredEvent, type ExternalCli, type ReadView, createExternalCli } from './cli-driver';

type TimelineEvent = Readonly<{ eventId: string; participant: { participantId: string; kind: string }; content: { body: string } }>;

let audit: ProcessAudit | null = null;
let open: ScenarioHarness | null = null;
afterEach(async () => {
  // A failed run still closes its launchers and user CLI stand-ins.
  const scenario = open;
  open = null;
  try {
    if (scenario) await scenario.close();
  } finally {
    audit?.uninstall();
    audit = null;
  }
});

type World = Readonly<{
  scenario: ScenarioHarness;
  launcherProfile: KhalaProfile;
  internalRoot: string;
  a: ExternalCli;
  b: ExternalCli;
}>;

async function world(): Promise<World> {
  audit = installProcessAudit();
  const scenario = await createScenarioHarness({
    runId: 'internal-protocol-acceptance',
    mode: 'fake-contract',
    owners: [
      { seed: 'h', controls: controlsFor('h', 'none') },
      { seed: 'a', controls: controlsFor('a', 'codex') },
      { seed: 'b', controls: controlsFor('b', 'claude') },
    ],
    sources: [{ component: 'khala-internal', version: '0.0.0' }],
  });
  open = scenario;
  const stateHome = scenario.stateDir(scenario.owner('h').ownerId);
  const launcherProfile: KhalaProfile = { stateHome, stateDirectory: path.join(stateHome, 'khala'), port: await freePort() };
  const cli = (seed: 'a' | 'b', harness: 'codex' | 'claude') => {
    const owner = scenario.owner(seed);
    const session = createExternalCli({
      name: `cli-${seed}`, harness, sessionId: `session-${seed}`, ownerId: owner.ownerId,
      stateDirectory: scenario.stateDir(owner.ownerId), audit: audit!,
      record: (kind, subject) => { scenario.record(kind, subject); },
    });
    scenario.defer(`user-cli:${seed}`, owner.ownerId, () => session.close());
    return session;
  };
  // Both sessions exist, with recorded process identities, before Khala is asked for anything.
  const a = cli('a', 'codex');
  const b = cli('b', 'claude');
  return { scenario, launcherProfile, internalRoot: path.join(stateHome, 'khala', 'internal'), a, b };
}

async function launch(w: World, resume?: string): Promise<RunningLauncher> {
  const launcher = await startLauncher(w.launcherProfile, resume);
  w.scenario.defer(`launcher:${launcher.report.channelId}`, w.scenario.owner('h').ownerId, async () => { await launcher.close(); });
  return launcher;
}

async function grantBoth(w: World, human: HumanSession): Promise<string> {
  const channelUrl = `${human.origin}/channels/${human.channelId}`;
  for (const agent of [w.a, w.b]) await agent.discover(w.launcherProfile);
  // Neither session starts admitted: each files a request that waits for the human.
  for (const agent of [w.a, w.b]) {
    expect(await agent.join(channelUrl)).toBe('pending_owner');
    expect((await agent.status()).connected).toBe(false);
  }
  const inbox = await human.call('/api/human/channel-requests');
  const pending = (inbox.json as { requests: { requestHandle: string; revision: string; outcome: string; requester: { harness: string } }[] })
    .requests.filter(request => request.outcome === 'pending_owner');
  expect(pending.map(request => request.requester.harness).sort()).toEqual(['claude', 'codex']);
  for (const request of pending) {
    const decided = await human.call(`/api/human/channel-access-requests/${request.requestHandle}/decision`, {
      method: 'POST',
      body: {
        v: 1, requestHandle: request.requestHandle, expectedRevision: request.revision, decision: 'approve',
        operationId: `decide-${request.requestHandle.slice(-12)}`,
      },
    });
    expect(decided.status).toBe(200);
  }
  for (const agent of [w.a, w.b]) expect(await agent.join(channelUrl)).toBe('connected');
  return channelUrl;
}

async function timeline(human: HumanSession): Promise<readonly TimelineEvent[]> {
  const reply = await human.call(`/api/v1/channels/${human.channelId}/timeline`);
  expect(reply.status).toBe(200);
  return (reply.json as { events: TimelineEvent[] }).events;
}

async function humanSays(human: HumanSession, body: string, clientTxnId: string): Promise<string> {
  const reply = await human.call(`/api/v1/channels/${human.channelId}/messages`, {
    method: 'POST', body: { clientTxnId, content: { v: 1, kind: 'text', body } },
  });
  expect(reply.status).toBe(201);
  return (reply.json as { event: { eventId: string } }).event.eventId;
}

function batch(view: ReadView): Readonly<{ token: string; events: readonly DeliveredEvent[] }> {
  if (view.kind !== 'batch') throw new Error(`expected a batch, got ${JSON.stringify(view)}`);
  return view;
}

/** Reads one batch, checks it holds exactly `eventIds`, and acknowledges it on the next Khala call. */
async function receive(agent: ExternalCli, eventIds: readonly string[]): Promise<readonly DeliveredEvent[]> {
  const delivered = batch(await agent.read());
  expect(delivered.events.map(event => event.eventId)).toEqual(eventIds);
  expect(await agent.read(delivered.token)).toEqual({ kind: 'empty' });
  return delivered.events;
}

function grantedCapability(agent: ExternalCli): string {
  return (JSON.parse(fs.readFileSync(agent.descriptorPath(), 'utf8')) as { bindingCapability: string }).bindingCapability;
}

async function releasesFor(human: HumanSession, capability: string) {
  const response = await fetch(`${human.origin}/api/v1/channels/${human.channelId}/releases?limit=50`, {
    headers: { authorization: `Bearer ${capability}` },
  });
  const text = await response.text();
  return { status: response.status, json: response.status === 200 ? JSON.parse(text) as { releases: { events: { eventId: string }[]; wake: boolean }[] } : null };
}

function assertUntouched(w: World): void {
  for (const agent of [w.a, w.b]) {
    expect(processAlive(agent.pid)).toBe(true);
    expect(agent.signalsReceived()).toEqual([]);
  }
  // Khala started no process of any kind: no agent, wrapper or replacement.
  expect(audit!.started()).toEqual([]);
}

describe('internal protocol acceptance', () => {
  it('grants, exchanges, stops and resumes two externally started agent sessions over the real launcher', async () => {
    const w = await world();
    const launcher = await launch(w);
    const { report } = launcher;
    expect(report.resumeCommand).toBe(`khala internal --resume ${report.channelId}`);
    const human = await humanSession(report);
    await grantBoth(w, human);

    // Two agents, two bindings, two participants: one binding never stands in for both.
    const [statusA, statusB] = [await w.a.status(), await w.b.status()];
    expect(statusA.connected && statusB.connected).toBe(true);
    expect(statusA.binding!.bindingId).not.toBe(statusB.binding!.bindingId);

    // A deliberately sends E1; B receives exactly E1 and deliberately answers with E2.
    const e1 = await w.a.send('E1 from the codex session');
    if (e1.kind !== 'accepted') throw new Error(`A could not send: ${JSON.stringify(e1)}`);
    const [atB] = await receive(w.b, [e1.eventId]);
    expect(atB!.body).toBe('E1 from the codex session');
    const e2 = await w.b.send('E2 from the claude session');
    if (e2.kind !== 'accepted') throw new Error(`B could not send: ${JSON.stringify(e2)}`);
    // A never receives its own E1 back, only B's E2.
    const [atA] = await receive(w.a, [e2.eventId]);
    expect(atA!.body).toBe('E2 from the claude session');
    expect(atA!.authorParticipantId).not.toBe(atB!.authorParticipantId);

    // Final model prose is never posted on the agent's behalf: only deliberate sends reach the channel.
    const before = (await timeline(human)).length;
    await w.a.endTurnWithProse('I think we are done here.');
    await w.b.endTurnWithProse('Agreed, wrapping up.');
    expect(await timeline(human)).toHaveLength(before);

    // A human message reaches both agents.
    const h1 = await humanSays(human, 'H1 from the owner', 'txn-human-0001');
    for (const agent of [w.a, w.b]) expect((await receive(agent, [h1]))[0]!.body).toBe('H1 from the owner');

    // Listening modes: without a descriptor `khala mode` holds no binding and refuses; with the
    // session's descriptor it reads that binding's server-held mode. Codex starts in `sync`; the
    // server knows Claude has no evidenced mode, so nothing is requested for it. This lane injects
    // no harness claim, so no mode is effective (`modes.test.ts` covers the proven routes). Human
    // releases stay wake-eligible either way, and an agent never wakes an agent.
    const mode = await khalaOnce(w.launcherProfile, ['mode', 'get']);
    expect(mode.code).not.toBe(0);
    expect(JSON.parse(mode.stdout)).toMatchObject({ ok: false, kind: 'refused', reason: 'unavailable' });
    expect(await w.a.mode(['get'])).toMatchObject({ ok: true, kind: 'view', requested: 'sync', version: 1, effective: null });
    expect(await w.b.mode(['get'])).toMatchObject({ ok: true, kind: 'view', requested: null, version: 1, effective: null });
    const wakes = await releasesFor(human, grantedCapability(w.b));
    expect(wakes.status).toBe(200);
    expect(wakes.json!.releases.map(release => [release.events[0]!.eventId, release.wake])).toEqual([[e1.eventId, false], [h1, true]]);

    // Restart without duplicates: an unacknowledged batch survives the CLI process
    // ending and is offered again, once; its token acknowledges it on the next call, and
    // replaying that token delivers nothing new.
    const h2 = await humanSays(human, 'H2 while A is between turns', 'txn-human-0002');
    const offered = batch(await w.a.read());
    expect(offered.events.map(event => event.eventId)).toEqual([h2]);
    const reoffered = batch(await w.a.read());
    expect(reoffered.events.map(event => event.eventId)).toEqual([h2]);
    expect(await w.a.read(reoffered.token)).toEqual({ kind: 'empty' });
    expect(await w.a.read(reoffered.token)).toEqual({ kind: 'empty' });
    expect(await w.a.read(offered.token)).toEqual({ kind: 'empty' });
    expect(await w.a.read()).toEqual({ kind: 'empty' });
    const h2Release = offered.events[0]!.releaseId;
    expect(w.a.deliveries().get(h2Release)).toBe(2);
    for (const [release, count] of [...w.a.deliveries(), ...w.b.deliveries()]) {
      if (release !== h2Release) expect(count, release).toBe(1);
    }
    expect(await receive(w.b, [h2])).toHaveLength(1);

    // Stop: both bindings revoked, delivery ends, and the server, channel and CLIs stay.
    const capabilities = [grantedCapability(w.a), grantedCapability(w.b)];
    const shown = [new Map(w.a.deliveries()), new Map(w.b.deliveries())];
    const stop = await human.call(`/api/v1/channels/${human.channelId}/stop`, { method: 'POST', body: { v: 1, targets: null } });
    expect(stop.status).toBe(200);
    const stopped = stop.json as { outcome: string; stopped: { bindingId: string }[]; remaining: unknown[] };
    expect(stopped.outcome).toBe('stopped');
    expect(stopped.remaining).toEqual([]);
    expect(stopped.stopped.map(binding => binding.bindingId).sort())
      .toEqual([statusA.binding!.bindingId, statusB.binding!.bindingId].sort());
    const h3 = await humanSays(human, 'H3 after Stop', 'txn-human-0003');
    for (const agent of [w.a, w.b]) {
      expect((await agent.status()).connected).toBe(false);
      expect((await agent.read()).kind).toBe('refused');
      expect((await agent.send('after stop')).kind).toBe('refused');
    }
    for (const capability of capabilities) expect((await releasesFor(human, capability)).status).toBe(401);
    // Nothing more was shown to either session after Stop.
    expect([new Map(w.a.deliveries()), new Map(w.b.deliveries())]).toEqual(shown);
    expect(await reachable(report.origin)).toBe(true);
    expect((await human.call(`/api/v1/channels/${human.channelId}`)).status).toBe(200);
    expect((await fetch(`${report.origin}/channels/${human.channelId}`)).status).toBe(200);
    const kept = (await timeline(human)).map(event => event.eventId);
    expect(kept).toEqual([e1.eventId, e2.eventId, h1, h2, h3]);
    assertUntouched(w);

    // Closing the launcher stops the server; the CLIs keep running.
    expect(await launcher.close()).toBe(0);
    expect(await reachable(report.origin)).toBe(false);
    expect(fs.existsSync(report.descriptorPath)).toBe(false);
    assertUntouched(w);

    // Post-shutdown snapshot of the store: distinct revoked bindings, no duplicate events.
    const directory = channelDirectory(w.internalRoot, report.channelId)!;
    const snapshot = openChannelStore({ directory, mode: 'existing' });
    try {
      const bindings = snapshot.read(db => db.prepare(
        'SELECT binding_id, participant_id, harness, session_id, status FROM bindings ORDER BY harness',
      ).all()) as { binding_id: string; participant_id: string; harness: string; session_id: string; status: string }[];
      expect(bindings.map(row => [row.harness, row.status])).toEqual([['claude', 'revoked'], ['codex', 'revoked']]);
      // The store keeps session fingerprints, never the raw native session IDs.
      for (const column of ['binding_id', 'participant_id', 'session_id'] as const) {
        expect(new Set(bindings.map(row => row[column])).size, column).toBe(2);
      }
      expect(bindings.map(row => row.session_id)).not.toContain('session-a');
      const events = snapshot.read(db => db.prepare('SELECT event_id FROM events ORDER BY sequence').all()) as { event_id: string }[];
      expect(events.map(row => row.event_id)).toEqual(kept);
    } finally {
      snapshot.close();
    }

    // `khala internal --resume <channel-id>` reopens the same persisted channel, and only the server.
    const resumed = await launch(w, report.channelId);
    expect(resumed.report.channelId).toBe(report.channelId);
    const again = await humanSession(resumed.report);
    expect((await timeline(again)).map(event => event.eventId)).toEqual(kept);
    for (const agent of [w.a, w.b]) expect((await agent.read()).kind).toBe('refused');
    assertUntouched(w);
    expect(await resumed.close()).toBe(0);
    expect(await reachable(resumed.report.origin)).toBe(false);

    open = null;
    assertCleanClose(await w.scenario.close());
    expect(w.scenario.evidence().filter(record => record.kind === 'channel.sent')).toHaveLength(2);
  });

  it('never offers an acknowledged batch again after a launcher resume, and a pending message arrives once', async () => {
    const w = await world();
    const launcher = await launch(w);
    const human = await humanSession(launcher.report);
    const channelUrl = await grantBoth(w, human);

    // A reads and acknowledges H1; H2 is still pending when the launcher closes.
    const h1 = await humanSays(human, 'H1 read and acknowledged', 'txn-human-0201');
    const acknowledged = await receive(w.a, [h1]);
    const h2 = await humanSays(human, 'H2 pending at the restart', 'txn-human-0202');
    expect(await launcher.close()).toBe(0);

    const resumed = await launch(w, launcher.report.channelId);
    w.a.relaunched(w.launcherProfile);
    expect(await w.a.join(channelUrl)).toBe('connected');

    // The first read after the resume holds only H2; H1 is never offered again.
    expect(await receive(w.a, [h2])).toHaveLength(1);
    expect(await w.a.read()).toEqual({ kind: 'empty' });
    expect(w.a.deliveries().get(acknowledged[0]!.releaseId)).toBe(1);

    expect(await resumed.close()).toBe(0);
    open = null;
    assertCleanClose(await w.scenario.close());
  });

  it('re-reads and acknowledges a durable release across a launcher restart over the same SQLite files', async () => {
    const w = await world();
    const launcher = await launch(w);
    const human = await humanSession(launcher.report);
    const channelUrl = await grantBoth(w, human);
    const bindings = [(await w.a.status()).binding, (await w.b.status()).binding];
    const capabilities = [grantedCapability(w.a), grantedCapability(w.b)];

    // H1 is offered to A, which ends before acknowledging it; then the launcher closes.
    const h1 = await humanSays(human, 'H1 before the restart', 'txn-human-0101');
    const offered = batch(await w.a.read());
    expect(offered.events.map(event => event.eventId)).toEqual([h1]);
    expect(await launcher.close()).toBe(0);

    // The same channel resumes on the same port over the same SQLite files.
    const resumed = await launch(w, launcher.report.channelId);
    expect(resumed.report.origin).toBe(launcher.report.origin);
    const again = await humanSession(resumed.report);
    for (const agent of [w.a, w.b]) {
      agent.relaunched(w.launcherProfile);
      // Launch-scoped authority ended with the launcher: nothing is held until the agent joins again.
      expect((await agent.status()).connected).toBe(false);
      expect((await agent.read()).kind).toBe('refused');
    }
    for (const capability of capabilities) expect((await releasesFor(again, capability)).status).toBe(401);

    // Joining again resumes the same binding with fresh authority; no owner prompt is filed.
    for (const [index, agent] of [w.a, w.b].entries()) {
      expect(await agent.join(channelUrl)).toBe('connected');
      const status = await agent.status();
      expect(status.connected).toBe(true);
      expect(status.binding).toEqual(bindings[index]);
      expect(grantedCapability(agent)).not.toBe(capabilities[index]);
    }
    const inbox = await again.call('/api/human/channel-requests');
    expect((inbox.json as { requests: { outcome: string }[] }).requests.filter(request => request.outcome === 'pending_owner')).toEqual([]);

    // A re-reads H1 exactly as offered, acknowledges it through the batch token, and it is never offered again.
    const reoffered = batch(await w.a.read());
    expect(reoffered.events.map(event => event.eventId)).toEqual([h1]);
    expect(await w.a.read(reoffered.token)).toEqual({ kind: 'empty' });
    expect(await w.a.read()).toEqual({ kind: 'empty' });
    expect(w.a.deliveries().get(offered.events[0]!.releaseId)).toBe(2);

    // Delivery continues after the restart, and the bound agents can still send.
    const h2 = await humanSays(again, 'H2 after the restart', 'txn-human-0102');
    expect(await receive(w.a, [h2])).toHaveLength(1);
    expect(await receive(w.b, [h1, h2])).toHaveLength(2);
    const sent = await w.b.send('E3 after the restart');
    if (sent.kind !== 'accepted') throw new Error(`B could not send: ${JSON.stringify(sent)}`);
    expect(await receive(w.a, [sent.eventId])).toHaveLength(1);
    assertUntouched(w);

    expect(await resumed.close()).toBe(0);
    open = null;
    assertCleanClose(await w.scenario.close());
  });
});
