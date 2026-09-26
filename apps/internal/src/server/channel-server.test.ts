import fs from 'node:fs';
import { type IncomingMessage, request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE } from './bootstrap';
import { type ChannelServerOptions, startChannelServer } from './channel-server';
import { CredentialConfigError, mintCredential } from './credentials';
import {
  aliceDevice, bob, bobBinding, bobDevice, channelId, createChannelFixture, otherChannelId, type ChannelFixture,
} from './fixtures/channel-fixture';
import type { LogEvent, LoopbackServer } from './server';
import type { DeviceId, OwnerId, ParticipantId } from '@khala/contracts/messaging/index';
import { createReceiptReadModel, type ProjectedReceipt } from '../store/receipts';

const NOW = Date.parse('2026-09-25T00:00:00.000Z');
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Harness = Readonly<{
  fixture: ChannelFixture;
  server: LoopbackServer;
  origin: string;
  events: LogEvent[];
  clock: { now: number };
}>;

async function start(overrides: Partial<ChannelServerOptions> = {}, fixture?: ChannelFixture): Promise<Harness> {
  const fx = fixture ?? createChannelFixture({ root: fs.mkdtempSync('/tmp/khala-server-'), now: NOW });
  if (!fixture) cleanups.push(() => fx.dispose());
  const events: LogEvent[] = [];
  const clock = { now: NOW };
  let id = 0;
  const server = await startChannelServer({
    store: fx.store,
    bootstrap: [fx.bootstrap],
    bindings: [fx.bob, fx.carol],
    newId: () => `id-${++id}`,
    clock: () => clock.now,
    log: event => events.push(event),
    startPort: 0,
    ...overrides,
  });
  cleanups.push(() => server.close());
  return { fixture: fx, server, origin: server.origin, events, clock };
}

// Response bodies are probed field by field across many shapes; assertions, not types, check them.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Reply = Readonly<{ status: number; headers: IncomingMessage['headers']; text: string; json: any }>;

function call(port: number, input: Readonly<{
  method?: string;
  path: string;
  headers?: Record<string, string | string[]>;
  body?: unknown;
}>): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const body = input.body === undefined ? undefined : typeof input.body === 'string' ? input.body : JSON.stringify(input.body);
    const request = httpRequest({
      host: '127.0.0.1',
      port,
      method: input.method ?? 'GET',
      path: input.path,
      headers: {
        host: `127.0.0.1:${port}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) }),
        ...input.headers,
      },
    });
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
    request.end(body);
  });
}

async function exchange(h: Harness, body: unknown = { credential: h.fixture.bootstrap.credential, channelId }) {
  return call(h.server.port, { method: 'POST', path: '/__khala/session', headers: { origin: h.origin }, body });
}

async function humanSession(h: Harness): Promise<Record<string, string>> {
  const reply = await exchange(h);
  expect(reply.status).toBe(200);
  const cookie = String(reply.headers['set-cookie']![0]).split(';')[0]!;
  return { cookie, 'x-khala-request-secret': reply.json.requestSecret, origin: h.origin };
}

const bearer = (credential: string) => ({ authorization: `Bearer ${credential}` });
const message = (body: string, clientTxnId = `txn-${body}`) => ({ clientTxnId, content: { v: 1, kind: 'text', body } });

describe('browser bootstrap exchange', () => {
  it('exchanges once for a host-only HttpOnly cookie, a separate request secret and the channel route', async () => {
    const h = await start();
    const reply = await exchange(h);
    expect(reply.status).toBe(200);
    expect(reply.json).toEqual({ requestSecret: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), route: '/channels/channel-one' });
    const cookies = reply.headers['set-cookie']!;
    expect(cookies).toHaveLength(1);
    const [pair, ...attributes] = cookies[0]!.split('; ');
    expect(pair).toMatch(new RegExp(`^${SESSION_COOKIE}=[A-Za-z0-9_-]{43}$`));
    expect(attributes.sort()).toEqual(['HttpOnly', 'Path=/', 'SameSite=Strict']);
    expect(pair!.split('=')[1]).not.toBe(reply.json.requestSecret);
    expect(reply.text).not.toContain(h.fixture.bootstrap.credential);
    expect(reply.text).not.toContain(pair!.split('=')[1]);

    const replay = await exchange(h);
    expect(replay.status).toBe(401);
    expect(replay.headers['set-cookie']).toBeUndefined();
  });

  it('fails closed on wrong, expired, mismatched and malformed exchanges without burning the credential', async () => {
    const h = await start();
    const credential = h.fixture.bootstrap.credential;
    expect((await exchange(h, { credential: mintCredential(), channelId })).status).toBe(401);
    expect((await exchange(h, { credential, channelId: otherChannelId })).status).toBe(401);
    expect((await exchange(h, { credential: `${credential}=`, channelId })).status).toBe(401);
    expect((await exchange(h, { credential, channelId, extra: true })).status).toBe(400);
    expect((await exchange(h, '{"credential":')).status).toBe(400);
    expect((await exchange(h, { credential, channelId, padding: 'x'.repeat(600) })).status).toBe(413);
    expect((await call(h.server.port, {
      method: 'POST', path: '/__khala/session', headers: { origin: h.origin, 'content-type': 'text/plain' }, body: 'x',
    })).status).toBe(415);
    // A hostile origin never reaches the credential.
    expect((await call(h.server.port, {
      method: 'POST', path: '/__khala/session', headers: { origin: 'http://127.0.0.1:1' }, body: { credential, channelId },
    })).status).toBe(403);
    expect((await exchange(h)).status).toBe(200);
  });

  it('refuses an expired bootstrap credential', async () => {
    const h = await start();
    h.clock.now = h.fixture.bootstrap.expiresAt;
    expect((await exchange(h)).status).toBe(401);
  });

  it('refuses channel scopes that cannot be addressed as a route segment', async () => {
    const fixture = createChannelFixture({ root: fs.mkdtempSync('/tmp/khala-server-'), now: NOW });
    cleanups.push(() => fixture.dispose());
    const base = { store: fixture.store, newId: () => 'x', clock: () => NOW, startPort: 0 } as const;
    await expect(startChannelServer({ ...base, bootstrap: [{ ...fixture.bootstrap, channelId: 'a:b' as never }], bindings: [] }))
      .rejects.toBeInstanceOf(CredentialConfigError);
    await expect(startChannelServer({ ...base, bootstrap: [], bindings: [{ ...fixture.bob, channels: ['..' as never] }] }))
      .rejects.toBeInstanceOf(CredentialConfigError);
  });

  it('refuses malformed or duplicate credential registrations before listening', async () => {
    const fixture = createChannelFixture({ root: fs.mkdtempSync('/tmp/khala-server-'), now: NOW });
    cleanups.push(() => fixture.dispose());
    const base = { store: fixture.store, newId: () => 'x', clock: () => NOW, startPort: 0 } as const;
    for (const bad of ['', 'a'.repeat(42), `${'A'.repeat(42)}B`, 'a'.repeat(43) + '=', '!'.repeat(43)]) {
      await expect(startChannelServer({ ...base, bootstrap: [{ ...fixture.bootstrap, credential: bad }], bindings: [] }))
        .rejects.toBeInstanceOf(CredentialConfigError);
    }
    await expect(startChannelServer({ ...base, bootstrap: [fixture.bootstrap, fixture.bootstrap], bindings: [] }))
      .rejects.toBeInstanceOf(CredentialConfigError);
    await expect(startChannelServer({
      ...base, bootstrap: [], bindings: [fixture.bob, { ...fixture.bob, credential: mintCredential() }],
    })).rejects.toBeInstanceOf(CredentialConfigError);
    await expect(startChannelServer({
      ...base, bootstrap: [fixture.bootstrap], bindings: [{ ...fixture.bob, credential: fixture.bootstrap.credential }],
    })).rejects.toBeInstanceOf(CredentialConfigError);
  });
});

describe('AE1: admission precedes the durable store', () => {
  it.each([
    ['localhost Host', (port: number) => ({ host: `localhost:${port}`, origin: `http://127.0.0.1:${port}` }), 400],
    ['hostile Origin', (port: number) => ({ host: `127.0.0.1:${port}`, origin: 'https://hostile.example' }), 403],
  ] as const)('rejects a valid-binding send with %s before any store call', async (_name, headers, status) => {
    const fixture = createChannelFixture({ root: fs.mkdtempSync('/tmp/khala-server-'), now: NOW });
    cleanups.push(() => fixture.dispose());
    const calls: string[] = [];
    const store = new Proxy(fixture.store, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver) as unknown;
        return typeof value === 'function'
          ? (...args: unknown[]) => {
            calls.push(String(property));
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          }
          : value;
      },
    });
    const h = await start({ store }, fixture);
    const reply = await new Promise<number>((resolve, reject) => {
      const request = httpRequest({
        host: '127.0.0.1',
        port: h.server.port,
        method: 'POST',
        path: `/api/v1/channels/${channelId}/messages`,
        headers: {
          ...headers(h.server.port),
          ...bearer(fixture.bob.credential),
          'content-type': 'application/json',
          'content-length': '4096',
        },
      });
      request.once('error', reject);
      const timer = setTimeout(() => {
        request.destroy();
        resolve(0);
      }, 1_000);
      request.once('response', response => {
        clearTimeout(timer);
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      request.flushHeaders();
      request.write('{"clientTxnId":"t","content":');
    });
    expect(calls).toEqual([]);
    expect(reply).toBe(status);
  });
});

describe('credential authentication', () => {
  it('requires both the session cookie and its request secret', async () => {
    const h = await start();
    const session = await humanSession(h);
    const path = `/api/v1/channels/${channelId}`;
    expect((await call(h.server.port, { path, headers: session })).status).toBe(200);
    expect((await call(h.server.port, { path, headers: { cookie: session.cookie! } })).status).toBe(401);
    expect((await call(h.server.port, { path, headers: { 'x-khala-request-secret': session['x-khala-request-secret']! } })).status).toBe(401);
    expect((await call(h.server.port, { path, headers: { ...session, 'x-khala-request-secret': mintCredential() } })).status).toBe(401);
    expect((await call(h.server.port, { path, headers: { ...session, cookie: `${session.cookie}; ${session.cookie}` } })).status).toBe(401);
    expect((await call(h.server.port, { path, headers: { ...session, ...bearer(h.fixture.bob.credential) } })).status).toBe(401);
  });

  it.each([
    (credential: string) => `bearer ${credential}`,
    (credential: string) => `Bearer  ${credential}`,
    (credential: string) => `Basic ${credential}`,
    (credential: string) => `Bearer ${credential.slice(0, 20)}`,
    () => `Bearer ${mintCredential()}`,
  ])('rejects noncanonical or unknown bearer form %#', async form => {
    const h = await start();
    const reply = await call(h.server.port, { path: `/api/v1/channels/${channelId}`, headers: { authorization: form(h.fixture.bob.credential) } });
    expect(reply.status).toBe(401);
    expect(reply.json).toEqual({ error: { code: 'unauthenticated' } });
  });

  it('never accepts credentials from query parameters', async () => {
    const h = await start();
    const reply = await call(h.server.port, { path: `/api/v1/channels/${channelId}/timeline?token=${h.fixture.bob.credential}` });
    expect(reply.status).toBe(401);
    expect((await call(h.server.port, {
      path: `/api/v1/channels/${channelId}/timeline?token=${h.fixture.bob.credential}`, headers: bearer(h.fixture.bob.credential),
    })).status).toBe(400);
  });

  it('rechecks the exact persisted binding on every request so revocation needs no restart', async () => {
    const h = await start();
    const session = await humanSession(h);
    const path = `/api/v1/channels/${channelId}`;
    expect((await call(h.server.port, { path, headers: bearer(h.fixture.bob.credential) })).status).toBe(200);
    expect(h.fixture.store.revokeBinding({ bindingId: bobBinding.bindingId, generation: bobBinding.generation }))
      .toMatchObject({ kind: 'done' });
    expect((await call(h.server.port, { path, headers: bearer(h.fixture.bob.credential) })).status).toBe(401);
    expect((await call(h.server.port, { path, headers: session })).status).toBe(200);
  });

  it('reports only the live binding a capability holds, and nothing to a human session', async () => {
    const h = await start();
    const session = await humanSession(h);
    const path = '/api/v1/agent/binding';
    const held = await call(h.server.port, { path, headers: bearer(h.fixture.bob.credential) });
    expect(held.status).toBe(200);
    expect(held.json).toEqual({ binding: bobBinding });
    expect(held.text).not.toContain(h.fixture.bob.credential);
    expect((await call(h.server.port, { path, headers: session })).status).toBe(403);
    expect((await call(h.server.port, { path })).status).toBe(401);
    h.fixture.store.revokeBinding({ bindingId: bobBinding.bindingId, generation: bobBinding.generation });
    expect((await call(h.server.port, { path, headers: bearer(h.fixture.bob.credential) })).status).toBe(401);
  });

  it('reports the bootstrapped human authority only to that human session', async () => {
    const h = await start();
    const session = await humanSession(h);
    const path = '/api/v1/session';
    const held = await call(h.server.port, { path, headers: session });
    expect(held.status).toBe(200);
    expect(held.json).toEqual({
      human: { ownerId: h.fixture.bootstrap.human.ownerId, participantId: h.fixture.bootstrap.human.participantId, deviceId: aliceDevice },
    });
    expect(held.text).not.toContain(session['x-khala-request-secret']);
    expect((await call(h.server.port, { path, headers: bearer(h.fixture.bob.credential) })).status).toBe(403);
    expect((await call(h.server.port, { path, headers: { cookie: session.cookie! } })).status).toBe(401);
    expect((await call(h.server.port, { path })).status).toBe(401);
  });

  it('refuses a binding whose persisted generation was replaced', async () => {
    const fixture = createChannelFixture({ root: fs.mkdtempSync('/tmp/khala-server-'), now: NOW });
    cleanups.push(() => fixture.dispose());
    const stale = { ...fixture.bob, binding: { ...bobBinding, generation: 9 } };
    const h = await start({ bindings: [stale] }, fixture);
    expect((await call(h.server.port, { path: `/api/v1/channels/${channelId}`, headers: bearer(stale.credential) })).status).toBe(401);
  });

  it('refuses an older generation once a newer one is registered, without explicit revocation', async () => {
    const h = await start();
    const path = `/api/v1/channels/${channelId}`;
    expect((await call(h.server.port, { path, headers: bearer(h.fixture.bob.credential) })).status).toBe(200);
    expect(h.fixture.store.registerBinding({ ...bobBinding, generation: 2, sessionId: 'session-bob-2' }))
      .toMatchObject({ kind: 'done', changed: true });
    expect((await call(h.server.port, { path, headers: bearer(h.fixture.bob.credential) })).status).toBe(401);
  });

  it('rechecks the binding after a slow body arrives and before the durable write', async () => {
    const h = await start();
    const status = await new Promise<number>((resolve, reject) => {
      const body = JSON.stringify(message('after-revoke'));
      const request = httpRequest({
        host: '127.0.0.1',
        port: h.server.port,
        method: 'POST',
        path: `/api/v1/channels/${channelId}/messages`,
        headers: {
          host: `127.0.0.1:${h.server.port}`,
          ...bearer(h.fixture.bob.credential),
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body)),
        },
      });
      request.once('error', reject);
      request.once('response', response => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      request.write(body.slice(0, 5));
      setTimeout(() => {
        h.fixture.store.revokeBinding({ bindingId: bobBinding.bindingId, generation: bobBinding.generation });
        request.end(body.slice(5));
      }, 50);
    });
    expect(status).toBe(401);
    const timeline = h.fixture.store.timeline({ channelId, participantId: bob.participantId, cursor: null, limit: 10 });
    expect(timeline).toMatchObject({ kind: 'done', events: [] });
  });
});

describe('versioned channel API', () => {
  it('lets only the human create channels with server-derived attribution and exact replay', async () => {
    const h = await start();
    const session = await humanSession(h);
    const created = await call(h.server.port, { method: 'POST', path: '/api/v1/channels', headers: session, body: { operationId: 'op-1', title: 'Fresh' } });
    expect(created.status).toBe(201);
    expect(created.json.channel).toMatchObject({ channelId: 'id-1', title: 'Fresh', membership: 'joined' });
    const replayed = await call(h.server.port, { method: 'POST', path: '/api/v1/channels', headers: session, body: { operationId: 'op-1', title: 'Fresh' } });
    expect(replayed.status).toBe(200);
    expect(replayed.json.channel.channelId).toBe('id-1');
    expect((await call(h.server.port, {
      method: 'POST', path: '/api/v1/channels', headers: session, body: { operationId: 'op-1', title: 'Changed' },
    })).status).toBe(409);
    expect((await call(h.server.port, {
      method: 'POST', path: '/api/v1/channels', headers: session, body: { operationId: 'op-2', title: 'x', creatorParticipantId: bob.participantId },
    })).status).toBe(400);
    expect((await call(h.server.port, {
      method: 'POST', path: '/api/v1/channels', headers: bearer(h.fixture.bob.credential), body: { operationId: 'op-3', title: 'x' },
    })).status).toBe(403);
  });

  it('derives the sender from the binding and rejects attribution fields in JSON', async () => {
    const h = await start();
    const path = `/api/v1/channels/${channelId}/messages`;
    const headers = bearer(h.fixture.bob.credential);
    const sent = await call(h.server.port, { method: 'POST', path, headers, body: message('hello') });
    expect(sent.status).toBe(201);
    expect(sent.json).toMatchObject({
      state: 'stored',
      event: { authorDeviceId: bobDevice, participant: { participantId: bob.participantId, displayName: 'Bob' }, content: { body: 'hello' } },
    });
    expect(sent.text).not.toMatch(/canonicalPayload|contentDigest/);
    const replay = await call(h.server.port, { method: 'POST', path, headers, body: message('hello') });
    expect(replay.status).toBe(200);
    expect(replay.json.event.eventId).toBe(sent.json.event.eventId);
    for (const extra of [{ participantId: 'participant-alice' }, { deviceId: aliceDevice }, { authorParticipantId: 'x' }]) {
      const reply = await call(h.server.port, { method: 'POST', path, headers, body: { ...message('spoof'), ...extra } });
      expect(reply.status).toBe(400);
    }
    expect((await call(h.server.port, { method: 'POST', path, headers, body: message('changed', 'txn-hello') })).status).toBe(409);
    expect((await call(h.server.port, { method: 'POST', path, headers, body: message('x'.repeat(16 * 1024 + 1)) })).status).toBe(400);
    expect((await call(h.server.port, { method: 'POST', path, headers, body: { ...message('x'), clientTxnId: 't'.repeat(129) } })).status).toBe(400);
    expect((await call(h.server.port, {
      method: 'POST', path: `/api/v1/channels/${otherChannelId}/messages`, headers, body: message('scope'),
    })).status).toBe(403);
  });

  it('serves summary, roster and bounded timeline pages to members only', async () => {
    const h = await start();
    const session = await humanSession(h);
    for (const body of ['one', 'two', 'three']) {
      expect((await call(h.server.port, { method: 'POST', path: `/api/v1/channels/${channelId}/messages`, headers: session, body: message(body) })).status).toBe(201);
    }
    const summary = await call(h.server.port, { path: `/api/v1/channels/${channelId}`, headers: bearer(h.fixture.bob.credential) });
    expect(summary.status).toBe(200);
    expect(summary.json.channel).toMatchObject({ channelId, title: 'One' });
    expect(summary.json.participants.map((p: { displayName: string }) => p.displayName).sort()).toEqual(['Alice', 'Bob']);

    const first = await call(h.server.port, { path: `/api/v1/channels/${channelId}/timeline?limit=2`, headers: session });
    expect(first.status).toBe(200);
    expect(first.json.events).toHaveLength(2);
    expect(first.json.nextCursor).toEqual(expect.any(String));
    const second = await call(h.server.port, {
      path: `/api/v1/channels/${channelId}/timeline?limit=2&cursor=${encodeURIComponent(first.json.nextCursor)}`, headers: session,
    });
    expect(second.status).toBe(200);
    expect(second.json.events).toHaveLength(1);

    for (const query of ['limit=0', 'limit=101', 'limit=1&limit=2', 'cursor=a&cursor=b', 'since=1', `cursor=${'c'.repeat(513)}`]) {
      expect((await call(h.server.port, { path: `/api/v1/channels/${channelId}/timeline?${query}`, headers: session })).status, query).toBe(400);
    }
    expect((await call(h.server.port, { path: `/api/v1/channels/${channelId}/timeline?cursor=bogus`, headers: session })).status).toBe(400);
    expect((await call(h.server.port, { path: '/api/v1/channels/missing', headers: session })).status).toBe(404);
    expect((await call(h.server.port, { path: `/api/v1/channels/${otherChannelId}`, headers: bearer(h.fixture.carol.credential) })).status).toBe(200);
    expect((await call(h.server.port, { path: `/api/v1/channels/${channelId}`, headers: bearer(h.fixture.carol.credential) })).status).toBe(403);
  });

  it('never reports an indeterminate write as stored and keeps exception text out of responses and logs', async () => {
    const fixture = createChannelFixture({ root: fs.mkdtempSync('/tmp/khala-server-'), now: NOW });
    cleanups.push(() => fixture.dispose());
    const store = {
      ...fixture.store,
      send() { throw new Error(`disk-canary ${fixture.bob.credential}`); },
      timeline() { return { kind: 'unavailable' } as const; },
    };
    const h = await start({ store }, fixture);
    const headers = bearer(fixture.bob.credential);
    const sent = await call(h.server.port, { method: 'POST', path: `/api/v1/channels/${channelId}/messages`, headers, body: message('secret-body-canary') });
    expect(sent.status).toBe(503);
    expect(sent.json).toEqual({ error: { code: 'outcome_unknown' } });
    const read = await call(h.server.port, { path: `/api/v1/channels/${channelId}/timeline`, headers });
    expect(read.json).toEqual({ error: { code: 'unavailable' } });
    await new Promise(resolve => setTimeout(resolve, 20));
    const logged = JSON.stringify(h.events);
    expect(logged).not.toMatch(/canary|channel-one|participant|device/);
    expect(logged).not.toContain(fixture.bob.credential);
    expect(h.events).toContainEqual(expect.objectContaining({
      type: 'request', method: 'POST', route: '/api/v1/channels/:channelId/messages', status: 503,
    }));
  });
});

type Stream = Readonly<{ text(): string; closed: Promise<void>; status: number; close(): void }>;

function openStream(port: number, path: string, headers: Record<string, string>): Promise<Stream> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, path, headers: { host: `127.0.0.1:${port}`, ...headers } });
    request.once('error', reject);
    request.once('response', response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      const closed = new Promise<void>(done => {
        response.once('close', done);
        response.once('error', () => done());
      });
      resolve({ text: () => text, closed, status: response.statusCode ?? 0, close: () => request.destroy() });
    });
    request.end();
  });
}

async function eventually(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not reached');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

describe('owner-gated receipt evidence', () => {
  const receiptsPath = (id: string = channelId) => `/api/v1/channels/${id}/receipts`;

  function acknowledgement(receiptId: string, releaseId: string, eventIds: readonly string[]): ProjectedReceipt {
    return {
      receipt: {
        v: 2, receiptId, releaseId, bindingId: bobBinding.bindingId, generation: 1, kind: 'agent_acknowledged',
        observedAt: '2026-09-25T00:00:01.000Z', source: 'agent', evidenceRef: 'ack_batch_1', errorCode: null,
      } as ProjectedReceipt['receipt'],
      evidenceRef: 'ack_batch_1',
      ledgerRevision: Number(receiptId.slice(-1)),
      events: eventIds.map(eventId => ({ channelId, eventId: eventId as ProjectedReceipt['events'][number]['eventId'] })),
    };
  }

  it('serves content-free facts, their channel events and shared batch groups to the owner session', async () => {
    const fx = createChannelFixture({ root: fs.mkdtempSync('/tmp/khala-server-'), now: NOW });
    cleanups.push(() => fx.dispose());
    const readModel = createReceiptReadModel(fx.handle);
    const h = await start({ receipts: readModel }, fx);
    const session = await humanSession(h);
    const sent = await call(h.server.port, { method: 'POST', path: `/api/v1/channels/${channelId}/messages`, headers: session, body: message('CANARY-BODY') });
    const eventId = sent.json.event.eventId as string;
    expect(await readModel.projectReceipt(acknowledgement('receipt_2', 'release_b', [eventId]))).toEqual({ kind: 'stored' });
    expect(await readModel.projectReceipt(acknowledgement('receipt_1', 'release_a', [eventId]))).toEqual({ kind: 'stored' });

    const reply = await call(h.server.port, { path: receiptsPath(), headers: session });
    expect(reply.status).toBe(200);
    expect(reply.headers['cache-control']).toBe('no-store');
    expect(reply.json.v).toBe(1);
    expect(reply.json.facts.map((fact: { receipt: { receiptId: string } }) => fact.receipt.receiptId)).toEqual(['receipt_1', 'receipt_2']);
    expect(reply.json.facts[0].events).toEqual([{ eventId, sequence: expect.any(Number) }]);
    expect(reply.json.groups).toEqual([{ evidenceRef: 'ack_batch_1', receiptIds: ['receipt_1', 'receipt_2'] }]);
    expect(reply.text).not.toContain('CANARY-BODY');
  });

  it('refuses unauthenticated, invalid-launch-token, wrong-Origin, agent and wrong-owner reads before any evidence', async () => {
    const fx = createChannelFixture({ root: fs.mkdtempSync('/tmp/khala-server-'), now: NOW });
    cleanups.push(() => fx.dispose());
    const readModel = createReceiptReadModel(fx.handle);
    const dave = { participantId: 'participant-dave' as ParticipantId, ownerId: 'owner-dave' as OwnerId, deviceId: 'device-dave' as DeviceId };
    fx.store.registerParticipant({ participantId: dave.participantId, ownerId: dave.ownerId, kind: 'human', displayName: 'Dave' });
    fx.store.registerDevice({ deviceId: dave.deviceId, participantId: dave.participantId });
    const daveBootstrap = { credential: mintCredential(), channelId, expiresAt: NOW + 60_000, human: dave };
    const h = await start({ receipts: readModel, bootstrap: [fx.bootstrap, daveBootstrap] }, fx);
    const session = await humanSession(h);
    const sent = await call(h.server.port, { method: 'POST', path: `/api/v1/channels/${channelId}/messages`, headers: session, body: message('one') });
    await readModel.projectReceipt(acknowledgement('receipt_1', 'release_a', [sent.json.event.eventId]));

    // Unauthenticated, and a forged cookie/secret pair from no launch token at all.
    expect((await call(h.server.port, { path: receiptsPath() })).status).toBe(401);
    expect((await call(h.server.port, { path: receiptsPath(), headers: { ...session, 'x-khala-request-secret': mintCredential() } })).status).toBe(401);
    // An invalid launch token never yields a session that could read evidence.
    const invalid = await exchange(h, { credential: mintCredential(), channelId });
    expect(invalid.status).toBe(401);
    expect(invalid.headers['set-cookie']).toBeUndefined();
    // A hostile or cross-site Origin is refused before the read model runs.
    expect((await call(h.server.port, { path: receiptsPath(), headers: { ...session, origin: 'https://hostile.example' } })).status).toBe(403);
    expect((await call(h.server.port, { path: receiptsPath(), headers: { ...session, 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
    // A bound agent in the channel is not the owner.
    const agent = await call(h.server.port, { path: receiptsPath(), headers: bearer(h.fixture.bob.credential) });
    expect(agent.status).toBe(403);
    expect(agent.text).not.toContain('receipt_1');
    // Another owner's human session, even bootstrapped for this channel, is not a member.
    const daveExchange = await exchange(h, { credential: daveBootstrap.credential, channelId });
    const daveSession = {
      cookie: String(daveExchange.headers['set-cookie']![0]).split(';')[0]!,
      'x-khala-request-secret': daveExchange.json.requestSecret, origin: h.origin,
    };
    const wrongOwner = await call(h.server.port, { path: receiptsPath(), headers: daveSession });
    expect(wrongOwner.status).toBe(403);
    expect(wrongOwner.text).not.toContain('receipt_1');
    // The owner still reads; a missing channel is not found.
    expect((await call(h.server.port, { path: receiptsPath(), headers: session })).status).toBe(200);
    expect((await call(h.server.port, { path: receiptsPath('missing'), headers: session })).status).toBe(404);
  });

  it('reports a failed read as unavailable, never as an empty evidence set', async () => {
    const h = await start({ receipts: { channelReceipts: () => ({ kind: 'unavailable' }) } });
    const reply = await call(h.server.port, { path: receiptsPath(), headers: await humanSession(h) });
    expect(reply.status).toBe(503);
    expect(reply.json.facts).toBeUndefined();
  });

  it('has no receipt route without a read model', async () => {
    const h = await start();
    expect((await call(h.server.port, { path: receiptsPath(), headers: await humanSession(h) })).status).toBe(404);
  });
});

describe('credential-scoped SSE hints', () => {
  it('delivers content-free hints only to principals authorized for the changed channel', async () => {
    const h = await start({ limits: { keepaliveMs: 50 } });
    const session = await humanSession(h);
    const bobStream = await openStream(h.server.port, `/api/v1/channels/${channelId}/hints`, bearer(h.fixture.bob.credential));
    const carolStream = await openStream(h.server.port, `/api/v1/channels/${otherChannelId}/hints`, bearer(h.fixture.carol.credential));
    expect(bobStream.status).toBe(200);
    expect(carolStream.status).toBe(200);
    await eventually(() => bobStream.text().includes('event: ready') && carolStream.text().includes('event: ready'));

    const canary = 'sse-body-canary';
    expect((await call(h.server.port, {
      method: 'POST', path: `/api/v1/channels/${channelId}/messages`, headers: session, body: message(canary, 'txn-canary'),
    })).status).toBe(201);
    await eventually(() => bobStream.text().includes('event: hint'));
    await eventually(() => carolStream.text().includes(': keepalive'));
    expect(carolStream.text()).not.toContain('event: hint');
    for (const text of [bobStream.text(), carolStream.text()]) {
      expect(text).not.toMatch(/canary|participant|device|txn|One|Two|channel-/);
      expect(text).not.toContain(h.fixture.bob.credential);
      expect(text.replace(/: keepalive\n\n/g, '').replace(/event: (ready|hint)\ndata: \{\}\n\n/g, '')).toBe('retry: 2000\n\n');
    }
    bobStream.close();
    carolStream.close();
  });

  it('rejects unauthorized streams and caps global and per-credential streams', async () => {
    const h = await start({ limits: { maxStreams: 2, maxStreamsPerCredential: 1 } });
    const path = `/api/v1/channels/${channelId}/hints`;
    expect((await openStream(h.server.port, path, bearer(h.fixture.carol.credential))).status).toBe(403);
    expect((await openStream(h.server.port, path, {})).status).toBe(401);
    const first = await openStream(h.server.port, path, bearer(h.fixture.bob.credential));
    expect(first.status).toBe(200);
    expect((await openStream(h.server.port, path, bearer(h.fixture.bob.credential))).status).toBe(429);
    const session = await humanSession(h);
    const human = await openStream(h.server.port, path, session);
    expect(human.status).toBe(200);
    expect((await openStream(h.server.port, `/api/v1/channels/${otherChannelId}/hints`, bearer(h.fixture.carol.credential))).status).toBe(429);

    // Disconnect releases the slot deterministically, so a reconnect succeeds.
    first.close();
    await first.closed;
    await eventually(() => true);
    let reconnected: Stream | null = null;
    const deadline = Date.now() + 2_000;
    while (!reconnected || reconnected.status !== 200) {
      if (Date.now() > deadline) throw new Error('reconnect refused');
      reconnected = await openStream(h.server.port, path, bearer(h.fixture.bob.credential));
    }
    await eventually(() => reconnected!.text().includes('event: ready'));
    reconnected.close();
    human.close();
  });

  it('closes a stream once its participant leaves the channel', async () => {
    const h = await start({ limits: { keepaliveMs: 30 } });
    const agent = await openStream(h.server.port, `/api/v1/channels/${channelId}/hints`, bearer(h.fixture.bob.credential));
    expect(agent.status).toBe(200);
    h.fixture.store.setMembership({ channelId, participantId: bob.participantId, membership: 'left' });
    await agent.closed;
  });

  it('closes a binding stream when the binding is revoked and all streams on shutdown', async () => {
    const h = await start({ limits: { keepaliveMs: 30 } });
    const session = await humanSession(h);
    const path = `/api/v1/channels/${channelId}/hints`;
    const agent = await openStream(h.server.port, path, bearer(h.fixture.bob.credential));
    const human = await openStream(h.server.port, path, session);
    h.fixture.store.revokeBinding({ bindingId: bobBinding.bindingId, generation: bobBinding.generation });
    await agent.closed;
    expect(agent.text()).not.toContain('event: hint');
    await h.server.close();
    await human.closed;
  });
});

describe('static routes', () => {
  it('serves the fixed bootstrap document and script with the strict CSP', async () => {
    const h = await start();
    const document = await call(h.server.port, { path: '/__khala/bootstrap' });
    expect(document.status).toBe(200);
    expect(document.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(document.text).toContain('<script src="/__khala/bootstrap.js"></script>');
    expect(document.text).not.toMatch(/<script>|\son\w+=/);
    const csp = String(document.headers['content-security-policy']);
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("worker-src 'none'");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|blob:|data:|\*/);
    const script = await call(h.server.port, { path: '/__khala/bootstrap.js' });
    expect(script.status).toBe(200);
    expect(script.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(script.text).toContain('location.replace');
    expect((await call(h.server.port, { path: '/channels/channel-one' })).status).toBe(404);
  });

  it('returns 404 for every static escape form', async () => {
    const h = await start();
    for (const path of ['/etc/passwd', '/%2e%2e/%2e%2e/etc/passwd', '/..%2f..%2fetc%2fpasswd', '/%252e%252e/x', '/__khala/../package.json']) {
      const reply = await call(h.server.port, { path });
      expect([400, 404], path).toContain(reply.status);
      expect(reply.text).not.toMatch(/root:|\/tmp|\/home/);
    }
  });
});
