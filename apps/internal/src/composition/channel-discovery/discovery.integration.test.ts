import { createHash, createPrivateKey, randomBytes, sign } from 'node:crypto';
import fs from 'node:fs';
import { type IncomingMessage, request as httpRequest } from 'node:http';
import path from 'node:path';
import {
  parseInternalConnectorKey, parseInternalDiscoveryDescriptor,
} from '@khala/contracts/internal/discovery-descriptor';
import {
  type DeviceId, type GrantExchangeRequest, type RoomId, deriveOkpKeyThumbprint,
} from '@khala/contracts/messaging/index';
import { PassThrough } from 'node:stream';
import { runCli } from '@aiur/khala/cli/app';
import { openInbox } from '@aiur/khala/cli/inbox';
import { createInternalClient, readInternalDescriptor } from '@aiur/khala/composition/internal';
import { ChannelCreateService } from '@aiur/khala/cli/channels/create/service';
import { createInternalDelivery } from '@aiur/khala/composition/internal-delivery';
import { sessionGrants } from '@aiur/khala/composition/session-grant';
import sodium from 'libsodium-wrappers';
import { afterEach, describe, expect, it } from 'vitest';
import { writeActiveDescriptor } from '../../descriptor/write';
import { type ChannelServerOptions, startChannelServer } from '../../server/channel-server';
import { mintCredential } from '../../server/credentials';
import { createInternalReleaseFeed, internalReleaseId } from '../internal-delivery/release-feed';
import { createSqliteListeningModeRepository } from '../../listening-mode-store/sqlite';
import { aliceDevice, alice, channelId, createChannelFixture, otherChannelId, type ChannelFixture } from '../../server/fixtures/channel-fixture';
import type { LoopbackServer } from '../../server/server';
import { createExchangeGrantIssuer } from '@khala/messaging/channel-access/exchange/grants';
import { createChannelStore } from '../../store/channel-store';
import { createSqliteControlStore } from '../../store/control-store';
import { ROOM_DATABASE_FILE } from '../../store/path';
import { type DiscoveryStore, createDiscoveryStore } from '../../store/discovery-store';
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

async function boot(
  fixture: ChannelFixture, handle: InternalStoreHandle, clock: { now: number }, startPort = 0,
  extra: Partial<ChannelServerOptions> = {},
  wrapStore: (store: DiscoveryStore) => DiscoveryStore = store => store,
): Promise<World> {
  const discovery = await composeInternalChannelDiscovery({
    control: createSqliteControlStore(handle, () => clock.now),
    store: wrapStore(createDiscoveryStore(handle)),
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
    ...extra,
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

async function world(wrapStore?: (store: DiscoveryStore) => DiscoveryStore): Promise<World> {
  const fixture = createChannelFixture({ root: fs.mkdtempSync('/tmp/khala-discovery-'), now: NOW });
  cleanups.push(() => fixture.dispose());
  return boot(fixture, fixture.handle, { now: NOW }, 0, {}, wrapStore);
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

type Recovery = Readonly<{ publicKey: Uint8Array; privateKey: Uint8Array }>;

/** A connector's X25519 recovery keypair; the service seals the grant to its public half. */
async function recoveryKey(): Promise<Recovery> {
  await sodium.ready;
  return sodium.crypto_box_keypair();
}

async function exchangeRequest(
  w: World, agent: Agent, operationId: string, deviceId = 'device_connector_1', recovery?: Recovery,
): Promise<GrantExchangeRequest> {
  const proofThumbprint = await deriveOkpKeyThumbprint({ algorithm: 'Ed25519', publicKey: agent.connector.publicKey, thumbprint: '' });
  const box = sodium.to_base64((recovery ?? await recoveryKey()).publicKey, sodium.base64_variants.URLSAFE_NO_PADDING);
  const boxThumbprint = await deriveOkpKeyThumbprint({ algorithm: 'X25519', publicKey: box, thumbprint: '' });
  if (!proofThumbprint.ok || !boxThumbprint.ok) throw new Error('crypto');
  return {
    v: 1, operationId, requester: agent.principal as GrantExchangeRequest['requester'], origin: w.server.origin,
    proofKey: { algorithm: 'Ed25519', publicKey: agent.connector.publicKey, thumbprint: proofThumbprint.thumbprint },
    encryptionKey: { algorithm: 'X25519', publicKey: box, thumbprint: boxThumbprint.thumbprint },
    deviceId: deviceId as DeviceId, sessionGeneration: agent.generation, expiresAt: new Date(w.clock.now + 60_000).toISOString(),
  };
}

/** Opens a sealed envelope exactly as the connector does and returns the one-time grant. */
function openGrant(envelope: { ciphertext: string }, recovery: Recovery): string {
  const ciphertext = sodium.from_base64(envelope.ciphertext, sodium.base64_variants.URLSAFE_NO_PADDING);
  const opened = JSON.parse(sodium.to_string(sodium.crypto_box_seal_open(ciphertext, recovery.publicKey, recovery.privateKey)));
  return opened.grant as string;
}

function activateCall(w: World, agent: Agent, operationId: string, body: Readonly<{ deviceId: string; grant: string | null }>, signed = true) {
  const route = `/api/connector/channel-access-requests/${operationId}/activate`;
  return call(w.server.port, {
    method: 'POST', path: route, body: { v: 1, operationId, ...body },
    headers: { ...bearer(agent), ...(signed ? { dpop: proof(w, agent, `${w.server.origin}${route}`) } : {}) },
  });
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
    // It cannot file a request in another agent's name.
    const other = await issue(w, 'session-other');
    const impersonated = await call(w.server.port, {
      method: 'POST', path: '/api/agent/channel-access-requests', headers: bearer(agent),
      body: { v: 1, kind: 'listing_ref', operationId: 'op-impersonate', credentialRef: other.principal, listingRef: ref },
    });
    expect(impersonated.status).toBe(403);

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
    const recovery = await recoveryKey();
    const body = await exchangeRequest(w, agent, 'op-1', undefined, recovery);

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

    // Readiness after local activation is also connector-only, then ends envelope recovery.
    const readyUrl = `${w.server.origin}/api/connector/channel-access-requests/op-1/ready`;
    const readiness = {
      v: 1, operationId: 'op-1', requester: agent.principal, origin: w.server.origin, sessionGeneration: agent.generation,
      deviceId: body.deviceId, proofKeyThumbprint: body.proofKey.thumbprint, recipientKeyThumbprint: body.encryptionKey.thumbprint,
    };
    const ready = (headers: Record<string, string>) => call(w.server.port, {
      method: 'POST', path: '/api/connector/channel-access-requests/op-1/ready', headers: { ...bearer(agent), ...headers }, body: readiness,
    });
    expect((await ready({})).status).toBe(401);
    // Readiness before a binding exists would claim `connected` for an agent that cannot send.
    const early = await ready({ dpop: proof(w, agent, readyUrl) });
    expect([early.status, early.json]).toEqual([409, { v: 1, kind: 'rejected', code: 'operation_mismatch' }]);
    expect((await accessStatus(w, agent, 'op-1')).json.outcome).toBe('connecting');
    expect((await activateCall(w, agent, 'op-1', { deviceId: body.deviceId, grant: openGrant(first.json, recovery) })).status).toBe(200);
    const acknowledged = await ready({ dpop: proof(w, agent, readyUrl) });
    expect([acknowledged.status, acknowledged.json]).toEqual([200, { v: 1, operationId: 'op-1', outcome: 'connected' }]);
    expect((await accessStatus(w, agent, 'op-1')).json.outcome).toBe('connected');
    expect((await ready({ dpop: proof(w, agent, readyUrl) })).status).toBe(200);
    // The envelope is gone once readiness is acknowledged.
    expect((await exchangeCall(w, agent, 'op-1', body, proof(w, agent, url))).status).toBe(410);
  });

  it('turns an approved request into a working binding: request, approve, exchange, activate, send and read', async () => {
    const w = await world();
    const agent = await issue(w, 'session-full');
    await approvedAccess(w, agent, 'op-full');
    const recovery = await recoveryKey();
    const body = await exchangeRequest(w, agent, 'op-full', 'device_full_1', recovery);
    const exchangeUrl = `${w.server.origin}/api/connector/channel-access-requests/op-full/exchange`;
    const envelope = await exchangeCall(w, agent, 'op-full', body, proof(w, agent, exchangeUrl));
    expect(envelope.status).toBe(200);
    const grant = openGrant(envelope.json, recovery);
    const bindingRows = () => w.handle.read(db => db.prepare('SELECT count(*) AS n FROM bindings WHERE participant_id = ?')
      .get(`participant_${agent.principal}`));

    // Only the connector key activates, only for the device the grant is bound to, and only with that grant.
    expect((await activateCall(w, agent, 'op-full', { deviceId: body.deviceId, grant }, false)).status).toBe(401);
    expect((await activateCall(w, agent, 'op-full', { deviceId: 'device_other', grant })).status).toBe(410);
    expect((await activateCall(w, agent, 'op-full', { deviceId: body.deviceId, grant: `cagrant_${'A'.repeat(43)}` })).status).toBe(410);
    expect((await activateCall(w, agent, 'op-full', { deviceId: body.deviceId, grant: null })).status).toBe(410);
    expect(bindingRows()).toEqual({ n: 0 });

    const activated = await activateCall(w, agent, 'op-full', { deviceId: body.deviceId, grant });
    expect(activated.status).toBe(200);
    expect(activated.json).toMatchObject({
      v: 1, operationId: 'op-full', channelId,
      binding: { v: 1, ownerId: alice.ownerId, agentParticipantId: `participant_${agent.principal}`, deviceId: body.deviceId, generation: 1 },
    });
    const capability = activated.json.capability as string;
    expect(capability).not.toBe(agent.capability);
    expect(activated.text).not.toContain(grant);
    expect(bindingRows()).toEqual({ n: 1 });

    // The agent sends and reads in the channel it was admitted to, and nowhere else.
    const timeline = (credential: string, channel: string = channelId) =>
      call(w.server.port, { path: `/api/v1/channels/${channel}/timeline`, headers: bearer(credential) });
    const sent = await call(w.server.port, {
      method: 'POST', path: `/api/v1/channels/${channelId}/messages`, headers: bearer(capability),
      body: { clientTxnId: 'txn-full', content: { v: 1, kind: 'text', body: 'hello from the joined agent' } },
    });
    expect(sent.status).toBe(201);
    expect(sent.json.event.participant).toMatchObject({ participantId: `participant_${agent.principal}` });
    const read = await timeline(capability);
    expect(read.status).toBe(200);
    expect(read.json.events.map((event: { content: { body: string } }) => event.content.body)).toContain('hello from the joined agent');
    expect((await timeline(capability, otherChannelId)).status).toBe(403);
    const human = await call(w.server.port, { path: `/api/v1/channels/${channelId}/timeline`, headers: w.human });
    expect(human.json.events.map((event: { content: { body: string } }) => event.content.body)).toContain('hello from the joined agent');
    // The binding capability holds no discovery authority.
    expect((await call(w.server.port, { path: '/api/agent/channels', headers: bearer(capability) })).status).toBe(403);

    // Only now is readiness acknowledged, so `connected` is true.
    const readyRoute = '/api/connector/channel-access-requests/op-full/ready';
    const readiness = {
      v: 1, operationId: 'op-full', requester: agent.principal, origin: w.server.origin, sessionGeneration: agent.generation,
      deviceId: body.deviceId, proofKeyThumbprint: body.proofKey.thumbprint, recipientKeyThumbprint: body.encryptionKey.thumbprint,
    };
    const ready = await call(w.server.port, {
      method: 'POST', path: readyRoute, body: readiness,
      headers: { ...bearer(agent), dpop: proof(w, agent, `${w.server.origin}${readyRoute}`) },
    });
    expect(ready.json).toEqual({ v: 1, operationId: 'op-full', outcome: 'connected' });

    // Retries are idempotent by operation ID: a replayed grant and a grant-free resume return the
    // same binding with a fresh capability, and the capability they replace stops working.
    const replayed = await activateCall(w, agent, 'op-full', { deviceId: body.deviceId, grant });
    expect(replayed.json.binding).toEqual(activated.json.binding);
    const resumed = await activateCall(w, agent, 'op-full', { deviceId: body.deviceId, grant: null });
    expect(resumed.json.binding).toEqual(activated.json.binding);
    expect((await timeline(capability)).status).toBe(401);
    expect((await timeline(replayed.json.capability)).status).toBe(401);
    expect((await timeline(resumed.json.capability)).status).toBe(200);
    expect(bindingRows()).toEqual({ n: 1 });
    expect((await activateCall(w, agent, 'op-full', { deviceId: 'device_other', grant: null })).status).toBe(409);

    // Revocation stops the binding, and resuming never mints it a new capability.
    const binding = activated.json.binding as { bindingId: string; generation: number };
    expect(createChannelStore(w.handle).revokeBinding({ bindingId: binding.bindingId, generation: binding.generation }).kind).toBe('done');
    expect((await timeline(resumed.json.capability)).status).toBe(401);
    expect((await activateCall(w, agent, 'op-full', { deviceId: body.deviceId, grant: null })).status).toBe(410);
  });

  it('finishes an activation whose grant was consumed before the binding was recorded', async () => {
    const w = await world();
    const agent = await issue(w, 'session-crash');
    await approvedAccess(w, agent, 'op-crash');
    const recovery = await recoveryKey();
    const body = await exchangeRequest(w, agent, 'op-crash', 'device_crash_1', recovery);
    const exchangeUrl = `${w.server.origin}/api/connector/channel-access-requests/op-crash/exchange`;
    const grant = openGrant((await exchangeCall(w, agent, 'op-crash', body, proof(w, agent, exchangeUrl))).json, recovery);
    // A crash after redemption: the grant is consumed, but no binding or activation exists yet.
    const issuer = createExchangeGrantIssuer({ store: createSqliteControlStore(w.handle, () => w.clock.now), clock: () => w.clock.now });
    const consumed = await issuer.redeem({
      grant, operationId: 'op-crash', requester: body.requester, origin: body.origin, sessionGeneration: body.sessionGeneration,
      deviceId: body.deviceId, proofKeyThumbprint: body.proofKey.thumbprint,
    });
    expect(consumed.kind).toBe('redeemed');
    const activated = await activateCall(w, agent, 'op-crash', { deviceId: body.deviceId, grant });
    expect(activated.status).toBe(200);
    expect((await call(w.server.port, { path: `/api/v1/channels/${channelId}/timeline`, headers: bearer(activated.json.capability) })).status).toBe(200);
  });

  it('keeps visibility, allowlists, pending decisions and exchange recovery across restart', async () => {
    const first = await world();
    const agent = await issue(first, 'session-1');
    const waiting = await issue(first, 'session-2');
    await setSettings(first, channelId, { kind: 'allow', principal: agent.principal, expectedGeneration: 1 });
    await approvedAccess(first, agent, 'op-1');
    expect((await requestCreate(first, waiting, 'op-pending')).json.outcome).toBe('pending_owner');
    const url = (w: World) => `${w.server.origin}/api/connector/channel-access-requests/op-1/exchange`;
    const recovery = await recoveryKey();
    const body = await exchangeRequest(first, agent, 'op-1', undefined, recovery);
    const envelope = await exchangeCall(first, agent, 'op-1', body, proof(first, agent, url(first)));
    expect(envelope.status).toBe(200);
    const activated = await activateCall(first, agent, 'op-1', { deviceId: body.deviceId, grant: openGrant(envelope.json, recovery) });
    expect(activated.status).toBe(200);

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
    // Capabilities live only in the running server; the relaunched one resumes the same binding by operation ID.
    const timeline = (credential: string) =>
      call(second.server.port, { path: `/api/v1/channels/${channelId}/timeline`, headers: bearer(credential) });
    expect((await timeline(activated.json.capability)).status).toBe(401);
    const resumed = await activateCall(second, agent, 'op-1', { deviceId: body.deviceId, grant: null });
    expect(resumed.json.binding).toEqual(activated.json.binding);
    expect((await timeline(resumed.json.capability)).status).toBe(200);
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

  it('closes a pending listing-reference request when the owner revokes that agent from the allowlist', async () => {
    const w = await world();
    const agent = await issue(w, 'session-1');
    await setSettings(w, channelId, { kind: 'allow', principal: agent.principal, expectedGeneration: 1 });
    const ref = (await list(w, agent)).json.items[0].listingRef as string;
    expect((await requestAccess(w, agent, 'op-listed', { listingRef: ref })).json.outcome).toBe('pending_owner');
    // A URL request for the same channel is a locator and does not depend on eligibility.
    w.clock.now += 5 * 60_000;
    expect((await requestAccess(w, agent, 'op-url', { channelUrl: `${w.server.origin}/channels/${channelId}` })).json.outcome).toBe('pending_owner');
    const [listed] = (await inbox(w)).filter(entry => entry.outcome === 'pending_owner');
    expect((await setSettings(w, channelId, { kind: 'revoke', principal: agent.principal, expectedGeneration: 1 })).status).toBe(200);
    expect((await settings(w, channelId)).allowlist).toEqual([]);
    expect((await accessStatus(w, agent, 'op-listed')).json.outcome).toBe('revoked');
    expect((await accessStatus(w, agent, 'op-url')).json.outcome).toBe('pending_owner');
    const stale = await decide(w, listed!.requestHandle, listed!.revision, 'approve');
    expect(stale.status).not.toBe(200);
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

  // Wrong-implementation test: a create path that makes the channel at submission,
  // or on a denial or expiry, leaves rows behind that these counts catch.
  it('creates nothing for a rejected or expired confirmation, and exactly one secret channel on approval', async () => {
    const w = await world();
    // Each scenario is its own agent session: one session holds one create request.
    const serviceFor = async (session: string) =>
      new ChannelCreateService(createInternalClient({ descriptorPath: (await issue(w, session)).descriptorPath }));
    const counts = () => ({
      channels: w.handle.read(db => db.prepare('SELECT count(*) AS n FROM channels').get()),
      memberships: w.handle.read(db => db.prepare('SELECT count(*) AS n FROM memberships').get()),
      bindings: w.handle.read(db => db.prepare('SELECT count(*) AS n FROM bindings').get()),
      grants: controlKeys(w).filter(key => key.includes('grant')),
    });
    const before = counts();
    const pendingFor = async (title: string) => (await inbox(w)).find(entry =>
      entry.operationKind === 'create' && entry.outcome === 'pending_owner'
      && (entry as unknown as { detail: { proposedTitle: string } }).detail.proposedTitle === title)!;

    // Submission alone creates nothing; a rejected confirmation creates nothing.
    const rejecting = await serviceFor('session-reject');
    expect(await rejecting.request({ title: 'Rejected', operationId: 'op-reject', origin: null }))
      .toMatchObject({ ok: true, outcome: 'pending_owner' });
    expect(counts()).toEqual(before);
    const rejected = await pendingFor('Rejected');
    expect((await decide(w, rejected.requestHandle, rejected.revision, 'deny', w.human, 'create')).status).toBe(200);
    expect(await rejecting.status({ operationId: 'op-reject', origin: null })).toMatchObject({ ok: true, outcome: 'denied' });
    expect(counts()).toEqual(before);

    // An unanswered confirmation that outlives its deadline creates nothing either.
    const expiring = await serviceFor('session-expire');
    expect(await expiring.request({ title: 'Expired', operationId: 'op-expire', origin: null }))
      .toMatchObject({ ok: true, outcome: 'pending_owner' });
    w.clock.now += 8 * 24 * 60 * 60_000;
    const expired = await expiring.status({ operationId: 'op-expire', origin: null });
    expect(expired.ok && expired.outcome).not.toBe('connected');
    expect(counts()).toEqual(before);

    // Approval creates exactly one secret channel, still with no binding or grant.
    w.clock.now = NOW;
    const approving = await serviceFor('session-approve');
    await approving.request({ title: 'Approved', operationId: 'op-approve', origin: null });
    const approved = await pendingFor('Approved');
    expect((await decide(w, approved.requestHandle, approved.revision, 'approve', w.human, 'create')).status).toBe(200);
    await approving.status({ operationId: 'op-approve', origin: null });
    await approving.status({ operationId: 'op-approve', origin: null });
    const after = counts();
    expect(after.channels).toEqual({ n: (before.channels as { n: number }).n + 1 });
    expect(after.bindings).toEqual(before.bindings);
    expect(after.grants).toEqual(before.grants);
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

  describe('local activation by the agent client', () => {
    const BODY = 'meet at the north door';
    type Attempt = Readonly<{ action: string; outcome: 'pass' | 'lose' }>;

    async function activationWorld() {
      const fixture = createChannelFixture({ root: fs.mkdtempSync('/tmp/khala-activation-'), now: NOW });
      cleanups.push(() => fixture.dispose());
      const clock = { now: NOW };
      const w = await boot(fixture, fixture.handle, clock, 0, {
        releases: createInternalReleaseFeed({
          store: fixture.store, listeningModes: createSqliteListeningModeRepository(fixture.handle), paused: () => false,
        }),
      });
      const agent = await issue(w, 'session-local');
      const calls: string[] = [];
      // `lose` runs the request on the server, then drops the response: a crash after the effect.
      let plan: Attempt[] = [];
      const transport: typeof fetch = async (input, init) => {
        const url = String(input instanceof Request ? input.url : input);
        const action = /\/(exchange|activate|ready)$/.exec(url)?.[1];
        if (action !== undefined) calls.push(action);
        const step = action === undefined ? undefined : plan.find(each => each.action === action);
        const response = await fetch(input, init);
        if (step?.outcome === 'lose') {
          plan = plan.filter(each => each !== step);
          await response.body?.cancel();
          throw new TypeError('connection lost');
        }
        return response;
      };
      const client = createInternalClient({ descriptorPath: agent.descriptorPath, fetch: transport, clock: () => NOW });
      const channelUrl = `${w.server.origin}/channels/${channelId}`;
      // The agent's own granted descriptor beside its discovery descriptor is the binding of record.
      const grantPath = path.join(path.dirname(agent.descriptorPath), 'grant.json');
      const readGrant = () => JSON.parse(fs.readFileSync(grantPath, 'utf8')) as Record<string, string>;
      const bindingRows = () => w.handle.read(db => (db.prepare('SELECT count(*) AS n FROM bindings WHERE participant_id = ?')
        .get(`participant_${agent.principal}`) as { n: number }).n);
      return {
        w, agent, client, channelUrl, calls, grantPath, readGrant, bindingRows, fixture,
        failNext(...attempts: Attempt[]) { plan = attempts; },
        async approve() {
          expect(await client.requestAccess!(channelUrl)).toEqual({ kind: 'status', outcome: 'pending_owner' });
          const pending = (await inbox(w)).find(entry => entry.outcome === 'pending_owner')!;
          expect((await decide(w, pending.requestHandle, pending.revision, 'approve')).status).toBe(200);
        },
        async khala(args: readonly string[]) {
          const stdout = new PassThrough();
          const stderr = new PassThrough();
          const chunks = { out: '', err: '' };
          stdout.on('data', chunk => { chunks.out += String(chunk); });
          stderr.on('data', chunk => { chunks.err += String(chunk); });
          const stateDirectory = path.join(fixture.root, 'agent-state');
          const code = await runCli(['--internal-descriptor', grantPath, ...args], {
            client: null as never,
            inbox: (bindingId, generation) => openInbox({
              stateDirectory, bindingId, generation, maxPayloadBytes: 64 * 1024, maxSelectionEvents: 32,
            }),
            stdin: new PassThrough(), stdout, stderr,
            internalClient: async descriptorPath => createInternalClient({ descriptorPath }),
            internalDelivery: async descriptorPath => createInternalDelivery({ descriptorPath, stateDirectory }),
          });
          return { code, ...chunks };
        },
        human(body: string) {
          const eventId = `event-local-${body.length}`;
          expect(fixture.store.send({
            channelId, eventId: eventId as never, authorParticipantId: alice.participantId as never, authorDeviceId: aliceDevice,
            clientTxnId: `txn-${eventId}`, content: { v: 1, kind: 'text', body }, receivedAt: new Date(NOW + 1).toISOString(),
          }).kind).toBe('stored');
          return eventId;
        },
      };
    }

    it('activates an approved request, then a human message is read exactly once', async () => {
      const a = await activationWorld();
      await a.approve();
      expect(a.bindingRows()).toBe(0);
      expect(await a.client.requestAccess!(a.channelUrl)).toEqual({ kind: 'status', outcome: 'connected' });
      expect(a.calls).toEqual(['exchange', 'activate', 'ready']);
      expect(a.bindingRows()).toBe(1);
      const active = a.readGrant();
      expect(active).toMatchObject({ channelId, grantRef: expect.any(String), bindingId: expect.any(String), bindingCapability: expect.any(String) });
      expect(fs.statSync(a.grantPath).mode & 0o777).toBe(0o600);
      // Ready is acknowledged only after the descriptor was written.
      expect((await accessStatus(a.w, a.agent, active.grantRef!)).json.outcome).toBe('connected');

      const eventId = a.human(BODY);
      const first = await a.khala(['read']);
      expect(first.code).toBe(0);
      expect(first.out.split(BODY).length - 1).toBe(1);
      expect(first.out).toContain(internalReleaseId({ bindingId: active.bindingId, generation: 1 } as never, eventId as never));
      const token = /batchToken: (\S+)/.exec(first.out)![1]!;
      expect(JSON.parse((await a.khala(['read', '--ack', token])).out)).toEqual({ ok: true, kind: 'empty' });
      expect(JSON.parse((await a.khala(['read'])).out)).toEqual({ ok: true, kind: 'empty' });

      // Nothing secret reaches output: no capability, discovery capability, grant reference or key.
      const streams = first.out + first.err;
      for (const secret of [active.bindingCapability!, a.agent.capability, a.agent.connector.privateKey]) expect(streams).not.toContain(secret);
    });

    it('resumes a lost ready acknowledgement without a second binding or capability', async () => {
      const a = await activationWorld();
      await a.approve();
      a.failNext({ action: 'ready', outcome: 'lose' });
      expect((await a.client.requestAccess!(a.channelUrl)).kind).toBe('status');
      expect(a.bindingRows()).toBe(1);
      const written = a.readGrant();
      a.calls.length = 0;
      expect(await a.client.requestAccess!(a.channelUrl)).toEqual({ kind: 'status', outcome: 'connected' });
      // The held binding is never re-activated, so the running client's capability survives.
      expect(a.calls).not.toContain('activate');
      expect(a.readGrant()).toEqual(written);
      expect(a.bindingRows()).toBe(1);
    });

    it('resumes a lost activate response with a grant-free activation and writes one binding', async () => {
      const a = await activationWorld();
      await a.approve();
      a.failNext({ action: 'activate', outcome: 'lose' });
      await a.client.requestAccess!(a.channelUrl);
      expect(a.bindingRows()).toBe(1);
      expect(() => a.readGrant().bindingId).not.toThrow();
      expect(await a.client.requestAccess!(a.channelUrl)).toEqual({ kind: 'status', outcome: 'connected' });
      expect(a.bindingRows()).toBe(1);
      const active = a.readGrant();
      expect(active.bindingId).toBeDefined();
      const timeline = await call(a.w.server.port, { path: `/api/v1/channels/${channelId}/timeline`, headers: bearer(active.bindingCapability!) });
      expect(timeline.status).toBe(200);
    });

    it('keeps a running listener working when activation rotates the capability', async () => {
      const a = await activationWorld();
      await a.approve();
      await a.client.requestAccess!(a.channelUrl);
      const stale = a.readGrant().bindingCapability!;
      const eventId = a.human(BODY);
      const active = a.readGrant();
      // The listener read the descriptor before activation rotated the capability.
      let reads = 0;
      const delivery = createInternalDelivery({
        descriptorPath: a.grantPath, stateDirectory: path.join(a.fixture.root, 'agent-state'),
        readDescriptor: file => {
          const read = readInternalDescriptor(file);
          return reads++ === 0 && read.ok ? { ...read, value: { ...read.value, bindingCapability: stale } as typeof read.value } : read;
        },
      });
      // A second `/activate` (a repair) rotates the capability and the descriptor is rewritten with it.
      const route = `/api/connector/channel-access-requests/${active.grantRef}/activate`;
      const journal = JSON.parse(fs.readFileSync(path.join(path.dirname(a.agent.descriptorPath), 'activation', `${active.grantRef}.json`), 'utf8'));
      const deviceId = journal.record.deviceId as string;
      const rotated = await call(a.w.server.port, {
        method: 'POST', path: route, headers: { ...bearer(a.agent), dpop: proof(a.w, a.agent, `${a.w.server.origin}${route}`) },
        body: { v: 1, operationId: active.grantRef, deviceId, grant: null },
      });
      expect(rotated.status).toBe(200);
      const next = { ...active, bindingCapability: rotated.json.capability as string };
      fs.writeFileSync(a.grantPath, JSON.stringify(next), { mode: 0o600 });
      expect(next.bindingCapability).not.toBe(stale);
      const inboxFor = () => openInbox({
        stateDirectory: path.join(a.fixture.root, 'agent-state'), bindingId: active.bindingId!, generation: 1,
        maxPayloadBytes: 64 * 1024, maxSelectionEvents: 32,
      });
      // The stale capability is refused, the rewritten descriptor is re-read, and it is not treated as revocation.
      expect(await delivery.pull({ bindingId: active.bindingId!, generation: 1 }, inboxFor)).toBe('caught_up');
      const inbox = await inboxFor();
      const listener = await inbox.acquireListener();
      const batch = await listener.readBatch({ maxBytes: 1024 * 1024 });
      await listener.release();
      expect(batch?.items.map(item => item.record.releaseId)).toEqual([internalReleaseId({ bindingId: active.bindingId, generation: 1 } as never, eventId as never)]);
    });

    // Wrong-implementation test (#391): with one shared grant file, the second session's
    // activation is refused as `repair_required` and only one binding is ever usable.
    it('binds two agent sessions of one OS user to one channel, each through its own granted descriptor', async () => {
      const a = await activationWorld();
      const launchPath = path.join(a.fixture.root, 'active.json');
      const launch = fs.readFileSync(launchPath, 'utf8');
      await a.approve();
      expect(await a.client.requestAccess!(a.channelUrl)).toEqual({ kind: 'status', outcome: 'connected' });

      const second = await issue(a.w, 'session-second');
      const client = createInternalClient({ descriptorPath: second.descriptorPath, clock: () => NOW });
      expect(await client.requestAccess!(a.channelUrl)).toEqual({ kind: 'status', outcome: 'pending_owner' });
      const pending = (await inbox(a.w)).find(entry => entry.outcome === 'pending_owner')!;
      expect((await decide(a.w, pending.requestHandle, pending.revision, 'approve')).status).toBe(200);
      expect(await client.requestAccess!(a.channelUrl)).toEqual({ kind: 'status', outcome: 'connected' });

      const secondGrantPath = path.join(path.dirname(second.descriptorPath), 'grant.json');
      const grants = [a.grantPath, secondGrantPath].map(file => JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, string>);
      expect(grants[0]!.bindingId).not.toBe(grants[1]!.bindingId);
      expect(fs.statSync(secondGrantPath).mode & 0o777).toBe(0o600);
      // No grant reaches the launch's descriptor: it stays transport-only (#407).
      expect(fs.readFileSync(launchPath, 'utf8')).toBe(launch);
      // Each session, pointed at its own file, is connected as its own binding.
      for (const [index, file] of [a.grantPath, secondGrantPath].entries()) {
        const status = await createInternalClient({ descriptorPath: file }).status();
        expect(status).toMatchObject({ connected: true, binding: { bindingId: grants[index]!.bindingId } });
      }
    });

    // Wrong-implementation test (#407): an installed entry that falls back to `active.json`
    // sends as whichever session bound first, or as nobody.
    it('lets two installed Codex entries on one host each send as their own participant', async () => {
      const a = await activationWorld();
      await a.approve();
      expect(await a.client.requestAccess!(a.channelUrl)).toEqual({ kind: 'status', outcome: 'connected' });
      const second = await issue(a.w, 'session-second');
      const client = createInternalClient({ descriptorPath: second.descriptorPath, clock: () => NOW });
      expect(await client.requestAccess!(a.channelUrl)).toEqual({ kind: 'status', outcome: 'pending_owner' });
      const pending = (await inbox(a.w)).find(entry => entry.outcome === 'pending_owner')!;
      expect((await decide(a.w, pending.requestHandle, pending.revision, 'approve')).status).toBe(200);
      expect(await client.requestAccess!(a.channelUrl)).toEqual({ kind: 'status', outcome: 'connected' });

      // Each Codex session runs the same argv-less `mcp-serve` and names its thread on every call.
      const entry = async (thread: string, body: string) => {
        const stdin = new PassThrough();
        stdin.end(`${JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'tools/call',
          params: { _meta: { threadId: thread }, name: 'khala_send', arguments: { message: body } },
        })}\n`);
        const stdout = new PassThrough();
        let out = '';
        stdout.on('data', chunk => { out += String(chunk); });
        const stateDirectory = path.join(a.fixture.root, `entry-${thread}`);
        const code = await runCli(['mcp-serve'], {
          client: null as never,
          inbox: (bindingId, generation) => openInbox({
            stateDirectory, bindingId, generation, maxPayloadBytes: 64 * 1024, maxSelectionEvents: 32,
          }),
          stdin, stdout, stderr: new PassThrough(),
          sessionGrants: sessionGrants(a.fixture.root),
          internalClient: async descriptorPath => createInternalClient({ descriptorPath }),
          internalDelivery: async descriptorPath => createInternalDelivery({ descriptorPath, stateDirectory }),
        });
        expect(code).toBe(0);
        return JSON.parse(out) as { result: { structuredContent: { kind: string } } };
      };
      expect((await entry('session-second', 'from the second session')).result.structuredContent.kind).toBe('accepted');
      expect((await entry('session-local', 'from the first session')).result.structuredContent.kind).toBe('accepted');

      const timeline = await call(a.w.server.port, { path: `/api/v1/channels/${channelId}/timeline`, headers: a.w.human });
      const authors = Object.fromEntries((timeline.json.events as Array<{ content: { body: string }; participant: { participantId: string } }>)
        .map(event => [event.content.body, event.participant.participantId]));
      expect(authors['from the first session']).toBe(`participant_${a.agent.principal}`);
      expect(authors['from the second session']).toBe(`participant_${second.principal}`);
    });
  });

  describe('human-confirmed channel creation', () => {
    const channelCount = (w: World) => (w.handle.read(db => db.prepare('SELECT count(*) AS n FROM channels').get()) as { n: number }).n;
    const membersOf = (w: World, channel: string) => w.handle.read(db => db.prepare(
      'SELECT participant_id FROM memberships WHERE channel_id = ? ORDER BY participant_id',
    ).all(channel)) as Array<{ participant_id: string }>;
    const pendingCreate = async (w: World) => (await inbox(w)).find(entry => entry.operationKind === 'create' && entry.outcome === 'pending_owner')!;
    const createExchange = async (w: World, agent: Agent, operationId: string, recovery: Recovery, requester = agent) => {
      const body = await exchangeRequest(w, requester, operationId, `device_${operationId}`, recovery);
      const url = `${w.server.origin}/api/connector/channel-access-requests/${operationId}/exchange`;
      return { body, reply: await exchangeCall(w, agent, operationId, { ...body, requester: agent.principal }, proof(w, agent, url)) };
    };

    it('approval creates exactly one secret channel and admits only the requesting session', async () => {
      const w = await world();
      const agent = await issue(w, 'session-create');
      const other = await issue(w, 'session-other');
      const before = channelCount(w);
      expect((await requestCreate(w, agent, 'op-new', 'Agent proposal')).json.outcome).toBe('pending_owner');
      expect(channelCount(w)).toBe(before);

      const pending = await pendingCreate(w);
      const approved = await decide(w, pending.requestHandle, pending.revision, 'approve', w.human, 'create');
      expect(approved.status).toBe(200);
      expect(channelCount(w)).toBe(before + 1);
      const created = w.handle.read(db => db.prepare(
        "SELECT c.channel_id, c.title, v.visibility FROM channels c JOIN discovery_visibility v USING (channel_id) WHERE c.title = 'Agent proposal'",
      ).all()) as Array<{ channel_id: string; title: string; visibility: string }>;
      expect(created).toHaveLength(1);
      expect(created[0]!.visibility).toBe('secret');
      const channel = created[0]!.channel_id;
      // The human owns it; no agent is a member until the requester exchanges.
      expect(membersOf(w, channel)).toEqual([{ participant_id: alice.participantId }]);
      // Re-reading the inbox and retrying the decision never create a second channel.
      await inbox(w);
      await decide(w, pending.requestHandle, pending.revision, 'approve', w.human, 'create');
      expect(channelCount(w)).toBe(before + 1);

      // Another session cannot redeem this creation.
      const stolen = await createExchange(w, other, 'op-new', await recoveryKey());
      expect(stolen.reply.status).not.toBe(200);

      const recovery = await recoveryKey();
      const { body, reply } = await createExchange(w, agent, 'op-new', recovery);
      expect(reply.status).toBe(200);
      const activated = await activateCall(w, agent, 'op-new', { deviceId: body.deviceId, grant: openGrant(reply.json, recovery) });
      expect(activated.status).toBe(200);
      expect(activated.json.channelId).toBe(channel);
      expect(membersOf(w, channel).map(row => row.participant_id).sort())
        .toEqual([alice.participantId, `participant_${agent.principal}`].sort());
      const sent = await call(w.server.port, {
        method: 'POST', path: `/api/v1/channels/${channel}/messages`, headers: bearer(activated.json.capability),
        body: { clientTxnId: 'txn-created', content: { v: 1, kind: 'text', body: 'hello in the new channel' } },
      });
      expect(sent.status).toBe(201);
      expect((await call(w.server.port, { path: `/api/v1/channels/${channelId}/timeline`, headers: bearer(activated.json.capability) })).status).toBe(403);
      expect(channelCount(w)).toBe(before + 1);
    });

    it('denial creates nothing and the exchange stays closed', async () => {
      const w = await world();
      const agent = await issue(w, 'session-deny');
      const before = channelCount(w);
      expect((await requestCreate(w, agent, 'op-deny', 'Denied proposal')).json.outcome).toBe('pending_owner');
      const pending = await pendingCreate(w);
      const denied = await decide(w, pending.requestHandle, pending.revision, 'deny', w.human, 'create');
      expect([denied.status, denied.json.outcome]).toEqual([200, 'denied']);
      await inbox(w);
      const { reply } = await createExchange(w, agent, 'op-deny', await recoveryKey());
      expect(reply.status).not.toBe(200);
      expect(channelCount(w)).toBe(before);
    });

    it('reconciles a lost create response to the same channel', async () => {
      let lose = true;
      const w = await world(store => ({
        ...store,
        createSecretChannel(input) {
          const result = store.createSecretChannel(input);
          if (!lose) return result;
          // The channel commits, but its response never reaches the workflow.
          lose = false;
          return { kind: 'unavailable' };
        },
      }));
      const agent = await issue(w, 'session-lost');
      const before = channelCount(w);
      expect((await requestCreate(w, agent, 'op-lost', 'Lost response')).json.outcome).toBe('pending_owner');
      const pending = await pendingCreate(w);
      expect((await decide(w, pending.requestHandle, pending.revision, 'approve', w.human, 'create')).status).toBe(200);
      expect(lose).toBe(false);
      expect(channelCount(w)).toBe(before + 1);

      const recovery = await recoveryKey();
      const { body, reply } = await createExchange(w, agent, 'op-lost', recovery);
      expect(reply.status).toBe(200);
      const activated = await activateCall(w, agent, 'op-lost', { deviceId: body.deviceId, grant: openGrant(reply.json, recovery) });
      expect(activated.status).toBe(200);
      const created = w.handle.read(db => db.prepare("SELECT channel_id FROM channels WHERE title = 'Lost response'").all()) as Array<{ channel_id: string }>;
      expect(created).toHaveLength(1);
      expect(activated.json.channelId).toBe(created[0]!.channel_id);
      expect(channelCount(w)).toBe(before + 1);
    });
  });
});
