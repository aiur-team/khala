import { randomBytes } from 'node:crypto';
import { expect, it } from 'vitest';
import { effectiveState, openCredentials, sealCredentials, type JoinRecord } from './store';
const secret = 'invitation-secret-with-more-than-32-bytes';
const joinId = randomBytes(16).toString('base64url');
const credentials = { homeserver: 'https://matrix.example.test', userId: '@agent:matrix.test', accessToken: 'token', deviceId: 'DEVICE', roomId: '!room:matrix.test' };
it('seals credentials to the invitation secret and join ID', () => {
  const sealed = sealCredentials(secret, joinId, credentials);
  expect(openCredentials(secret, joinId, sealed)).toEqual(credentials);
  expect(openCredentials(secret, randomBytes(16).toString('base64url'), sealed)).toBeNull();
  expect(openCredentials('different-secret', joinId, sealed)).toBeNull();
  const parts = sealed.split('.');
  const ciphertext = Buffer.from(parts[2]!, 'base64url'); ciphertext[0] = ciphertext[0]! ^ 1;
  parts[2] = ciphertext.toString('base64url');
  expect(openCredentials(secret, joinId, parts.join('.'))).toBeNull();
});
it('logically expires only unclaimed joins at the exact boundary', () => {
  const record = { state: 'pending', expiresAt: new Date(600000).toISOString() } as JoinRecord;
  expect(effectiveState(record, 599999)).toBe('pending');
  expect(effectiveState(record, 600000)).toBe('expired');
  expect(effectiveState({ ...record, state: 'confirmed' }, 600000)).toBe('expired');
  for (const state of ['claimed', 'ready'] as const) expect(effectiveState({ ...record, state }, 999999)).toBe(state);
});

import { createControlStore, type BlobsStoreLike } from '../runtime/control-store';
import { consumeJoinBudget, createJoinStore, decodeJoinRecord, hashPollSecret, joinKey, JOIN_RETENTION_MS, pollSecretMatches, resolveJoinLink, toStored } from './store';
import { createDigests } from '../invitations/internal';
import type { ControlStore } from '@khala/contracts/messaging/index';
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
function fixture() {
  let now = Date.parse('2026-10-01T12:00:00.000Z');
  const clock = () => now;
  const blobs = durableStores();
  const store = createControlStore({ records: blobs.storeFor('records'), operations: blobs.storeFor('operations'), clock });
  const deps = { store, clock, random: randomBytes };
  const record: JoinRecord = { joinId, pollSecretHash: hashPollSecret('poll-secret'), roomId: '!room:matrix.test', channelName: 'Channel', label: 'Agent', harness: 'codex', state: 'pending', createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 600000).toISOString() };
  return { ...deps, joins: createJoinStore(deps), record, advance: (ms: number) => { now += ms; } };
}
it('strictly decodes records and strips undefined keys', () => {
  const { record } = fixture();
  expect(decodeJoinRecord(toStored({ ...record, ownerId: undefined } as unknown as JoinRecord))).toEqual(record);
  for (const patch of [{ extra: 1 }, { label: ' system ' }, { harness: 'unknown' }, { joinId: 'bad' }, { pollSecretHash: 'secret' }, { expiresAt: 'bad' }, { state: 'confirmed' }, { ownerId: 4 }]) expect(decodeJoinRecord({ ...record, ...patch })).toBeNull();
  expect(pollSecretMatches('poll-secret', record.pollSecretHash)).toBe(true);
  expect(pollSecretMatches('wrong', record.pollSecretHash)).toBe(false);
});
it('uses CAS revisions, unique operation IDs and 24-hour retention', async () => {
  const f = fixture();
  expect(await f.joins.create(f.record)).toBe('created');
  expect(await f.joins.create(f.record)).toBe('unavailable');
  const before = await f.store.read(joinKey(joinId));
  expect(before.kind).toBe('record'); if (before.kind !== 'record') throw Error();
  expect(before.record.expiresAt).toBe(new Date(Date.parse(f.record.createdAt) + JOIN_RETENTION_MS).toISOString());
  expect(before.record.operationId).toMatch(/^agent-join\.[A-Za-z0-9_-]{22}\.create\.[a-f0-9]{16}$/);
  const next = { ...f.record, state: 'expired' as const };
  expect((await f.joins.replace(joinId, before.record.revision, next, 'expire')).kind).toBe('applied');
  expect((await f.joins.replace(joinId, before.record.revision, next, 'expire')).kind).toBe('conflict');
  const after = await f.store.read(joinKey(joinId));
  if (after.kind !== 'record') throw Error();
  expect(after.record.operationId).not.toBe(before.record.operationId);
  expect(after.record.expiresAt).toBe(before.record.expiresAt);
  f.advance(600000); expect((await f.joins.read(joinId)).kind).toBe('found');
  f.advance(JOIN_RETENTION_MS); expect((await f.joins.read(joinId)).kind).toBe('absent');
});
it('reports corrupt values and preserves ambiguous writes', async () => {
  const f = fixture();
  await f.store.compareAndSet({ key: joinKey(joinId), expectedRevision: null, operationId: 'corrupt', next: { value: {}, expiresAt: null } });
  expect(await f.joins.read(joinId)).toEqual({ kind: 'unavailable' });
  const ambiguous: ControlStore = { ...f.store, compareAndSet: async input => ({ kind: 'outcome_unknown', operationId: input.operationId }), resolve: async input => ({ kind: 'outcome_unknown', operationId: input.operationId }) };
  expect(await createJoinStore({ ...f, store: ambiguous }).replace(joinId, 'revision', f.record, 'claim')).toEqual({ kind: 'unknown' });
  const mismatch: ControlStore = { ...f.store, compareAndSet: async () => ({ kind: 'operation_mismatch' }) };
  expect(await createJoinStore({ ...f, store: mismatch }).replace(joinId, 'revision', f.record, 'claim')).toEqual({ kind: 'unavailable' });
});
it('recovers a write proven applied by operation ID', async () => {
  const f = fixture();
  const recovered: ControlStore = { ...f.store, compareAndSet: async input => { await f.store.compareAndSet(input); return { kind: 'outcome_unknown', operationId: input.operationId }; } };
  expect(await createJoinStore({ ...f, store: recovered }).create(f.record)).toBe('created');
});
it('limits ten requests per IP and window, retaining counters for another minute', async () => {
  const f = fixture();
  for (let i = 0; i < 10; i++) expect(await consumeJoinBudget(f, 'ip')).toBe('allowed');
  expect(await consumeJoinBudget(f, 'ip')).toBe('limited');
  expect(await consumeJoinBudget(f, 'other')).toBe('allowed');
  const window = Math.floor(f.clock() / 600000);
  const read = await f.store.read(`agent-join-rate/${hashPollSecret('ip').slice(0, 32)}/${window}`);
  if (read.kind !== 'record') throw Error();
  expect(read.record.value).toEqual({ count: 10 });
  expect(read.record.expiresAt).toBe(new Date((window + 1) * 600000 + 60000).toISOString());
  f.advance(600000); expect(await consumeJoinBudget(f, 'ip')).toBe('allowed');
});
it('fails open on limiter outages and caps conflict retries', async () => {
  const f = fixture(); let writes = 0;
  const conflict: ControlStore = { ...f.store, compareAndSet: async () => { writes++; return { kind: 'conflict', current: null }; } };
  expect(await consumeJoinBudget({ ...f, store: conflict }, 'ip')).toBe('allowed'); expect(writes).toBe(4);
  const outage: ControlStore = { ...f.store, read: async () => { throw Error(); } };
  expect(await consumeJoinBudget({ ...f, store: outage }, 'ip')).toBe('allowed');
});
it('resolves active links without sponsor identity and rejects unavailable links', async () => {
  const f = fixture(); const origin = 'https://khala.test'; const ref = 'inv_abcdefgh'; const digests = createDigests(secret);
  const input = { ...f, origin, secret, link: `${origin}/join/${ref}` };
  expect(await resolveJoinLink({ ...input, link: 'bad' })).toEqual({ kind: 'invalid_link' });
  expect(await resolveJoinLink({ ...input, link: `https://other.test/join/${ref}` })).toEqual({ kind: 'invalid_link' });
  expect(await resolveJoinLink(input)).toEqual({ kind: 'link_unavailable' });
  const value = { v: 1, roomId: f.record.roomId, creatorOwnerId: 'owner', inviteRefDigest: digests.inviteRef(ref), policyRevision: 1, policy: { v: 1, kind: 'named_email', emailDigest: 'digest', history: 'none' }, status: 'active', expiresAt: new Date(f.clock() + 1000).toISOString(), lastAuthorizedOperationDigest: null };
  const write = await f.store.compareAndSet({ key: digests.inviteKey(ref), operationId: 'invite', expectedRevision: null, next: { value, expiresAt: null } });
  expect(await resolveJoinLink(input)).toEqual({ kind: 'ok', roomId: value.roomId, creatorOwnerId: 'owner' });
  f.advance(1000); expect(await resolveJoinLink(input)).toEqual({ kind: 'link_unavailable' });
  if (write.kind !== 'applied') throw Error();
  await f.store.compareAndSet({ key: digests.inviteKey(ref), operationId: 'bad-invite', expectedRevision: write.record.revision, next: { value: { ...value, inviteRefDigest: 'wrong' }, expiresAt: null } });
  expect(await resolveJoinLink(input)).toEqual({ kind: 'unavailable' });
});

it('cleans up a staged permanent claim after restart while preserving a different holder', async () => {
  for (const sameAgent of [true, false]) {
    const f = fixture();
    const staged = { ...f.record, label: 'Kevin-Codex', ownerId: 'owner', agentUserId: credentials.userId };
    expect(await f.joins.create(staged)).toBe('created');
    const key = 'names/v1/kevin-codex';
    expect((await f.store.compareAndSet({ key, expectedRevision: null, operationId: 'claim', next: {
      value: { v: 1, kind: 'agent', ownerId: 'owner', matrixUserId: sameAgent ? credentials.userId : '@other:matrix.test' }, expiresAt: null,
    } })).kind).toBe('applied');
    f.advance(600000);
    const restarted = createJoinStore(f);
    const read = await restarted.read(joinId);
    expect(read.kind === 'found' && read.record.state).toBe('expired');
    expect((await f.store.read(key)).kind).toBe(sameAgent ? 'absent' : 'record');
    expect((await restarted.read(joinId)).kind).toBe('found');
  }
});
