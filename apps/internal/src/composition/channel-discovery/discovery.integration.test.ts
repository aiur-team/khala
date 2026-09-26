import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import fs from 'node:fs';
import { type IncomingMessage, request as httpRequest } from 'node:http';
import path from 'node:path';
import {
  parseInternalConnectorKey, parseInternalDiscoveryDescriptor,
} from '@khala/contracts/internal/discovery-descriptor';
import {
  type DeviceId, type GrantExchangeRequest, type RoomId, deriveOkpKeyThumbprint,
} from '@khala/contracts/messaging/index';
import { afterEach, describe, expect, it } from 'vitest';
import { writeActiveDescriptor } from '../../descriptor/write';
import { startChannelServer } from '../../server/channel-server';
import { mintCredential } from '../../server/credentials';
import { aliceDevice, alice, channelId, createChannelFixture, otherChannelId, type ChannelFixture } from '../../server/fixtures/channel-fixture';
import type { LoopbackServer } from '../../server/server';
import { createChannelStore } from '../../store/channel-store';
import { createSqliteControlStore } from '../../store/control-store';
import { ROOM_DATABASE_FILE } from '../../store/path';
import { createDiscoveryStore } from '../../store/discovery-store';
import { type InternalStoreHandle, openChannelStore } from '../../store/open';
import { issueDiscoveryDescriptor } from '../discovery-descriptor';
import { type InternalChannelDiscovery, composeInternalChannelDiscovery } from './service';

// End-to-end over the real SQLite store, the shared journal and exchange, and the
// loopback server. Agents obtain descriptors exactly as `khala internal discovery`
// does, and every request goes over HTTP with the role it would really hold.

const NOW = Date.parse('2026-09-25T12:00:00.000Z');
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Reply = Readonly<{ status: number; headers: IncomingMessage['headers']; text: string; json: any }>;

function call(port: number, input: Readonly<{ method?: string; path: string; headers?: Record<string, string>; body?: unknown }>): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const body = input.body === undefined ? undefined : JSON.stringify(input.body);
    const request = httpRequest({
      host: '127.0.0.1', port, method: input.method ?? 'GET', path: input.path, agent: false,
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
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: response.statusCode ?? 0, headers: response.headers, text, json });
      });
    });
    request.end(body);
  });
}

type Agent = Readonly<{
  principal: string;
  generation: number;
  capability: string;
  connector: Readonly<{ publicKey: string; privateKey: string }>;
  descriptorPath: string;
}>;

type World = {
  fixture: ChannelFixture;
  handle: InternalStoreHandle;
  discovery: InternalChannelDiscovery;
  server: LoopbackServer;
  transportCapability: string;
  clock: { now: number };
  human: Record<string, string>;
};

async function boot(fixture: ChannelFixture, handle: InternalStoreHandle, clock: { now: number }, startPort = 0): Promise<World> {
  const discovery = await composeInternalChannelDiscovery({
    control: createSqliteControlStore(handle, () => clock.now),
    store: createDiscoveryStore(handle),
    human: { ownerId: alice.ownerId, participantId: alice.participantId, deviceId: aliceDevice },
    clock: () => clock.now,
    newChannelId: () => `ch_${randomBytes(8).toString('hex')}`,
  });
  const transportCapability = mintCredential();
  const bootstrap = { ...fixture.bootstrap, credential: mintCredential(), expiresAt: clock.now + 60_000 };
  let id = 0;
  const server = await startChannelServer({
    store: createChannelStore(handle),
    bootstrap: [bootstrap],
    bindings: [fixture.bob],
    transportCapability,
    discovery: discovery.port,
    newId: () => `id-${++id}`,
    clock: () => clock.now,
    startPort,
  });
  cleanups.push(() => server.close());
  writeActiveDescriptor(fixture.root, { v: 1, channelId, origin: server.origin, transportCapability });
  const session = await call(server.port, {
    method: 'POST', path: '/__khala/session', headers: { origin: server.origin }, body: { credential: bootstrap.credential, channelId },
  });
  expect(session.status).toBe(200);
  const human = {
    cookie: String(session.headers['set-cookie']![0]).split(';')[0]!,
    'x-khala-request-secret': session.json.requestSecret as string,
    origin: server.origin,
  };
  return { fixture, handle, discovery, server, transportCapability, clock, human };
}

async function world(): Promise<World> {
  const fixture = createChannelFixture({ root: fs.mkdtempSync('/tmp/khala-discovery-'), now: NOW });
  cleanups.push(() => fixture.dispose());
  return boot(fixture, fixture.handle, { now: NOW });
}

async function issue(w: World, sessionId: string, label: string | null = null): Promise<Agent> {
  const issued = await issueDiscoveryDescriptor({
    root: w.fixture.root,
    command: { kind: 'discovery', harness: 'codex', sessionId, displayLabel: label, workspaceLabel: null },
  });
  if (issued.kind !== 'issued') throw new Error(`issue failed: ${issued.code}`);
  const descriptor = parseInternalDiscoveryDescriptor(fs.readFileSync(issued.descriptorPath, 'utf8'));
  const key = parseInternalConnectorKey(fs.readFileSync(issued.connectorKeyPath, 'utf8'));
  if (!descriptor.ok || !key.ok) throw new Error('descriptor files');
  return {
    principal: descriptor.value.principal,
    generation: descriptor.value.generation,
    capability: descriptor.value.discoveryCapability,
    connector: { publicKey: key.value.publicKey, privateKey: key.value.privateKey },
    descriptorPath: issued.descriptorPath,
  };
}

const bearer = (agent: Agent | string) => ({ authorization: `Bearer ${typeof agent === 'string' ? agent : agent.capability}` });

function proof(w: World, agent: Agent, url: string, overrides: Readonly<{ key?: Agent['connector']; iat?: number }> = {}): string {
  const key = overrides.key ?? agent.connector;
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'EdDSA', typ: 'dpop+jwt', jwk: { kty: 'OKP', crv: 'Ed25519', x: key.publicKey } });
  const payload = encode({
    htm: 'POST', htu: url, iat: overrides.iat ?? Math.floor(w.clock.now / 1000), jti: randomBytes(16).toString('base64url'),
    ath: createHash('sha256').update(agent.capability).digest('base64url'),
  });
  const privateKey = createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', x: key.publicKey, d: key.privateKey }, format: 'jwk' });
  return `${header}.${payload}.${sign(null, Buffer.from(`${header}.${payload}`), privateKey).toString('base64url')}`;
}

async function exchangeRequest(w: World, agent: Agent, operationId: string, deviceId = 'device_connector_1'): Promise<GrantExchangeRequest> {
  const proofThumbprint = await deriveOkpKeyThumbprint({ algorithm: 'Ed25519', publicKey: agent.connector.publicKey, thumbprint: '' });
  const box = generateKeyPairSync('x25519').publicKey.export({ format: 'jwk' }).x!;
  const boxThumbprint = await deriveOkpKeyThumbprint({ algorithm: 'X25519', publicKey: box, thumbprint: '' });
  if (!proofThumbprint.ok || !boxThumbprint.ok) throw new Error('crypto');
  return {
    v: 1, operationId, requester: agent.principal as GrantExchangeRequest['requester'], origin: w.server.origin,
    proofKey: { algorithm: 'Ed25519', publicKey: agent.connector.publicKey, thumbprint: proofThumbprint.thumbprint },
    encryptionKey: { algorithm: 'X25519', publicKey: box, thumbprint: boxThumbprint.thumbprint },
    deviceId: deviceId as DeviceId, sessionGeneration: agent.generation, expiresAt: new Date(w.clock.now + 60_000).toISOString(),
  };
}

function exchangeCall(w: World, agent: Agent, operationId: string, body: unknown, proofValue?: string) {
  const route = `/api/connector/channel-access-requests/${operationId}/exchange`;
  return call(w.server.port, {
    method: 'POST', path: route, body,
    headers: { ...bearer(agent), ...(proofValue === undefined ? {} : { dpop: proofValue }) },
  });
}

const list = (w: World, agent: Agent, cursor?: string) =>
  call(w.server.port, { path: `/api/agent/channels${cursor ? `?cursor=${cursor}` : ''}`, headers: bearer(agent) });

const requestAccess = (w: World, agent: Agent, operationId: string, target: Readonly<{ listingRef: string } | { channelUrl: string }>) =>
  call(w.server.port, {
    method: 'POST', path: '/api/agent/channel-access-requests', headers: bearer(agent),
    body: 'listingRef' in target
      ? { v: 1, kind: 'listing_ref', operationId, credentialRef: agent.principal, listingRef: target.listingRef }
      : { v: 1, kind: 'channel_url', operationId, credentialRef: agent.principal, channelUrl: target.channelUrl },
  });

const requestCreate = (w: World, agent: Agent, operationId: string, title = 'Proposed channel') =>
  call(w.server.port, {
    method: 'POST', path: '/api/agent/channel-create-requests', headers: bearer(agent),
    body: { v: 1, operationId, credentialRef: agent.principal, origin: w.server.origin, proposedTitle: title },
  });

const accessStatus = (w: World, agent: Agent, operationId: string) =>
  call(w.server.port, { path: `/api/agent/channel-access-requests/${operationId}`, headers: bearer(agent) });

async function settings(w: World, channel: string) {
  const reply = await call(w.server.port, { path: `/api/human/channels/${channel}/discovery`, headers: w.human });
  expect(reply.status).toBe(200);
  return reply.json as { revision: number; visibility: string; allowlist: string[] };
}

async function setSettings(w: World, channel: string, change: unknown, headers: Record<string, string> = w.human) {
  const current = await settings(w, channel);
  return call(w.server.port, {
    method: 'POST', path: `/api/human/channels/${channel}/discovery`, headers,
    body: { operationId: `set-${randomBytes(6).toString('hex')}`, expectedRevision: current.revision, change },
  });
}

async function inbox(w: World) {
  const reply = await call(w.server.port, { path: '/api/human/channel-requests', headers: w.human });
  expect(reply.status).toBe(200);
  return reply.json.requests as Array<{ requestHandle: string; revision: string; operationKind: string; outcome: string; requester: { harness: string; displayLabel: string | null } }>;
}

async function decide(w: World, handle: string, revision: string, decision: 'approve' | 'deny', headers: Record<string, string> = w.human, kind = 'access') {
  return call(w.server.port, {
    method: 'POST', path: `/api/human/channel-${kind}-requests/${handle}/decision`, headers,
    body: { v: 1, requestHandle: handle, expectedRevision: revision, decision, operationId: `decide-${handle.slice(-8)}-${decision}` },
  });
}

function controlKeys(w: World): string[] {
  return w.handle.read(db => (db.prepare('SELECT record_key FROM control_records').all() as Array<{ record_key: string }>).map(row => row.record_key));
}

async function approvedAccess(w: World, agent: Agent, operationId: string): Promise<void> {
  const requested = await requestAccess(w, agent, operationId, { channelUrl: `${w.server.origin}/channels/${channelId}` });
  expect(requested.json).toEqual({ v: 1, operationId, outcome: 'pending_owner' });
  const pending = (await inbox(w)).find(entry => entry.outcome === 'pending_owner')!;
  expect((await decide(w, pending.requestHandle, pending.revision, 'approve')).status).toBe(200);
}

describe('internal channel discovery', () => {
  it('issues a separate 0600 discovery descriptor and connector key, and rotates on reissue', async () => {
    const w = await world();
    const first = await issue(w, 'session-1', 'Build agent');
    const directory = path.dirname(first.descriptorPath);
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    for (const name of fs.readdirSync(directory)) expect(fs.statSync(path.join(directory, name)).mode & 0o777).toBe(0o600);
    // The descriptor carries no connector key material; the key file carries no capability.
    expect(fs.readFileSync(first.descriptorPath, 'utf8')).not.toContain(first.connector.privateKey);
    expect(fs.readFileSync(path.join(directory, 'connector-key.json'), 'utf8')).not.toContain(first.capability);
    expect(fs.readFileSync(first.descriptorPath, 'utf8')).not.toContain(w.transportCapability);
    expect(first.generation).toBe(1);
    // The stored form is a digest; the capability itself never reaches SQLite.
    const state = path.join(w.fixture.root, 'state');
    expect(fs.readdirSync(state)).toContain(ROOM_DATABASE_FILE);
    for (const name of fs.readdirSync(state)) expect(fs.readFileSync(path.join(state, name)).includes(first.capability)).toBe(false);

    const rotated = await issue(w, 'session-1');
    expect(rotated).toMatchObject({ principal: first.principal, generation: 2 });
    expect((await list(w, first)).status).toBe(401);
    expect((await list(w, rotated)).status).toBe(200);
    const agents = await call(w.server.port, { path: '/api/human/discovery/agents', headers: w.human });
    expect(agents.json.agents).toEqual([expect.objectContaining({ principal: first.principal, generation: 2, harness: 'codex', displayLabel: null })]);
  });

  it('lists different private channels to two same-owner agents and never lists a secret channel', async () => {
    const w = await world();
    const one = await issue(w, 'session-1');
    const two = await issue(w, 'session-2');
    expect((await list(w, one)).json).toEqual({ v: 1, items: [], nextCursor: null });
    expect((await setSettings(w, channelId, { kind: 'allow', principal: one.principal, expectedGeneration: 1 })).status).toBe(200);
    expect((await setSettings(w, otherChannelId, { kind: 'visibility', visibility: 'public' })).status).toBe(200);
    const titles = async (agent: Agent) => ((await list(w, agent)).json.items as Array<{ title: string }>).map(item => item.title);
    expect(await titles(one)).toEqual(['One', 'Two']);
    expect(await titles(two)).toEqual(['Two']);
    const listed = (await list(w, one)).json.items[0];
    expect(Object.keys(listed).sort()).toEqual(['listingRef', 'requestState', 'serviceKind', 'title', 'v', 'visibility']);
    expect(listed).toMatchObject({ visibility: 'private', serviceKind: 'internal', requestState: 'not_requested' });
    expect(JSON.stringify((await list(w, one)).json)).not.toContain(channelId);

    expect((await setSettings(w, channelId, { kind: 'visibility', visibility: 'secret' })).status).toBe(200);
    expect(await titles(one)).toEqual(['Two']);
    // A listing reference issued to one agent is not a handle for the other.
    const ref = (await list(w, two)).json.items[0].listingRef as string;
    expect((await requestAccess(w, one, 'op-foreign-ref', { listingRef: ref })).json.outcome).toBe('unavailable');
    expect((await requestAccess(w, two, 'op-own-ref', { listingRef: ref })).json.outcome).toBe('pending_owner');
  });

  it('wrong implementation: a discovery descriptor alone can list and submit intents but holds no other authority', async () => {
    const w = await world();
    await setSettings(w, otherChannelId, { kind: 'visibility', visibility: 'public' });
    const agent = await issue(w, 'session-unjoined');
    const before = w.handle.read(db => ({
      channels: db.prepare('SELECT count(*) AS n FROM channels').get(),
      memberships: db.prepare('SELECT count(*) AS n FROM memberships').get(),
      bindings: db.prepare('SELECT count(*) AS n FROM bindings').get(),
    }));

    expect((await list(w, agent)).status).toBe(200);
    const ref = (await list(w, agent)).json.items[0].listingRef as string;
    expect((await requestAccess(w, agent, 'op-access', { listingRef: ref })).json).toEqual({ v: 1, operationId: 'op-access', outcome: 'pending_owner' });
    expect((await requestCreate(w, agent, 'op-create')).json).toEqual({ v: 1, operationId: 'op-create', outcome: 'pending_owner' });

    const denied = [
      // send, receive
      { method: 'POST', path: `/api/v1/channels/${otherChannelId}/messages`, body: { clientTxnId: 't1', content: { v: 1, kind: 'text', body: 'hi' } } },
      { path: `/api/v1/channels/${otherChannelId}/timeline` },
      { path: `/api/v1/channels/${otherChannelId}` },
      { path: `/api/v1/channels/${otherChannelId}/hints` },
      // create a channel directly
      { method: 'POST', path: '/api/v1/channels', body: { operationId: 'c1', title: 'Mine' } },
      // decide, mute, read the inbox
      { path: '/api/human/channel-requests' },
      { method: 'POST', path: '/api/human/channel-requests/mute', body: {} },
      // change visibility or the allowlist, read the verified-agent picker
      { method: 'POST', path: `/api/human/channels/${otherChannelId}/discovery`, body: { operationId: 'v1', expectedRevision: 1, change: { kind: 'visibility', visibility: 'secret' } } },
      { method: 'POST', path: `/api/human/channels/${otherChannelId}/discovery`, body: { operationId: 'a1', expectedRevision: 1, change: { kind: 'allow', principal: agent.principal, expectedGeneration: 1 } } },
      { path: '/api/human/discovery/agents' },
      // mint more discovery authority
      { method: 'POST', path: '/api/internal/discovery/descriptors', body: {} },
    ];
    for (const route of denied) {
      const reply = await call(w.server.port, { ...route, headers: bearer(agent) });
      expect([route.path, reply.status, reply.json?.error?.code]).toEqual([route.path, 403, 'forbidden']);
    }
    for (const entry of await inbox(w)) {
      const reply = await decide(w, entry.requestHandle, entry.revision, 'approve', bearer(agent), entry.operationKind);
      expect(reply.status).toBe(403);
    }
    // Even an approved request cannot be exchanged by the descriptor: the connector key must sign.
    const pending = (await inbox(w)).find(entry => entry.operationKind === 'access')!;
    expect((await decide(w, pending.requestHandle, pending.revision, 'approve')).status).toBe(200);
    const body = await exchangeRequest(w, agent, 'op-access');
    const noProof = await exchangeCall(w, agent, 'op-access', body);
    expect([noProof.status, noProof.json]).toEqual([401, { v: 1, kind: 'rejected', code: 'proof_required' }]);

    const after = w.handle.read(db => ({
      channels: db.prepare('SELECT count(*) AS n FROM channels').get(),
      memberships: db.prepare('SELECT count(*) AS n FROM memberships').get(),
      bindings: db.prepare('SELECT count(*) AS n FROM bindings').get(),
    }));
    expect(after).toEqual(before);
    // No exchange ran and no grant was minted.
    expect(controlKeys(w).some(key => /exchange|grant/i.test(key))).toBe(false);
    expect((await accessStatus(w, agent, 'op-access')).json.outcome).toBe('approved');
  });

  it('exchanges an approved request only through the proof-bound connector route and recovers the same envelope', async () => {
    const w = await world();
    const agent = await issue(w, 'session-1');
    const other = await issue(w, 'session-2');
    await approvedAccess(w, agent, 'op-1');
    const url = `${w.server.origin}/api/connector/channel-access-requests/op-1/exchange`;
    const body = await exchangeRequest(w, agent, 'op-1');

    // Wrong key, wrong target URL, stale proof and another agent's capability are all refused.
    expect((await exchangeCall(w, agent, 'op-1', body, proof(w, agent, url, { key: other.connector }))).status).toBe(401);
    expect((await exchangeCall(w, agent, 'op-1', body, proof(w, agent, `${url}x`))).status).toBe(401);
    expect((await exchangeCall(w, agent, 'op-1', body, proof(w, agent, url, { iat: Math.floor(NOW / 1000) - 120 }))).status).toBe(401);
    const foreign = await exchangeCall(w, other, 'op-1', { ...body, requester: other.principal }, proof(w, other, url));
    expect(foreign.status).not.toBe(200);

    const signed = proof(w, agent, url);
    const first = await exchangeCall(w, agent, 'op-1', body, signed);
    expect(first.status).toBe(200);
    expect(Object.keys(first.json).sort()).toEqual(['algorithm', 'ciphertext', 'recipientKeyThumbprint', 'v']);
    // A replayed proof is refused; a fresh proof for the same tuple returns the byte-identical envelope.
    expect((await exchangeCall(w, agent, 'op-1', body, signed)).status).toBe(401);
    const retry = await exchangeCall(w, agent, 'op-1', body, proof(w, agent, url));
    expect(retry.text).toBe(first.text);
    // Admission joined the agent with no binding; the journal stays connecting until activation.
    expect(w.handle.read(db => db.prepare('SELECT membership FROM memberships WHERE channel_id = ? AND participant_id = ?')
      .get(channelId, `participant_${agent.principal}`))).toEqual({ membership: 'joined' });
    expect(w.handle.read(db => db.prepare('SELECT count(*) AS n FROM bindings WHERE participant_id = ?').get(`participant_${agent.principal}`))).toEqual({ n: 0 });
    expect((await accessStatus(w, agent, 'op-1')).json.outcome).toBe('connecting');
    expect((await accessStatus(w, agent, 'op-1')).text).not.toContain(first.json.ciphertext);
  });

  it('keeps visibility, allowlists, pending decisions and exchange recovery across restart', async () => {
    const first = await world();
    const agent = await issue(first, 'session-1');
    const waiting = await issue(first, 'session-2');
    await setSettings(first, channelId, { kind: 'allow', principal: agent.principal, expectedGeneration: 1 });
    await approvedAccess(first, agent, 'op-1');
    expect((await requestCreate(first, waiting, 'op-pending')).json.outcome).toBe('pending_owner');
    const url = (w: World) => `${w.server.origin}/api/connector/channel-access-requests/op-1/exchange`;
    const body = await exchangeRequest(first, agent, 'op-1');
    const envelope = await exchangeCall(first, agent, 'op-1', body, proof(first, agent, url(first)));
    expect(envelope.status).toBe(200);

    await first.server.close();
    first.handle.close();
    const reopened = openChannelStore({ directory: path.join(first.fixture.root, 'state'), mode: 'existing' });
    cleanups.push(() => reopened.close());
    // The launcher resumes on its fixed start port, so the service origin is unchanged.
    const second = await boot(first.fixture, reopened, { now: NOW + 30_000 }, first.server.port);
    expect(second.server.origin).toBe(first.server.origin);

    expect(((await list(second, agent)).json.items as Array<{ title: string }>).map(item => item.title)).toEqual(['One']);
    expect((await settings(second, channelId)).allowlist).toEqual([agent.principal]);
    expect((await inbox(second)).map(entry => [entry.operationKind, entry.outcome]).sort())
      .toEqual([['access', 'connecting'], ['create', 'pending_owner']]);
    // The sealed envelope for the unchanged operation is recovered byte-for-byte without re-admitting.
    const recovered = await exchangeCall(second, agent, 'op-1', body, proof(second, agent, url(second)));
    expect(recovered.text).toBe(envelope.text);
    expect(second.handle.read(db => db.prepare('SELECT count(*) AS n FROM admission_operations').get())).toEqual({ n: 1 });
  });

  it('revalidates the session generation on rebind and expires pending requests at the deadline', async () => {
    const w = await world();
    const agent = await issue(w, 'session-1');
    const requested = await requestAccess(w, agent, 'op-1', { channelUrl: `${w.server.origin}/channels/${channelId}` });
    expect(requested.json.outcome).toBe('pending_owner');
    const rebound = await issue(w, 'session-1');
    // The old generation is no longer authenticated, and the pending request is closed for the new one.
    expect((await accessStatus(w, agent, 'op-1')).status).toBe(401);
    expect((await accessStatus(w, rebound, 'op-1')).json.outcome).toBe('unavailable');
    const pending = await inbox(w);
    expect(pending.map(entry => entry.outcome)).toEqual([]);

    // The journal's five-minute requester cooldown still applies to the rebound session.
    w.clock.now += 5 * 60_000;
    const fresh = await requestAccess(w, rebound, 'op-2', { channelUrl: `${w.server.origin}/channels/${channelId}` });
    expect(fresh.json.outcome).toBe('pending_owner');
    w.clock.now += 7 * 24 * 60 * 60_000;
    expect((await accessStatus(w, rebound, 'op-2')).json.outcome).toBe('expired');
  });

  it('serves khala join on the journal path for a discovery descriptor only', async () => {
    const w = await world();
    const agent = await issue(w, 'session-join');
    const body = { v: 1, kind: 'channel_url', operationId: 'op-join', credentialRef: agent.principal, channelUrl: `${w.server.origin}/channels/${channelId}` };
    const join = (headers: Record<string, string>) => call(w.server.port, { method: 'POST', path: '/api/agent/channel-access/request', headers, body });
    expect((await join(bearer(w.transportCapability))).status).toBe(403);
    expect((await join(bearer(w.fixture.bob.credential))).status).toBe(403);
    expect((await join(bearer(agent))).json).toEqual({ v: 1, operationId: 'op-join', outcome: 'pending_owner' });
    // The alias is the same journal operation as the discovery path.
    expect((await accessStatus(w, agent, 'op-join')).json.outcome).toBe('pending_owner');
    expect(await inbox(w)).toHaveLength(1);
  });

  it('collapses unknown or malformed channel URLs to unavailable without revealing existence', async () => {
    const w = await world();
    const agent = await issue(w, 'session-1');
    for (const [operationId, channelUrl] of [
      ['op-unknown', `${w.server.origin}/channels/ch_missing`],
      ['op-shape', `${w.server.origin}/elsewhere/${channelId}`],
    ] as const) {
      expect((await requestAccess(w, agent, operationId, { channelUrl })).json).toEqual({ v: 1, operationId, outcome: 'unavailable' });
    }
    expect((await requestAccess(w, agent, 'op-host', { channelUrl: `https://hostile.example/channels/${channelId}` })).status).toBe(400);
    // Secret channels stay reachable by URL, and still only as an owner prompt.
    await setSettings(w, channelId, { kind: 'visibility', visibility: 'secret' });
    expect((await requestAccess(w, agent, 'op-secret', { channelUrl: `${w.server.origin}/channels/${channelId}` })).json.outcome).toBe('pending_owner');
    expect((await inbox(w))).toHaveLength(1);
  });

  it('lets only the human cookie decide and change settings, with exact Host and Origin checks', async () => {
    const w = await world();
    const agent = await issue(w, 'session-1');
    await requestAccess(w, agent, 'op-1', { channelUrl: `${w.server.origin}/channels/${channelId}` });
    const [pending] = await inbox(w);
    const bindingHeaders = bearer(w.fixture.bob.credential);
    const transportHeaders = bearer(w.transportCapability);
    for (const headers of [bindingHeaders, transportHeaders]) {
      expect((await decide(w, pending!.requestHandle, pending!.revision, 'approve', headers)).status).toBe(403);
      expect((await setSettings(w, channelId, { kind: 'visibility', visibility: 'public' }, headers)).status).toBe(403);
      expect((await call(w.server.port, { path: '/api/agent/channels', headers })).status).toBe(403);
    }
    const noOrigin = Object.fromEntries(Object.entries(w.human).filter(([name]) => name !== 'origin'));
    expect((await decide(w, pending!.requestHandle, pending!.revision, 'approve', { ...noOrigin, origin: 'https://hostile.example' })).status).toBe(403);
    expect((await decide(w, pending!.requestHandle, pending!.revision, 'approve', noOrigin)).status).toBe(403);
    expect((await call(w.server.port, { path: '/api/human/channel-requests', headers: { ...w.human, host: `localhost:${w.server.port}` } })).status).toBe(400);
    // The wrong kind of route does not decide a request of the other kind.
    expect((await decide(w, pending!.requestHandle, pending!.revision, 'approve', w.human, 'create')).status).toBe(404);
    const denied = await decide(w, pending!.requestHandle, pending!.revision, 'deny');
    expect([denied.status, denied.json.outcome]).toEqual([200, 'denied']);
    expect((await accessStatus(w, agent, 'op-1')).json.outcome).toBe('denied');
    // Retrying the terminal decision with a stale revision never re-decides.
    expect((await decide(w, pending!.requestHandle, pending!.revision, 'approve')).status).toBe(409);
  });

  it('creates or reconciles one secret channel from a human-authorized workflow, with no binding or readiness', async () => {
    const w = await world();
    const agent = await issue(w, 'session-1');
    expect((await requestCreate(w, agent, 'op-create', 'Agent proposal')).json.outcome).toBe('pending_owner');
    // Submission alone creates nothing.
    expect(w.handle.read(db => db.prepare('SELECT count(*) AS n FROM channels').get())).toEqual({ n: 2 });
    const workflow = {
      v: 1 as const, kind: 'human_authorized_channel_create' as const, ownerId: alice.ownerId,
      authorizationRef: 'auth-1', expiresAt: new Date(NOW + 60_000).toISOString(),
    };
    const intent = { v: 1 as const, operationId: 'op-create', credentialRef: agent.principal, origin: w.server.origin, proposedTitle: 'Agent proposal' };
    expect(await w.discovery.createAdapter.reconcile({ workflow, idempotencyKey: 'create-1' }))
      .toEqual({ v: 1, idempotencyKey: 'create-1', outcome: 'pending', channelRef: null });
    const created = await w.discovery.createAdapter.create({ intent, workflow, idempotencyKey: 'create-1' });
    expect(created).toMatchObject({ outcome: 'created', channelRef: expect.stringMatching(/^ch_/) });
    // The response is lost; a retry and a reconciliation name the same channel.
    expect(await w.discovery.createAdapter.create({ intent, workflow, idempotencyKey: 'create-1' }))
      .toEqual({ ...created, outcome: 'already_created' });
    expect(await w.discovery.createAdapter.reconcile({ workflow, idempotencyKey: 'create-1' }))
      .toEqual({ ...created, outcome: 'already_created' });
    const channel = created.channelRef as unknown as RoomId;
    expect((await settings(w, channel)).visibility).toBe('secret');
    expect(w.handle.read(db => db.prepare('SELECT participant_id FROM memberships WHERE channel_id = ?').all(channel)))
      .toEqual([{ participant_id: alice.participantId }]);
    expect(w.handle.read(db => db.prepare('SELECT count(*) AS n FROM bindings').get())).toEqual({ n: 2 });
    expect((await inbox(w)).find(entry => entry.operationKind === 'create')?.outcome).toBe('pending_owner');
    // Another owner's authorization, or an expired one, creates nothing.
    expect((await w.discovery.createAdapter.create({ intent, workflow: { ...workflow, ownerId: 'owner-other' as typeof alice.ownerId }, idempotencyKey: 'create-2' })).outcome)
      .toBe('unavailable');
    w.clock.now += 120_000;
    expect((await w.discovery.createAdapter.create({ intent, workflow, idempotencyKey: 'create-3' })).outcome).toBe('unavailable');
    expect(w.handle.read(db => db.prepare('SELECT count(*) AS n FROM channels').get())).toEqual({ n: 3 });
  });

  it('keeps the admission adapter idempotent per provider operation', async () => {
    const w = await world();
    const agent = await issue(w, 'session-1');
    const input = {
      providerOperationId: 'padmit-1', ownerId: alice.ownerId, channelRef: channelId as unknown as Parameters<typeof w.discovery.admission.admit>[0]['channelRef'],
      requester: agent.principal as Parameters<typeof w.discovery.admission.admit>[0]['requester'], sessionGeneration: 1,
      deviceId: 'device-1' as DeviceId, history: 'none' as const,
    };
    expect(await w.discovery.admission.reconcile(input)).toEqual({ kind: 'not_applied' });
    expect(await w.discovery.admission.admit(input)).toEqual({ kind: 'admitted', membership: 'joined' });
    expect(await w.discovery.admission.admit(input)).toEqual({ kind: 'admitted', membership: 'joined' });
    expect(await w.discovery.admission.reconcile(input)).toEqual({ kind: 'admitted', membership: 'joined' });
    // A stale generation is never admitted.
    expect(await w.discovery.admission.admit({ ...input, providerOperationId: 'padmit-2', sessionGeneration: 2 })).toEqual({ kind: 'rejected' });
  });
});
