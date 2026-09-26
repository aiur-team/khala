import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { runCli } from '@aiur/khala/cli/app';
import { type BatchInbox, openInbox } from '@aiur/khala/cli/inbox';
import { createInternalClient } from '@aiur/khala/composition/internal';
import { type InternalDelivery, createInternalDelivery } from '@aiur/khala/composition/internal-delivery';
import { encodeInternalDescriptor } from '@khala/contracts/internal/descriptor';
import type { EventId, ParticipantId } from '@khala/contracts/messaging/index';
import { afterEach, describe, expect, it } from 'vitest';
import { createSqliteListeningModeRepository } from '../../listening-mode-store/sqlite';
import { type ChannelServerOptions, startChannelServer } from '../../server/channel-server';
import { mintCredential } from '../../server/credentials';
import {
  alice, aliceDevice, bob, bobBinding, bobDevice, channelId, createChannelFixture, type ChannelFixture,
} from '../../server/fixtures/channel-fixture';
import type { LogEvent, LoopbackServer } from '../../server/server';
import { type PauseRead, createInternalReleaseFeed, internalReleaseId } from './release-feed';

const NOW = Date.parse('2026-09-25T00:00:00.000Z');
const BODY = 'the secret plan is under the mat';
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Harness = Readonly<{
  fixture: ChannelFixture;
  server: LoopbackServer;
  logs: LogEvent[];
  descriptorPath: string;
  stateDirectory: string;
  pause: { value: PauseRead };
  restartServer(): Promise<LoopbackServer>;
}>;

async function start(overrides: Partial<ChannelServerOptions> = {}): Promise<Harness> {
  const root = fs.mkdtempSync('/tmp/khala-delivery-');
  const fixture = createChannelFixture({ root, now: NOW });
  cleanups.push(() => fixture.dispose());
  const logs: LogEvent[] = [];
  const pause = { value: false as PauseRead };
  const stateDirectory = path.join(root, 'agent-state');
  const descriptorPath = path.join(root, 'descriptor.json');
  let id = 0;
  const launch = async () => {
    const server = await startChannelServer({
      store: fixture.store,
      bootstrap: [fixture.bootstrap],
      bindings: [fixture.bob],
      releases: createInternalReleaseFeed({
        store: fixture.store,
        listeningModes: createSqliteListeningModeRepository(fixture.handle),
        paused: () => pause.value,
      }),
      newId: () => `id-${++id}`,
      clock: () => NOW,
      log: event => logs.push(event),
      startPort: 0,
      ...overrides,
    });
    cleanups.push(() => server.close());
    fs.writeFileSync(descriptorPath, encodeInternalDescriptor({
      v: 1, channelId, origin: server.origin, transportCapability: mintCredential(),
      grantRef: 'grant-bob', bindingId: bobBinding.bindingId, bindingCapability: fixture.bob.credential,
    }), { mode: 0o600 });
    return server;
  };
  let server = await launch();
  return {
    fixture, get server() { return server; }, logs, descriptorPath, stateDirectory, pause,
    async restartServer() {
      await server.close();
      server = await launch();
      return server;
    },
  };
}

let sent = 0;
function say(h: Harness, body: string, author: 'alice' | 'bob' = 'alice'): EventId {
  const eventId = `event-${++sent}` as EventId;
  const result = h.fixture.store.send({
    channelId,
    eventId,
    authorParticipantId: (author === 'alice' ? alice.participantId : bob.participantId) as ParticipantId,
    authorDeviceId: author === 'alice' ? aliceDevice : bobDevice,
    clientTxnId: `txn-${sent}`,
    content: { v: 1, kind: 'text', body },
    receivedAt: new Date(NOW + sent).toISOString(),
  });
  expect(result.kind).toBe('stored');
  return eventId;
}

function inboxFor(h: Harness, generation = bobBinding.generation): () => Promise<BatchInbox> {
  return () => openInbox({
    stateDirectory: h.stateDirectory, bindingId: bobBinding.bindingId, generation,
    maxPayloadBytes: 64 * 1024, maxSelectionEvents: 32,
  });
}

function delivery(h: Harness, extra: Partial<Parameters<typeof createInternalDelivery>[0]> = {}): InternalDelivery {
  return createInternalDelivery({ descriptorPath: h.descriptorPath, stateDirectory: h.stateDirectory, ...extra });
}

const held = { bindingId: bobBinding.bindingId, generation: bobBinding.generation };

/** Every record durable in the inbox, oldest first. */
async function records(open: () => Promise<BatchInbox>): Promise<string[]> {
  const inbox = await open();
  const batch = await inbox.acquireListener().then(async listener => {
    try { return await listener.readBatch({ maxBytes: 1024 * 1024 }); } finally { await listener.release(); }
  });
  return batch?.items.map(item => item.record.releaseId) ?? [];
}

async function khala(h: Harness, args: readonly string[]) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const chunks = { out: '', err: '' };
  stdout.on('data', chunk => { chunks.out += String(chunk); });
  stderr.on('data', chunk => { chunks.err += String(chunk); });
  const code = await runCli(['--internal-descriptor', h.descriptorPath, ...args], {
    client: null as never,
    inbox: (bindingId, generation) => openInbox({
      stateDirectory: h.stateDirectory, bindingId, generation, maxPayloadBytes: 64 * 1024, maxSelectionEvents: 32,
    }),
    stdin: new PassThrough(), stdout, stderr,
    internalClient: async descriptorPath => createInternalClient({ descriptorPath }),
    internalDelivery: async descriptorPath => createInternalDelivery({ descriptorPath, stateDirectory: h.stateDirectory }),
  });
  return { code, ...chunks };
}

const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

describe('internal inbox delivery', () => {
  it('shows a human message exactly once in khala read, and never again after acknowledgement', async () => {
    const h = await start();
    const eventId = say(h, BODY);
    const releaseId = internalReleaseId(bobBinding, eventId);

    const first = await khala(h, ['read']);
    expect(first.code).toBe(0);
    expect(occurrences(first.out, `releaseId: ${releaseId}`)).toBe(1);
    expect(occurrences(first.out, BODY)).toBe(1);
    const token = /batchToken: (\S+)/.exec(first.out)![1]!;

    const acknowledged = await khala(h, ['read', '--ack', token]);
    expect(acknowledged.code).toBe(0);
    expect(JSON.parse(acknowledged.out)).toEqual({ ok: true, kind: 'empty' });
    // A later pull neither re-delivers nor re-offers the acknowledged release.
    expect(JSON.parse((await khala(h, ['read'])).out)).toEqual({ ok: true, kind: 'empty' });
    expect(await records(inboxFor(h))).toEqual([]);
  });

  it('re-pulls after a crash between enqueue and cursor commit without duplicating', async () => {
    const h = await start();
    const firstEvent = say(h, BODY);
    const crashing = delivery(h, { beforeCursorCommit: () => { throw new Error('crash'); } });
    expect(await crashing.pull(held, inboxFor(h))).toBe('unavailable');

    // Restart: a new delivery and a new server over the same durable state.
    await h.restartServer();
    const secondEvent = say(h, 'sent while the agent was away');
    expect(await delivery(h).pull(held, inboxFor(h))).toBe('caught_up');
    expect(await delivery(h).pull(held, inboxFor(h))).toBe('caught_up');
    expect(await records(inboxFor(h))).toEqual([
      internalReleaseId(bobBinding, firstEvent),
      internalReleaseId(bobBinding, secondEvent),
    ]);
  });

  it('skips the agent’s own messages', async () => {
    const h = await start();
    say(h, 'from bob', 'bob');
    const human = say(h, BODY);
    expect(await delivery(h).pull(held, inboxFor(h))).toBe('caught_up');
    expect(await records(inboxFor(h))).toEqual([internalReleaseId(bobBinding, human)]);
  });

  it('delivers nothing to a revoked generation', async () => {
    const h = await start();
    say(h, BODY);
    expect(h.fixture.store.revokeBinding(held).kind).toBe('done');
    expect(await delivery(h).pull(held, inboxFor(h))).toBe('revoked');
    expect(await records(inboxFor(h))).toEqual([]);
  });

  it('delivers nothing to a stale generation once a newer one exists', async () => {
    const h = await start();
    say(h, BODY);
    expect(h.fixture.store.registerBinding({ ...bobBinding, generation: 2 }).kind).toBe('done');
    expect(await delivery(h).pull(held, inboxFor(h))).toBe('revoked');
    expect(await records(inboxFor(h))).toEqual([]);
    expect(await records(inboxFor(h, 2))).toEqual([]);
  });

  it('holds everything while paused and delivers it once on resume', async () => {
    const h = await start();
    const eventId = say(h, BODY);
    h.pause.value = true;
    expect(await delivery(h).pull(held, inboxFor(h))).toBe('held');
    expect(await records(inboxFor(h))).toEqual([]);
    h.pause.value = false;
    expect(await delivery(h).pull(held, inboxFor(h))).toBe('caught_up');
    expect(await records(inboxFor(h))).toEqual([internalReleaseId(bobBinding, eventId)]);
  });

  it('wakes a listener for a human release in the default mode', async () => {
    const h = await start();
    const inbox = await inboxFor(h)();
    const listener = await inbox.acquireListener();
    cleanups.push(() => listener.release());
    await listener.nextWake(); // The start-up catch-up wake.
    say(h, BODY);
    const woke = listener.nextWake().then(() => true);
    expect(await delivery(h).pull(held, inboxFor(h))).toBe('caught_up');
    expect(await Promise.race([woke, new Promise(resolve => setTimeout(() => resolve(false), 1_000))])).toBe(true);
  });

  it('stores a human release without waking the listener in async mode', async () => {
    const h = await start();
    expect(createSqliteListeningModeRepository(h.fixture.handle).initialize({
      bindingId: bobBinding.bindingId, generation: bobBinding.generation, requested: 'async', version: 1,
      experimentalGrants: [], hardCancelGrants: [], lastChangedBy: { kind: 'unknown' },
    })).toBe(true);
    const inbox = await inboxFor(h)();
    const listener = await inbox.acquireListener();
    cleanups.push(() => listener.release());
    await listener.nextWake(); // The start-up catch-up wake.
    const eventId = say(h, BODY);
    const woke = listener.nextWake().then(() => true);
    expect(await delivery(h).pull(held, inboxFor(h))).toBe('caught_up');
    expect(await Promise.race([woke, new Promise(resolve => setTimeout(() => resolve(false), 300))])).toBe(false);
    const batch = await listener.readBatch({ maxBytes: 1024 * 1024 });
    expect(batch?.items.map(item => item.record.releaseId)).toEqual([internalReleaseId(bobBinding, eventId)]);
  });

  it('does not pull for khala status', async () => {
    const h = await start();
    say(h, BODY);
    expect((await khala(h, ['status'])).code).toBe(0);
    expect(fs.existsSync(path.join(h.stateDirectory, 'internal-delivery'))).toBe(false);
  });

  it('never writes a message body to server logs or CLI output streams other than read', async () => {
    const h = await start();
    say(h, BODY);
    const status = await khala(h, ['status']);
    const read = await khala(h, ['read']);
    expect(read.code).toBe(0);
    expect(status.out + status.err + read.err).not.toContain(BODY);
    expect(JSON.stringify(h.logs)).not.toContain(BODY);
    expect(h.logs.some(event => 'route' in event && event.route === '/api/v1/channels/:channelId/releases')).toBe(true);
  });

  it('placeholders an escape-heavy message over the record limit and keeps delivering', async () => {
    const h = await start();
    // 16 KiB of control characters escapes to ~96 KiB of JSON.
    const big = say(h, '\u0001'.repeat(16 * 1024));
    const after = say(h, 'still arriving');
    const outcome = await delivery(h).pull(held, inboxFor(h));
    expect(outcome).toBe('caught_up');
    const ids = await records(inboxFor(h));
    expect(ids).toEqual([internalReleaseId(bobBinding, big), internalReleaseId(bobBinding, after)]);
    const inbox = await inboxFor(h)();
    const listener = await inbox.acquireListener();
    try {
      const batch = await listener.readBatch({ maxBytes: 1024 * 1024 });
      const text = Buffer.from(batch!.items[0]!.payload).toString('utf8');
      expect(text).toContain('oversized');
      expect(text).not.toContain('\\u0001');
    } finally { await listener.release(); }
    expect(JSON.stringify(h.logs)).not.toContain('u0001');
  });
});
