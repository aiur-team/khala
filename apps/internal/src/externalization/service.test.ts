import fs from 'node:fs';
import path from 'node:path';
import type { SessionBinding } from '@khala/contracts/delivery/index';
import type { DeviceId, EventId, OwnerId, ParticipantId, RoomId } from '@khala/contracts/messaging/index';
import {
  type ConversionAccessPort, type ConversionAccessReadiness, type ConversionAgentBlock, type ConversionAgentIdentity,
  type ConversionBindingPort, type ConversionSessionCheck, type ConversionSessionPort, type ConversionVisibility,
  type HostedChannelCreated, type HostedChannelPort,
} from '@khala/contracts/messaging/externalization';
import { type OperationResult, ok, outcomeUnknown, rejected, unavailable } from '@khala/contracts/messaging/outcomes';
import { afterEach, describe, expect, it } from 'vitest';
import { createInternalListing } from '../composition/channel-discovery/listing';
import { type ChannelStore, type RegisteredParticipant, createChannelStore } from '../store/channel-store';
import { createDiscoveryStore } from '../store/discovery-store';
import { type InternalStoreHandle, openChannelStore } from '../store/open';
import { createConversionJournal } from './journal';
import { type ConversionService, type ConversionView, createConversionService } from './service';

const roots: string[] = [];
const closers: Array<() => void> = [];

afterEach(() => {
  for (const close of closers.splice(0)) close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const owner = 'owner-ada' as OwnerId;
const ada: RegisteredParticipant = { participantId: 'participant-ada' as ParticipantId, ownerId: owner, kind: 'human', displayName: 'Ada' };
const adaDevice = 'device-ada' as DeviceId;
const channelId = 'internal-channel' as RoomId;
const AGENTS = ['agent-1', 'agent-2', 'agent-3', 'agent-4'] as const;

/** The hosted side: channel creation, the access journal and inbox, activation, and conversion-paused bindings. */
class FakeHosted implements HostedChannelPort, ConversionAccessPort, ConversionBindingPort {
  readonly channels = new Map<string, HostedChannelCreated>();
  readonly creates: HostedChannelCreated[] = [];
  readonly requests = new Map<string, { agent: ConversionAgentIdentity; destination: string; granted: number; operationId: string }>();
  readonly bindings = new Map<string, { paused: boolean; direct: boolean }>();
  /** Order of effects, to prove no request precedes the destination. */
  readonly effects: string[] = [];
  createMode: 'ok' | 'lose_response' | 'unavailable' = 'ok';
  withheld = new Set<string>();
  blocked = new Map<string, ConversionAgentBlock>();
  releaseFails = new Set<string>();

  async create(input: Readonly<{ idempotencyKey: string; title: string | null; visibility: ConversionVisibility }>) {
    if (this.createMode === 'unavailable') return unavailable();
    let created = this.channels.get(input.idempotencyKey);
    if (!created) {
      created = { idempotencyKey: input.idempotencyKey, destinationChannelId: `external-${this.channels.size + 1}`, visibility: input.visibility };
      this.channels.set(input.idempotencyKey, created);
      this.creates.push(created);
      this.effects.push(`create:${created.destinationChannelId}`);
    }
    return this.createMode === 'lose_response' ? outcomeUnknown(input.idempotencyKey) : ok(created);
  }

  async reconcile(input: Readonly<{ idempotencyKey: string }>) {
    return ok(this.channels.get(input.idempotencyKey) ?? null);
  }

  async request(input: Readonly<{ operationId: string; destinationChannelId: string; agent: ConversionAgentIdentity }>) {
    const existing = [...this.requests].find(([, request]) => request.operationId === input.operationId);
    if (existing) return ok({ requestHandle: existing[0] });
    const handle = `careq_${input.agent.participantId}_${this.requests.size}`;
    this.requests.set(handle, { agent: input.agent, destination: input.destinationChannelId, granted: 0, operationId: input.operationId });
    this.effects.push(`request:${input.agent.participantId}`);
    return ok({ requestHandle: handle });
  }

  /** What a launcher shortcut would do: create a live binding without any request. */
  directBind(participantId: string): string {
    const handle = `direct_${participantId}`;
    this.bindings.set(handle, { paused: false, direct: true });
    return handle;
  }

  async grant(input: Readonly<{ requestHandle: string; operationId: string }>) {
    const request = this.requests.get(input.requestHandle);
    if (!request) return rejected('not_found' as const);
    request.granted += 1;
    return ok({ requestHandle: input.requestHandle });
  }

  async readiness(handle: string): Promise<ConversionAccessReadiness> {
    const request = this.requests.get(handle);
    if (!request) return { kind: 'unavailable' };
    const block = this.blocked.get(request.agent.participantId);
    if (block) return { kind: 'blocked', block };
    if (request.granted === 0) return { kind: 'pending_owner' };
    if (this.withheld.has(request.agent.participantId)) return { kind: 'granted' };
    // Activation readiness: the binding exists and is conversion-paused.
    if (!this.bindings.has(handle)) this.bindings.set(handle, { paused: true, direct: false });
    return { kind: 'ready' };
  }

  async release(input: Readonly<{ requestHandle: string; destinationChannelId: string; operationId: string }>) {
    const request = this.requests.get(input.requestHandle);
    if (!request || this.releaseFails.has(request.agent.participantId)) return 'unavailable' as const;
    this.bindings.get(input.requestHandle)!.paused = false;
    return 'released' as const;
  }

  /** A paused binding can neither publish nor receive. */
  canExchange(handle: string): boolean {
    return this.bindings.get(handle)?.paused === false;
  }
}

class FakeSessions implements ConversionSessionPort {
  readonly checks = new Map<string, ConversionSessionCheck>();
  readonly verified: ConversionAgentIdentity[] = [];
  async verify(agent: ConversionAgentIdentity) {
    this.verified.push(agent);
    return this.checks.get(agent.participantId) ?? 'current';
  }
}

type Harness = Readonly<{
  handle: InternalStoreHandle;
  store: ChannelStore;
  hosted: FakeHosted;
  sessions: FakeSessions;
  service: ConversionService;
  withFault: (fault: () => void) => ConversionService;
  send: () => string;
  events: () => number;
}>;

function harness(): Harness {
  const root = fs.mkdtempSync(path.join('/tmp', 'khala-conversion-'));
  fs.chmodSync(root, 0o700);
  roots.push(root);
  const handle = openChannelStore({ directory: path.join(root, 'state'), mode: 'create' });
  closers.push(() => handle.close());
  const store = createChannelStore(handle);
  store.registerParticipant(ada);
  store.registerDevice({ deviceId: adaDevice, participantId: ada.participantId });
  store.createChannel({
    operationId: 'create-internal', channelId, title: 'Internal', creatorOwnerId: owner,
    creatorParticipantId: ada.participantId, creatorDeviceId: adaDevice, createdAt: '2026-09-25T10:00:00.000Z',
  });
  for (const id of AGENTS) {
    const participantId = id as ParticipantId;
    store.registerParticipant({ participantId, ownerId: owner, kind: 'agent', displayName: id });
    store.registerDevice({ deviceId: `device-${id}` as DeviceId, participantId });
    store.registerBinding({
      v: 1, bindingId: `binding-${id}` as SessionBinding['bindingId'], ownerId: owner, agentParticipantId: participantId,
      deviceId: `device-${id}` as DeviceId, harness: 'codex', sessionId: `session-${id}`, generation: 1,
    });
    store.setMembership({ channelId, participantId, membership: 'joined' });
  }
  const hosted = new FakeHosted();
  const sessions = new FakeSessions();
  const journal = createConversionJournal(handle);
  const make = (beforeLink?: () => void) =>
    createConversionService({ journal, hosted, sessions, access: hosted, bindings: hosted, ...(beforeLink ? { beforeLink } : {}) });
  let sent = 0;
  return {
    handle, store, hosted, sessions,
    service: make(),
    withFault: fault => make(fault),
    send: () => {
      sent += 1;
      const result = store.send({
        channelId, eventId: `event-${sent}` as EventId, authorParticipantId: ada.participantId, authorDeviceId: adaDevice,
        clientTxnId: `txn-${sent}`, content: { v: 1, kind: 'text', body: `message ${sent}` }, receivedAt: '2026-09-25T11:00:00.000Z',
      });
      return result.kind === 'rejected' ? result.code : result.kind;
    },
    events: () => handle.read(db => Number((db.prepare('SELECT COUNT(*) AS n FROM events').get() as { n: number }).n)),
  };
}

const startInput = (over: Record<string, unknown> = {}) => ({
  v: 1, conversionId: 'conversion-1', operationId: 'op-start', sourceChannelId: channelId, historyMode: 'start_fresh',
  agents: ['agent-1', 'agent-2', 'agent-3'], ...over,
});

function value<T>(result: OperationResult<T, string>): T {
  if (result.kind !== 'ok') throw new Error(`expected ok, got ${JSON.stringify(result)}`);
  return result.value;
}

const handles = (view: ConversionView) => view.agents.map(agent => agent.requestHandle!);

/** Starts, grants every selected request in one batch and makes each ready. */
async function readyToCommit(h: Harness): Promise<ConversionView> {
  const started = value(await h.service.start(startInput()));
  value(await h.service.decide('conversion-1', { requestHandles: handles(started), operationId: 'batch-1' }));
  return value(await h.service.resume('conversion-1'));
}

describe('start-fresh conversion', () => {
  it('reconciles a lost create response to the same destination and never creates twice', async () => {
    const h = harness();
    h.hosted.createMode = 'lose_response';
    const view = value(await h.service.start(startInput()));
    expect(view.state).toBe('agents_pending');
    expect(view.destinationChannelId).toBe('external-1');
    h.hosted.createMode = 'ok';
    const again = value(await h.service.start(startInput()));
    expect(again.destinationChannelId).toBe('external-1');
    value(await h.service.resume('conversion-1'));
    expect(h.hosted.creates).toHaveLength(1);
  });

  it('makes no access request before the destination exists', async () => {
    const h = harness();
    h.hosted.createMode = 'unavailable';
    const view = value(await h.service.start(startInput()));
    expect(view.state).toBe('preparing');
    expect(h.hosted.requests.size).toBe(0);
    h.hosted.createMode = 'ok';
    value(await h.service.resume('conversion-1'));
    expect(h.hosted.effects[0]).toBe('create:external-1');
    expect(h.hosted.effects.slice(1)).toEqual(['request:agent-1', 'request:agent-2', 'request:agent-3']);
  });

  it('defaults an omitted visibility to secret and honors each explicit choice', async () => {
    const h = harness();
    expect(value(await h.service.start(startInput())).visibility).toBe('secret');
    expect(h.hosted.creates[0]!.visibility).toBe('secret');
    for (const visibility of ['public', 'private', 'secret'] as const) {
      const other = harness();
      value(await other.service.start(startInput({ visibility })));
      expect(other.hosted.creates[0]!.visibility).toBe(visibility);
    }
    expect((await h.service.start(startInput({ conversionId: 'c2', operationId: 'op2', visibility: 'open' }))).kind).toBe('rejected');
  });

  it('refuses a changed conversion choice under the same conversion', async () => {
    const h = harness();
    value(await h.service.start(startInput()));
    expect(await h.service.start(startInput({ operationId: 'op-other', agents: ['agent-1'] }))).toEqual(rejected('conflict'));
    expect(await h.service.start(startInput({ visibility: 'public' }))).toEqual(rejected('conflict'));
    expect(await h.service.start(startInput({ conversionId: 'conversion-2', operationId: 'op-2' }))).toEqual(rejected('conflict'));
    // Once cancelled the source is free, but the conversion ID still names the first choice.
    value(await h.service.cancel('conversion-1'));
    expect(await h.service.start(startInput({ operationId: 'op-again', agents: ['agent-1'] }))).toEqual(rejected('conflict'));
    expect(value(await h.service.view('conversion-1')).agents.map(agent => agent.participantId)).toEqual(['agent-1', 'agent-2', 'agent-3']);
  });

  it('makes one request per selected agent and grants exactly those from one batch decision', async () => {
    const h = harness();
    const started = value(await h.service.start(startInput()));
    expect(h.hosted.requests.size).toBe(3);
    const intruder = value(await h.hosted.request({
      operationId: 'foreign', destinationChannelId: started.destinationChannelId!,
      agent: { participantId: 'agent-4', harness: 'codex', sessionId: 'session-agent-4', generation: 1 },
    })).requestHandle;
    const decided = value(await h.service.decide('conversion-1', { requestHandles: [...handles(started), intruder], operationId: 'batch-1' }));
    expect(decided.granted).toEqual(handles(started));
    expect(decided.refused).toEqual([intruder]);
    for (const handle of handles(started)) expect(h.hosted.requests.get(handle)!.granted).toBe(1);
    expect(h.hosted.requests.get(intruder)!.granted).toBe(0);
    expect(decided.view.agents.map(agent => agent.status)).toEqual(['ready', 'ready', 'ready']);
  });

  it('never counts a launcher-side direct binding as a ready agent', async () => {
    const h = harness();
    const started = value(await h.service.start(startInput({ agents: ['agent-1'] })));
    h.hosted.directBind('agent-1');
    const view = value(await h.service.resume('conversion-1'));
    expect(view.agents[0]!.status).toBe('requested');
    expect(view.canCommit).toBe(false);
    expect(await h.service.commit('conversion-1')).toEqual(rejected('not_ready'));
    expect(h.hosted.requests.get(handles(started)[0]!)!.granted).toBe(0);
  });

  it('keeps commit disabled while one readiness result is withheld', async () => {
    const h = harness();
    h.hosted.withheld.add('agent-2');
    const view = await readyToCommit(h);
    expect(view.agents.map(agent => agent.status)).toEqual(['ready', 'requested', 'ready']);
    expect(view.canCommit).toBe(false);
    expect(await h.service.commit('conversion-1')).toEqual(rejected('not_ready'));
    expect(h.send()).toBe('stored');
  });

  it('blocks stale, revoked and unsupported sessions until re-invited or skipped', async () => {
    const h = harness();
    h.sessions.checks.set('agent-1', 'stale_session');
    h.sessions.checks.set('agent-2', 'revoked');
    h.sessions.checks.set('agent-3', 'unsupported');
    const view = value(await h.service.start(startInput()));
    expect(view.agents.map(agent => [agent.status, agent.block])).toEqual([
      ['blocked', 'stale_session'], ['blocked', 'revoked'], ['blocked', 'unsupported'],
    ]);
    expect(h.hosted.requests.size).toBe(0);
    expect(view.canCommit).toBe(false);
    h.sessions.checks.delete('agent-1');
    const retried = value(await h.service.retry('conversion-1', 'agent-1'));
    expect(retried.agents[0]).toMatchObject({ status: 'requested', attempt: 1 });
    value(await h.service.skip('conversion-1', 'agent-2'));
    expect(value(await h.service.retry('conversion-1', 'agent-3')).agents[2]).toMatchObject({ status: 'blocked', block: 'unsupported' });
    expect(h.sessions.verified.every(agent => agent.sessionId === `session-${agent.participantId}` && agent.generation === 1)).toBe(true);
  });

  it('re-verifies the exact sessions at commit and blocks one that changed', async () => {
    const h = harness();
    await readyToCommit(h);
    h.sessions.checks.set('agent-3', 'stale_session');
    expect(await h.service.commit('conversion-1')).toEqual(rejected('not_ready'));
    const view = value(await h.service.view('conversion-1'));
    expect(view.agents[2]).toMatchObject({ status: 'blocked', block: 'stale_session' });
    expect(h.send()).toBe('stored');
  });

  it('keeps a ready destination binding paused until the link commit releases it', async () => {
    const h = harness();
    const view = await readyToCommit(h);
    for (const handle of handles(view)) expect(h.hosted.canExchange(handle)).toBe(false);
    const committed = value(await h.service.commit('conversion-1'));
    expect(committed.state).toBe('externalized');
    for (const handle of handles(view)) expect(h.hosted.canExchange(handle)).toBe(true);
  });

  it('commits a skipped agent without ever requesting its release', async () => {
    const h = harness();
    h.hosted.blocked.set('agent-2', 'denied');
    const view = await readyToCommit(h);
    expect(view.agents[1]).toMatchObject({ status: 'blocked', block: 'denied' });
    value(await h.service.skip('conversion-1', 'agent-2'));
    const committed = value(await h.service.commit('conversion-1'));
    expect(committed.state).toBe('externalized');
    expect(h.hosted.canExchange(view.agents[1]!.requestHandle!)).toBe(false);
  });

  it('invalidates an old local listing reference at the link commit', async () => {
    const h = harness();
    const discovery = createDiscoveryStore(h.handle);
    expect(discovery.updateSettings({ channelId, operationId: 'vis', expectedRevision: 0, change: { kind: 'visibility', visibility: 'public' } }).kind).toBe('done');
    const listing = createInternalListing({ store: discovery, clock: () => 1_000 });
    const caller = { principal: 'agent:someone', generation: 1 };
    const listed = listing.list(caller, null);
    if (listed.kind !== 'listed') throw new Error('list');
    const reference = listed.page.items[0]!.listingRef;
    await readyToCommit(h);
    expect(listing.resolve(caller, reference)).toMatchObject({ channelId });
    value(await h.service.commit('conversion-1'));
    expect(listing.resolve(caller, reference)).toBe('unavailable');
    const relisted = listing.list({ principal: 'agent:someone', generation: 2 }, null);
    expect(relisted.kind === 'listed' && relisted.page.items).toEqual([]);
  });

  it('unfreezes the source when the commit fails immediately before the link', async () => {
    const h = harness();
    await readyToCommit(h);
    let pausedAtFault: string | null = null;
    const failing = h.withFault(() => {
      pausedAtFault = h.send();
      throw new Error('crash before link');
    });
    const view = value(await failing.commit('conversion-1'));
    expect(pausedAtFault).toBe('read_only');
    expect(view.state).toBe('failed');
    expect(view.orphanDestinationChannelId).toBe('external-1');
    expect(h.send()).toBe('stored');
    for (const handle of handles(view)) expect(h.hosted.canExchange(handle)).toBe(false);
  });

  it('keeps the source read-only and only resumes release after a failure past the link', async () => {
    const h = harness();
    const ready = await readyToCommit(h);
    h.hosted.releaseFails.add('agent-2');
    const partial = value(await h.service.commit('conversion-1'));
    expect(partial.state).toBe('activating');
    expect(partial.agents.map(agent => agent.released)).toEqual([true, false, false]);
    expect(h.send()).toBe('read_only');
    expect(await h.service.cancel('conversion-1')).toEqual(rejected('wrong_state'));
    h.hosted.releaseFails.clear();
    const resumed = value(await h.service.resume('conversion-1'));
    expect(resumed.state).toBe('externalized');
    for (const handle of handles(ready)) expect(h.hosted.canExchange(handle)).toBe(true);
    expect(h.send()).toBe('read_only');
  });

  it('reports the orphan destination when cancelled before commit and reopens the source', async () => {
    const h = harness();
    value(await h.service.start(startInput()));
    const view = value(await h.service.cancel('conversion-1'));
    expect(view).toMatchObject({ state: 'cancelled', orphanDestinationChannelId: 'external-1' });
    expect(h.send()).toBe('stored');
    expect(value(await h.service.start(startInput({ conversionId: 'conversion-2', operationId: 'op-2' }))).state).toBe('agents_pending');
  });

  it('sends no source message into the destination', async () => {
    const h = harness();
    h.send();
    h.send();
    const before = h.events();
    await readyToCommit(h);
    value(await h.service.commit('conversion-1'));
    expect(h.events()).toBe(before);
    expect(h.hosted.effects.every(effect => effect.startsWith('create:') || effect.startsWith('request:'))).toBe(true);
  });

  it('refuses carry-history conversions, which this service does not transfer', async () => {
    const h = harness();
    expect(await h.service.start(startInput({ historyMode: 'carry_history' }))).toEqual(rejected('unsupported'));
  });
});
