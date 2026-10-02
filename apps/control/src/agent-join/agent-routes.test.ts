import type { AgentJoinCreated, AgentJoinPoll } from '@khala/contracts/m1/agent-join';
import { randomBytes } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { ControlStore } from '@khala/contracts/messaging/index';
import { createControlStore, type BlobsStoreLike } from '../runtime/control-store';
import { createDigests } from '../invitations/internal';
import { createJoinStore, hashPollSecret, joinKey, sealCredentials, type JoinRecord } from './store';
import { createAgentJoinAgentHandlers } from './agent-routes';
const origin = 'https://khala.test';
const secret = 'invitation-secret-with-more-than-32-bytes';
const credentials = { homeserver: 'https://matrix.test', userId: '@agent:matrix.test', accessToken: 'token', deviceId: 'DEVICE', roomId: '!room:matrix.test' };
function durableStores() {
  const namespaces = new Map<string, Map<string, { data: unknown; etag: string }>>();
  let revision = 0;
  const storeFor = (name: string): BlobsStoreLike => {
    let records = namespaces.get(name);
    if (!records) { records = new Map(); namespaces.set(name, records); }
    const backing = records;
    return {
      async getWithMetadata(key) { return backing.get(key) ?? null; },
      async setJSON(key, data, options) {
        const current = backing.get(key);
        if (options?.onlyIfNew && current) return { modified: false, etag: current.etag };
        if (options?.onlyIfMatch && current?.etag !== options.onlyIfMatch) return { modified: false, ...(current ? { etag: current.etag } : {}) };
        const etag = String(++revision);
        backing.set(key, { data: structuredClone(data), etag });
        return { modified: true, etag };
      },
    };
  };
  return { storeFor };
}
async function fixture(state: JoinRecord['state'] = 'pending') {
  let now = Date.parse('2026-10-01T12:00:00.000Z'); const clock = () => now;
  const blobs = durableStores();
  const store = createControlStore({ records: blobs.storeFor('records'), operations: blobs.storeFor('operations'), clock });
  const joins = createJoinStore({ store, clock, random: randomBytes });
  const joinId = randomBytes(16).toString('base64url'), pollSecret = randomBytes(32).toString('base64url');
  const record: JoinRecord = { joinId, pollSecretHash: hashPollSecret(pollSecret), roomId: credentials.roomId, channelName: 'Channel', label: 'Agent', harness: 'claude', state, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 600000).toISOString(),
    ...(state === 'confirmed' ? { ownerId: 'owner', agentUserId: credentials.userId, sealedCredentials: sealCredentials(secret, joinId, credentials) } : {}) };
  expect(await joins.create(record)).toBe('created');
  const ref = 'inv_abcdefgh', digests = createDigests(secret);
  await store.compareAndSet({ key: digests.inviteKey(ref), expectedRevision: null, operationId: 'invite', next: { value: { v: 1, roomId: credentials.roomId, creatorOwnerId: 'owner', inviteRefDigest: digests.inviteRef(ref), policyRevision: 1, policy: { v: 1, kind: 'link', history: 'none' }, status: 'active', expiresAt: null, lastAuthorizedOperationDigest: null }, expiresAt: null } });
  const deps = { store, clock, random: randomBytes, joins, origin, secret, roomName: vi.fn(async () => 'Channel') };
  const request = (method = 'GET', query = `joinId=${joinId}`, bearer: string | null = `Bearer ${pollSecret}`) => new Request(`${origin}/api/agent/join/poll?${query}`, { method, headers: bearer === null ? {} : { authorization: bearer } });
  const createRequest = (body: unknown = { link: `${origin}/join/${ref}`, harness: 'codex', label: ' Agent ' }, contentType = 'application/json') => new Request(`${origin}/api/agent/join`, { method: 'POST', headers: { 'content-type': contentType }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { deps, joins, store, record, joinId, pollSecret, request, createRequest, handlers: createAgentJoinAgentHandlers(deps), advance: (ms: number) => { now += ms; } };
}
it('creates normalized pending joins without persisting poll secrets', async () => {
  const f = await fixture(); const response = await f.handlers.create(f.createRequest());
  expect(response.status).toBe(201);
  const result = await response.json() as AgentJoinCreated;
  expect(result.joinId).toMatch(/^[A-Za-z0-9_-]{22}$/); expect(result.pollSecret).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(result.confirmUrl).toBe(`${origin}/agent/confirm?joinId=${result.joinId}`);
  const read = await f.joins.read(result.joinId); if (read.kind !== 'found') throw Error();
  expect(read.record.label).toBe('Agent'); expect(read.record.channelName).toBe('Channel'); expect(read.record.pollSecretHash).toBe(hashPollSecret(result.pollSecret));
  expect(JSON.stringify(read.record)).not.toContain(result.pollSecret);
  expect(f.deps.roomName).toHaveBeenCalledWith('owner', credentials.roomId);
  expect(response.headers.get('cache-control')).toBe('no-store'); expect(response.headers.get('x-content-type-options')).toBe('nosniff'); expect(response.headers.get('content-type')).toBe('application/json');
});
it('validates methods and request fields in contract order', async () => {
  const f = await fixture();
  expect((await f.handlers.create(new Request(origin))).status).toBe(405);
  const cases: [unknown, string][] = [[{}, 'invalid_link'], [{ link: 'bad', harness: 'other', label: '' }, 'invalid_harness'], [{ link: 'bad', harness: 'claude', label: 'system' }, 'invalid_label'], [{ link: 'bad', harness: 'claude', label: 'x'.repeat(41) }, 'invalid_label'], [{ link: 'bad', harness: 'claude', label: 'Agent' }, 'invalid_link'], [{ link: `${origin}/join/inv_absent`, harness: 'claude', label: 'Agent' }, 'link_unavailable']];
  for (const [body, code] of cases) expect(await (await f.handlers.create(f.createRequest(body))).json()).toEqual({ error: code });
  expect((await f.handlers.create(f.createRequest('{'))).status).toBe(400);
  expect((await f.handlers.create(f.createRequest({}, 'text/plain'))).status).toBe(400);
  expect((await f.handlers.poll(f.request('POST'))).status).toBe(405);
  expect((await f.handlers.ready(f.request())) .status).toBe(405);
});
it('uses the same 404 for malformed, absent and unauthorized joins', async () => {
  const f = await fixture();
  const requests = [f.request('GET', ''), f.request('GET', `joinId=${f.joinId}&joinId=${f.joinId}`), f.request('GET', `joinId=${f.joinId}&extra=x`), f.request('GET', 'joinId=bad'), f.request('GET', `joinId=${randomBytes(16).toString('base64url')}`), f.request('GET', undefined, null), f.request('GET', undefined, 'Bearer wrong'), f.request('GET', undefined, `bearer ${f.pollSecret}`), f.request('GET', undefined, `Bearer ${f.pollSecret} extra`)];
  for (const request of requests) { const response = await f.handlers.poll(request); expect(response.status).toBe(404); expect(await response.json()).toEqual({ error: 'not_found' }); }
  expect((await f.handlers.ready(f.request('POST', 'joinId=bad'))).status).toBe(404);
});
it('reports logical expiry without writing and preserves claimed states', async () => {
  for (const state of ['pending', 'confirmed', 'claimed', 'ready'] as const) {
    const f = await fixture(state); const before = await f.store.read(joinKey(f.joinId)); f.advance(600000);
    expect(await (await f.handlers.poll(f.request())).json()).toEqual({ state: state === 'claimed' || state === 'ready' ? 'claimed' : 'expired' });
    expect(await f.store.read(joinKey(f.joinId))).toEqual(before);
  }
});
it('releases credentials to exactly one concurrent poll and removes ciphertext', async () => {
  const f = await fixture('confirmed');
  const responses = await Promise.all(Array.from({ length: 6 }, () => f.handlers.poll(f.request())));
  const bodies = await Promise.all(responses.map(async response => await response.json() as AgentJoinPoll));
  expect(bodies.filter(body => body.state === 'confirmed')).toEqual([{ state: 'confirmed', credentials }]);
  expect(bodies.filter(body => body.state === 'claimed')).toHaveLength(5);
  const read = await f.joins.read(f.joinId); if (read.kind !== 'found') throw Error();
  expect(read.record.state).toBe('claimed'); expect(read.record).not.toHaveProperty('sealedCredentials');
  expect(await (await f.handlers.poll(f.request())).json()).toEqual({ state: 'claimed' });
});
it('ready is idempotent under concurrency and cannot bypass claiming', async () => {
  for (const state of ['pending', 'confirmed', 'expired'] as const) {
    const f = await fixture(state); const response = await f.handlers.ready(f.request('POST'));
    expect(response.status).toBe(409); expect(await response.json()).toEqual({ error: 'not_confirmed' });
  }
  const f = await fixture('claimed');
  const responses = await Promise.all([f.handlers.ready(f.request('POST')), f.handlers.ready(f.request('POST'))]);
  for (const response of responses) { expect(response.status).toBe(204); expect(await response.text()).toBe(''); expect(response.headers.get('cache-control')).toBe('no-store'); }
  expect((await f.handlers.ready(f.request('POST'))).status).toBe(204);
});
it('never releases credentials on unknown writes or unresolved conflicts', async () => {
  const f = await fixture('confirmed');
  for (const kind of ['unknown', 'unavailable', 'conflict'] as const) {
    const handlers = createAgentJoinAgentHandlers({ ...f.deps, joins: { ...f.joins, replace: async () => ({ kind }) } });
    const response = await handlers.poll(f.request()); expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: 'unavailable' });
  }
  const broken = { ...f.record, sealedCredentials: 'v1.broken' };
  const handlers = createAgentJoinAgentHandlers({ ...f.deps, joins: { ...f.joins, read: async () => ({ kind: 'found', record: broken, revision: '1' }) } });
  expect((await handlers.poll(f.request())).status).toBe(503);
});
it('returns unavailable for exceptions and creation failures', async () => {
  const f = await fixture();
  const throwing = createAgentJoinAgentHandlers({ ...f.deps, roomName: async () => { throw Error(); } });
  expect((await throwing.create(f.createRequest())).status).toBe(503);
  const failed = createAgentJoinAgentHandlers({ ...f.deps, joins: { ...f.joins, create: async () => 'unavailable' } });
  expect((await failed.create(f.createRequest())).status).toBe(503);
  const unavailable: ControlStore = { ...f.store, read: async () => ({ kind: 'unavailable' }) };
  const outage = createAgentJoinAgentHandlers({ ...f.deps, store: unavailable });
  expect((await outage.create(f.createRequest())).status).toBe(503);
});
it('limits creates before parsing their bodies', async () => {
  const f = await fixture();
  for (let i = 0; i < 10; i++) expect((await f.handlers.create(f.createRequest('{'))).status).toBe(400);
  const response = await f.handlers.create(f.createRequest()); expect(response.status).toBe(429); expect(await response.json()).toEqual({ error: 'rate_limited' });
});
