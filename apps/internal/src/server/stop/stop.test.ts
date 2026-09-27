import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import { type ClientRequest, type IncomingMessage, request as httpRequest } from 'node:http';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SessionBinding } from '@khala/contracts/delivery/index';
import type { DeviceId, ParticipantId } from '@khala/contracts/messaging/index';
import { encodeInternalDescriptor, parseInternalDescriptor } from '@khala/contracts/internal/descriptor';
import { composeBindingControl } from '../../composition/binding-control/index';
import { writeActiveDescriptor } from '../../descriptor/write';
import type { ChannelStore } from '../../store/channel-store';
import { type ChannelServerOptions, startChannelServer } from '../channel-server';
import { mintCredential } from '../credentials';
import {
  bob, bobBinding, carolBinding, channelId, createChannelFixture, otherChannelId, type ChannelFixture,
} from '../fixtures/channel-fixture';
import type { LoopbackServer } from '../server';

const NOW = Date.parse('2026-09-25T00:00:00.000Z');
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// A binding activated through channel access in an earlier launch: durable, with no live capability.
const daveBinding: SessionBinding = {
  ...bobBinding,
  bindingId: 'binding-dave' as SessionBinding['bindingId'],
  agentParticipantId: 'participant-dave' as ParticipantId,
  deviceId: 'device-dave' as DeviceId,
  harness: 'claude',
  sessionId: 'session-dave',
};

function addActivatedDave(fx: ChannelFixture): void {
  fx.store.registerParticipant({ participantId: daveBinding.agentParticipantId, ownerId: bob.ownerId, kind: 'agent', displayName: 'Dave' });
  fx.store.registerDevice({ deviceId: daveBinding.deviceId, participantId: daveBinding.agentParticipantId });
  fx.store.setMembership({ channelId, participantId: daveBinding.agentParticipantId, membership: 'joined' });
  fx.handle.transaction(db => {
    db.prepare(`
      INSERT INTO bindings (binding_id, generation, owner_id, participant_id, device_id, harness, session_id, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
    `).run(daveBinding.bindingId, 1, daveBinding.ownerId, daveBinding.agentParticipantId, daveBinding.deviceId, 'claude', 'session-dave');
    db.prepare(`
      INSERT INTO discovery_activations (operation_key, binding_id, generation, channel_id, session_generation)
      VALUES ('op-dave', ?, 1, ?, 1)
    `).run(daveBinding.bindingId, channelId);
  });
}

type Harness = Readonly<{ fixture: ChannelFixture; server: LoopbackServer; origin: string }>;

async function start(input: Readonly<{
  overrides?: Partial<ChannelServerOptions>;
  store?: (store: ChannelStore) => ChannelStore;
  carolInChannelOne?: boolean;
  noStop?: boolean;
}> = {}): Promise<Harness> {
  const fx = createChannelFixture({ root: fs.mkdtempSync('/tmp/khala-stop-'), now: NOW });
  cleanups.push(() => fx.dispose());
  if (input.carolInChannelOne) fx.store.setMembership({ channelId, participantId: carolBinding.agentParticipantId, membership: 'joined' });
  const control = composeBindingControl({ handle: fx.handle, root: fx.root });
  let id = 0;
  const server = await startChannelServer({
    store: input.store ? input.store(fx.store) : fx.store,
    bootstrap: [fx.bootstrap],
    bindings: [fx.bob, input.carolInChannelOne ? { ...fx.carol, channels: [channelId, otherChannelId] } : fx.carol],
    newId: () => `id-${++id}`,
    clock: () => NOW,
    startPort: 0,
    ...(input.noStop ? {} : { stop: control }),
    ...input.overrides,
  });
  cleanups.push(() => server.close());
  return { fixture: fx, server, origin: server.origin };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Reply = Readonly<{ status: number; headers: IncomingMessage['headers']; text: string; json: any }>;

function collect(request: ClientRequest): Promise<Reply> {
  return new Promise((resolve, reject) => {
    request.once('error', reject);
    request.once('response', response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.once('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: unknown = null;
        try { json = JSON.parse(text); } catch { /* Not JSON. */ }
        resolve({ status: response.statusCode ?? 0, headers: response.headers, text, json });
      });
    });
  });
}

function open(port: number, input: Readonly<{ method?: string; path: string; headers?: Record<string, string>; length?: number }>) {
  return httpRequest({
    host: '127.0.0.1',
    port,
    method: input.method ?? 'GET',
    path: input.path,
    headers: {
      host: `127.0.0.1:${port}`,
      ...(input.length === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(input.length) }),
      ...input.headers,
    },
  });
}

function call(port: number, input: Readonly<{ method?: string; path: string; headers?: Record<string, string>; body?: unknown }>) {
  const body = input.body === undefined ? undefined : JSON.stringify(input.body);
  const request = open(port, { ...input, ...(body === undefined ? {} : { length: Buffer.byteLength(body) }) });
  const reply = collect(request);
  request.end(body);
  return reply;
}

async function humanSession(h: Harness): Promise<Record<string, string>> {
  const reply = await call(h.server.port, {
    method: 'POST', path: '/__khala/session', headers: { origin: h.origin },
    body: { credential: h.fixture.bootstrap.credential, channelId },
  });
  expect(reply.status).toBe(200);
  const cookie = String(reply.headers['set-cookie']![0]).split(';')[0]!;
  return { cookie, 'x-khala-request-secret': reply.json.requestSecret, origin: h.origin };
}

const bearer = (credential: string) => ({ authorization: `Bearer ${credential}` });
const message = (body: string) => ({ clientTxnId: `txn-${body.replaceAll(" ", "-")}`, content: { v: 1, kind: 'text', body } });
const STOP_PATH = `/api/v1/channels/${channelId}/stop`;
const stopAll = { v: 1, targets: null };
const bobTarget = { bindingId: 'binding-bob', generation: 1, agentParticipantId: 'participant-bob' };

/** An independently started, user-owned process standing in for the agent CLI. */
function startUserCli(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60_000)'], { stdio: 'ignore' });
  cleanups.push(() => { child.kill('SIGKILL'); });
  return child;
}

function stillRunning(child: ChildProcess): boolean {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return false;
  try {
    process.kill(child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('binding Stop endpoint admission', () => {
  it('admits only the human session with its request secret and exact Origin', async () => {
    const h = await start();
    const human = await humanSession(h);
    const port = h.server.port;

    expect((await call(port, { method: 'POST', path: STOP_PATH, headers: bearer(h.fixture.bob.credential), body: stopAll })).status).toBe(403);
    const without = (name: string) => Object.fromEntries(Object.entries(human).filter(([key]) => key !== name));
    const noOrigin = without('origin');
    expect((await call(port, { method: 'POST', path: STOP_PATH, headers: noOrigin, body: stopAll })).json)
      .toEqual({ error: { code: 'forbidden_origin' } });
    expect((await call(port, { method: 'POST', path: STOP_PATH, headers: { ...human, origin: 'http://127.0.0.1:1' }, body: stopAll }))
      .status).toBe(403);
    expect((await call(port, { method: 'POST', path: STOP_PATH, headers: { ...human, 'sec-fetch-site': 'cross-site' }, body: stopAll }))
      .status).toBe(403);
    expect((await call(port, { method: 'POST', path: STOP_PATH, headers: { ...human, host: 'localhost' }, body: stopAll })).json)
      .toEqual({ error: { code: 'invalid_host' } });
    const noSecret = without('x-khala-request-secret');
    expect((await call(port, { method: 'POST', path: STOP_PATH, headers: noSecret, body: stopAll })).status).toBe(401);
    expect((await call(port, { method: 'GET', path: STOP_PATH, headers: human })).status).toBe(405);

    // None of the refused requests revoked anything.
    expect((await call(port, { path: `/api/v1/channels/${channelId}/timeline`, headers: bearer(h.fixture.bob.credential) })).status)
      .toBe(200);
  });

  it('refuses malformed bodies and channels the human cannot open', async () => {
    const h = await start();
    const human = await humanSession(h);
    const port = h.server.port;
    for (const body of [
      {}, { v: 2, targets: null }, { v: 1 }, { v: 1, targets: [] }, { v: 1, targets: 'all' }, { v: 1, targets: null, extra: 1 },
      { v: 1, targets: [{ bindingId: 'binding-bob', agentParticipantId: 'participant-bob' }] },
      { v: 1, targets: [{ bindingId: 'binding-bob', generation: -1, agentParticipantId: 'participant-bob' }] },
      { v: 1, targets: [{ bindingId: 'binding-bob', generation: 1 }] },
      { v: 1, targets: [{ bindingId: 'binding-bob', generation: 1, agentParticipantId: '' }] },
      { v: 1, targets: [bobTarget, bobTarget] },
    ]) {
      expect((await call(port, { method: 'POST', path: STOP_PATH, headers: human, body })).status, JSON.stringify(body)).toBe(400);
    }
    expect((await call(port, { method: 'POST', path: '/api/v1/channels/nope/stop', headers: human, body: stopAll })).status).toBe(404);
  });

  it('is absent when the composition supplies no Stop control', async () => {
    const h = await start({ noStop: true });
    const human = await humanSession(h);
    expect((await call(h.server.port, { method: 'POST', path: STOP_PATH, headers: human, body: stopAll })).status).toBe(404);
  });
});

describe('binding Stop', () => {
  it('revokes every binding of the channel and leaves the server, timeline and other channels usable', async () => {
    const h = await start({ carolInChannelOne: true });
    addActivatedDave(h.fixture);
    const human = await humanSession(h);
    const port = h.server.port;
    const cli = startUserCli();

    const reply = await call(port, { method: 'POST', path: STOP_PATH, headers: human, body: stopAll });
    expect(reply.status).toBe(200);
    expect(reply.json.outcome).toBe('stopped');
    expect(reply.json.remaining).toEqual([]);
    expect(reply.json.stopped.map((entry: { bindingId: string }) => entry.bindingId).sort())
      .toEqual(['binding-bob', 'binding-carol', 'binding-dave']);
    expect(reply.json.stopped.find((entry: { bindingId: string }) => entry.bindingId === 'binding-dave'))
      .toEqual({ bindingId: 'binding-dave', generation: 1, harness: 'claude', agentParticipantId: 'participant-dave' });

    // Capabilities and delivery are gone, including in the other channel the capability covered.
    for (const credential of [h.fixture.bob.credential, h.fixture.carol.credential]) {
      expect((await call(port, { path: `/api/v1/channels/${channelId}/timeline`, headers: bearer(credential) })).status).toBe(401);
      expect((await call(port, { method: 'POST', path: `/api/v1/channels/${channelId}/messages`, headers: bearer(credential), body: message('late') }))
        .status).toBe(401);
    }
    expect((await call(port, { path: `/api/v1/channels/${otherChannelId}/timeline`, headers: bearer(h.fixture.carol.credential) })).status)
      .toBe(401);
    for (const binding of [bobBinding, carolBinding, daveBinding]) {
      const row = h.fixture.store.binding(binding);
      expect(row.kind === 'done' && row.binding.status).toBe('revoked');
    }

    // The human keeps the server, the channel timeline and sending.
    expect((await call(port, { method: 'POST', path: `/api/v1/channels/${channelId}/messages`, headers: human, body: message('still here') }))
      .status).toBe(201);
    const timeline = await call(port, { path: `/api/v1/channels/${channelId}/timeline`, headers: human });
    expect(timeline.status).toBe(200);
    expect(timeline.json.events.map((event: { content: { body: string } }) => event.content.body)).toEqual(['still here']);
    expect(stillRunning(cli)).toBe(true);

    // A repeated Stop is idempotent and reports nothing left.
    const again = await call(port, { method: 'POST', path: STOP_PATH, headers: human, body: stopAll });
    expect(again.json).toEqual({ v: 1, outcome: 'stopped', stopped: [], remaining: [] });
  });

  it('ends release pulls for a stopped binding', async () => {
    const reads: string[] = [];
    const h = await start({
      overrides: {
        releases: {
          read: ({ binding }) => {
            reads.push(binding.bindingId);
            return { kind: 'page', releases: [], nextCursor: 'cursor-1', caughtUp: true };
          },
        },
      },
    });
    const human = await humanSession(h);
    const port = h.server.port;
    const releasesPath = `/api/v1/channels/${channelId}/releases`;

    expect((await call(port, { path: releasesPath, headers: bearer(h.fixture.bob.credential) })).status).toBe(200);
    expect((await call(port, { method: 'POST', path: STOP_PATH, headers: human, body: stopAll })).json.outcome).toBe('stopped');
    expect((await call(port, { path: releasesPath, headers: bearer(h.fixture.bob.credential) })).status).toBe(401);
    expect(reads).toEqual(['binding-bob']);
  });

  it('removes the granted binding fields from the runtime descriptor and keeps discovery', async () => {
    const h = await start();
    const human = await humanSession(h);
    const transportCapability = mintCredential();
    writeActiveDescriptor(h.fixture.root, {
      v: 1, channelId, origin: h.origin, transportCapability,
      grantRef: 'grant-bob', bindingId: bobBinding.bindingId, bindingCapability: h.fixture.bob.credential,
    });

    const reply = await call(h.server.port, { method: 'POST', path: STOP_PATH, headers: human, body: stopAll });
    expect(reply.json.outcome).toBe('stopped');
    const text = fs.readFileSync(path.join(h.fixture.root, 'active.json'), 'utf8');
    expect(text).toBe(encodeInternalDescriptor({ v: 1, channelId, origin: h.origin, transportCapability }));
    expect(parseInternalDescriptor(text).ok).toBe(true);
    expect(text).not.toContain(h.fixture.bob.credential);
  });

  it('stops only exact recorded targets and refuses a stale, unknown or wrong-participant one', async () => {
    const h = await start({ carolInChannelOne: true });
    const human = await humanSession(h);
    const port = h.server.port;

    for (const targets of [
      [{ ...bobTarget, generation: 2 }],
      [{ ...bobTarget, bindingId: 'binding-nobody' }],
      [{ ...bobTarget, agentParticipantId: carolBinding.agentParticipantId }],
      // A mismatch anywhere in the list refuses the whole Stop, including the valid Bob target.
      [bobTarget, { bindingId: 'binding-carol', generation: 1, agentParticipantId: 'participant-bob' }],
    ]) {
      const refused = await call(port, { method: 'POST', path: STOP_PATH, headers: human, body: { v: 1, targets } });
      expect(refused.status, JSON.stringify(targets)).toBe(409);
    }
    // Each agent still reads the channel it was admitted to.
    for (const [credential, channel] of [[h.fixture.bob.credential, channelId], [h.fixture.carol.credential, otherChannelId]] as const) {
      expect((await call(port, { path: `/api/v1/channels/${channel}/timeline`, headers: bearer(credential) })).status).toBe(200);
    }
    for (const binding of [bobBinding, carolBinding]) {
      const row = h.fixture.store.binding(binding);
      expect(row.kind === 'done' && row.binding.status).toBe('active');
    }

    const reply = await call(port, {
      method: 'POST', path: STOP_PATH, headers: human, body: { v: 1, targets: [bobTarget] },
    });
    expect(reply.json.stopped.map((entry: { bindingId: string }) => entry.bindingId)).toEqual(['binding-bob']);
    expect((await call(port, { path: `/api/v1/channels/${channelId}/timeline`, headers: bearer(h.fixture.bob.credential) })).status)
      .toBe(401);
    expect((await call(port, { path: `/api/v1/channels/${otherChannelId}/timeline`, headers: bearer(h.fixture.carol.credential) })).status)
      .toBe(200);
  });

  it('names bindings whose revocation failed, never claims success, and succeeds on retry', async () => {
    let failRevoke = true;
    const h = await start({
      carolInChannelOne: true,
      store: store => ({
        ...store,
        revokeBinding: key => (failRevoke && key.bindingId === 'binding-carol' ? { kind: 'unavailable' } : store.revokeBinding(key)),
      }),
    });
    const human = await humanSession(h);
    const port = h.server.port;

    const partial = await call(port, { method: 'POST', path: STOP_PATH, headers: human, body: stopAll });
    expect(partial.status).toBe(200);
    expect(partial.json.outcome).toBe('partial');
    expect(partial.json.stopped.map((entry: { bindingId: string }) => entry.bindingId)).toEqual(['binding-bob']);
    expect(partial.json.remaining).toEqual([
      { bindingId: 'binding-carol', generation: 1, harness: 'codex', agentParticipantId: carolBinding.agentParticipantId, reason: 'revoke_failed' },
    ]);
    // Durably still active, yet it can no longer commit or read: the barrier stays raised.
    expect((await call(port, { method: 'POST', path: `/api/v1/channels/${channelId}/messages`, headers: bearer(h.fixture.carol.credential), body: message('x') }))
      .status).toBe(401);

    failRevoke = false;
    const retried = await call(port, { method: 'POST', path: STOP_PATH, headers: human, body: stopAll });
    expect(retried.json).toEqual({
      v: 1, outcome: 'stopped', remaining: [],
      stopped: [{ bindingId: 'binding-carol', generation: 1, harness: 'codex', agentParticipantId: carolBinding.agentParticipantId }],
    });
  });

  it('ends a bound agent hint stream at once', async () => {
    const h = await start();
    const human = await humanSession(h);
    const stream = open(h.server.port, { path: `/api/v1/channels/${channelId}/hints`, headers: bearer(h.fixture.bob.credential) });
    const ended = new Promise<string>((resolve, reject) => {
      stream.once('error', reject);
      stream.once('response', response => {
        let text = '';
        response.on('data', chunk => { text += String(chunk); });
        response.once('end', () => resolve(text));
      });
    });
    stream.end();
    // Wait for the stream to open before stopping.
    await new Promise<void>(resolve => stream.once('response', response => response.once('data', () => resolve())));
    expect((await call(h.server.port, { method: 'POST', path: STOP_PATH, headers: human, body: stopAll })).json.outcome).toBe('stopped');
    expect(await ended).toContain('event: ready');
  });

  it('wrong implementation: a send blocked during Stop cannot commit after Stop reports success', async () => {
    let authenticated: () => void = () => {};
    const bobAuthenticated = new Promise<void>(resolve => { authenticated = resolve; });
    const h = await start({
      // Signals once the send's authentication has read bob's live binding row.
      store: store => ({
        ...store,
        binding: binding => {
          const read = store.binding(binding);
          if (binding.bindingId === bobBinding.bindingId) authenticated();
          return read;
        },
      }),
    });
    const human = await humanSession(h);
    const port = h.server.port;
    const cli = startUserCli();

    const body = JSON.stringify(message('after stop'));
    const send = open(port, {
      method: 'POST', path: `/api/v1/channels/${channelId}/messages`, headers: bearer(h.fixture.bob.credential), length: Buffer.byteLength(body),
    });
    const sent = collect(send);
    send.write(body.slice(0, 10));
    await bobAuthenticated;

    const stop = await call(port, { method: 'POST', path: STOP_PATH, headers: human, body: stopAll });
    expect(stop.json.outcome).toBe('stopped');

    send.end(body.slice(10));
    const late = await sent;
    expect(late.status, late.text).toBe(401);
    const timeline = await call(port, { path: `/api/v1/channels/${channelId}/timeline`, headers: human });
    expect(timeline.status).toBe(200);
    expect(timeline.json.events).toEqual([]);
    expect(stillRunning(cli)).toBe(true);
  });
});
