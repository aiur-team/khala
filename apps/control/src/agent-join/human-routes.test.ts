import { randomBytes } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { nameKey, ownerAgentsKey } from '@khala/contracts/m1/names';
import { profileRecordKey } from '@khala/contracts/m1/profile';
import { agentOwnerRecordKey } from '@khala/contracts/m1/participants';
import type { AuthPrincipal, OwnerId } from '@khala/contracts/messaging/index';
import type { Authentication, MutationAuthorization } from '../auth/index';
import type { GatewayInspection } from '../invitations/index';
import { createControlStore } from '../runtime/control-store';
import { createJoinStore, hashPollSecret, openCredentials, type JoinRecord } from './store';
import { agentIdentity, type AgentProvisioner } from './provision';
import { renameAgent } from './rename';
import { createAgentJoinHumanHandlers } from './human-routes';
import { durableStores } from './testing/store';
const secret = 'invitation-secret-with-more-than-32-bytes';
const credentials = { homeserver: 'https://matrix.test', userId: '@agent:matrix.test', accessToken: 'token', deviceId: 'DEVICE', roomId: '!room:matrix.test' };

async function fixture(options: { username?: string; harness?: 'claude' | 'codex'; email?: string } = {}) {
  let now = Date.parse('2026-10-01T12:00:00.000Z'); const clock = () => now;
  const blobs = durableStores();
  const store = createControlStore({ records: blobs.storeFor('records'), operations: blobs.storeFor('operations'), clock });
  const joins = createJoinStore({ store, clock, random: randomBytes });
  const joinId = randomBytes(16).toString('base64url');
  const record: JoinRecord = { joinId, pollSecretHash: hashPollSecret('poll'), roomId: credentials.roomId, channelName: 'Channel', label: 'Claude', harness: options.harness ?? 'claude', state: 'pending', createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 600000).toISOString() };
  expect(await joins.create(record)).toBe('created');
  let ownerId = 'owner' as OwnerId;
  const principal = () => ({ ownerId, verifiedEmail: options.email ?? 'maya99@x' } as AuthPrincipal);
  if (options.username) await store.compareAndSet({ key: profileRecordKey(ownerId), expectedRevision: null, operationId: 'profile',
    next: { value: { v: 1, ownerId, username: options.username, updatedAt: new Date(now).toISOString() }, expiresAt: null } });
  const auth = {
    authenticateRequest: vi.fn(async (): Promise<Authentication> => ({ kind: 'authenticated', context: { principal: principal(), csrfToken: 'csrf' } })),
    requireHumanMutation: vi.fn(async (): Promise<MutationAuthorization> => ({ kind: 'authorized', context: { principal: principal(), csrfToken: 'csrf' } })),
  };
  const deps = { auth, joins, store, clock, random: randomBytes, sealSecret: secret,
    inspectMembership: vi.fn(async (): Promise<GatewayInspection> => ({ kind: 'joined', historyReady: true })),
    provisioner: { setDisplayName: vi.fn(async () => true), agentUserId: vi.fn<AgentProvisioner['agentUserId']>(() => credentials.userId), provision: vi.fn<AgentProvisioner['provision']>(async () => ({ kind: 'ok' as const, credentials })) },
  };
  const request = (method = 'GET', query = `joinId=${joinId}`) => new Request(`https://khala.test/api/human/agent-join?${query}`, { method });
  return { deps, joins, store, record, joinId, request, handlers: createAgentJoinHumanHandlers(deps), advance: () => { now += 600000; }, owner: (id: string) => { ownerId = id as OwnerId; } };
}
it('confirms, seals credentials and creates a permanent owner map through the real store', async () => {
  const f = await fixture();
  expect((await f.handlers.view(f.request())).status).toBe(200);
  const response = await f.handlers.confirm(f.request('POST'));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ joinId: f.joinId, label: 'Maya-Claude', harness: 'claude', channelName: 'Channel', roomId: credentials.roomId, state: 'confirmed', agentUserId: credentials.userId });
  const read = await f.joins.read(f.joinId); if (read.kind !== 'found') throw Error();
  expect(read.record.ownerId).toBe('owner');
  expect(openCredentials(secret, f.joinId, read.record.sealedCredentials!)).toEqual(credentials);
  const map = await f.store.read(agentOwnerRecordKey(credentials.userId)); if (map.kind !== 'record') throw Error();
  expect(map.record.value).toEqual({ matrixUserId: credentials.userId, ownerId: 'owner', ownerLabel: 'Maya', harness: 'claude', label: 'Maya-Claude', createdAt: f.record.createdAt });
  expect(map.record.expiresAt).toBeNull(); expect(map.record.operationId).toMatch(/^agents\.[a-f0-9]{64}\.create\.[a-f0-9]{16}$/);
  expect((await f.handlers.confirm(f.request('POST'))).status).toBe(200);
  expect(f.deps.provisioner.provision).toHaveBeenCalledTimes(1);
  f.owner('other'); expect((await f.handlers.confirm(f.request('POST'))).status).toBe(409);
  expect(response.headers.get('cache-control')).toBe('no-store');
});
it('retains the owner lock on failure and lets only that owner retry', async () => {
  const f = await fixture(); f.deps.provisioner.provision.mockRejectedValueOnce(Error('offline'));
  expect((await f.handlers.confirm(f.request('POST'))).status).toBe(503);
  const read = await f.joins.read(f.joinId); expect(read.kind === 'found' && read.record.ownerId).toBe('owner');
  f.owner('other'); expect((await f.handlers.confirm(f.request('POST'))).status).toBe(409);
  f.owner('owner'); expect((await f.handlers.confirm(f.request('POST'))).status).toBe(200);
});
it('handles concurrent same-owner confirmations and owner-map conflicts', async () => {
  const f = await fixture();
  const responses = await Promise.all([f.handlers.confirm(f.request('POST')), f.handlers.confirm(f.request('POST'))]);
  expect(responses.map(r => r.status)).toEqual([200, 200]);
  const g = await fixture();
  await g.store.compareAndSet({ key: agentOwnerRecordKey(credentials.userId), expectedRevision: null, operationId: 'other', next: { value: { ownerId: 'other' }, expiresAt: null } });
  expect((await g.handlers.confirm(g.request('POST'))).status).toBe(503);
});
it('checks authorization before looking up joins and maps auth rejections', async () => {
  for (const code of ['signed_out', 'csrf_mismatch', 'forbidden_origin'] as const) {
    const f = await fixture(); f.deps.auth.requireHumanMutation.mockResolvedValue({ kind: 'rejected', code });
    const response = await f.handlers.confirm(f.request('POST', 'joinId=bad'));
    expect(response.status).toBe(code === 'signed_out' ? 401 : 403); expect(await response.json()).toEqual({ error: code });
    expect(f.deps.inspectMembership).not.toHaveBeenCalled();
  }
  const f = await fixture(); f.deps.auth.authenticateRequest.mockResolvedValue({ kind: 'signed_out' });
  expect((await f.handlers.status(f.request())).status).toBe(401);
  f.deps.auth.authenticateRequest.mockResolvedValue({ kind: 'unavailable' }); expect((await f.handlers.view(f.request())).status).toBe(503);
});
it('enforces methods, exact query parameters, membership and expiry', async () => {
  const f = await fixture();
  expect((await f.handlers.view(f.request('POST'))).status).toBe(405);
  expect((await f.handlers.confirm(f.request())).status).toBe(405);
  for (const query of ['', 'joinId=bad', `joinId=${f.joinId}&extra=x`, `joinId=${f.joinId}&joinId=${f.joinId}`, 'joinId=aaaaaaaaaaaaaaaaaaaaaa']) expect((await f.handlers.view(f.request('GET', query))).status).toBe(404);
  f.deps.inspectMembership.mockResolvedValue({ kind: 'absent' }); expect((await f.handlers.confirm(f.request('POST'))).status).toBe(403);
  f.deps.inspectMembership.mockResolvedValue({ kind: 'unavailable' }); expect((await f.handlers.status(f.request())).status).toBe(503);
  f.deps.inspectMembership.mockResolvedValue({ kind: 'joined', historyReady: true }); f.advance();
  expect(await (await f.handlers.view(f.request())).json()).toMatchObject({ state: 'expired' });
  expect((await f.handlers.confirm(f.request('POST'))).status).toBe(404);
});
it('maps claimed to confirmed and keeps ready visible after expiry', async () => {
  for (const state of ['claimed', 'ready'] as const) {
    const f = await fixture(); const read = await f.joins.read(f.joinId); if (read.kind !== 'found') throw Error();
    await f.joins.replace(f.joinId, read.revision, { ...read.record, state, ownerId: 'owner', agentUserId: credentials.userId }, 'test'); f.advance();
    expect(await (await f.handlers.status(f.request())).json()).toMatchObject({ state: state === 'claimed' ? 'confirmed' : 'ready', agentUserId: credentials.userId });
    expect((await f.handlers.confirm(f.request('POST'))).status).toBe(200);
    expect(f.deps.provisioner.provision).not.toHaveBeenCalled();
  }
});
it('fails closed on store and thrown membership failures', async () => {
  const f = await fixture(); vi.spyOn(f.deps.joins, 'read').mockResolvedValue({ kind: 'unavailable' });
  expect((await f.handlers.view(f.request())).status).toBe(503);
  const g = await fixture(); g.deps.inspectMembership.mockRejectedValue(Error('offline'));
  expect((await g.handlers.confirm(g.request('POST'))).status).toBe(503);
});

it('bounds owner-lock conflicts without provisioning', async () => {
  const f = await fixture(); vi.spyOn(f.joins, 'replace').mockResolvedValue({ kind: 'conflict' });
  expect((await f.handlers.confirm(f.request('POST'))).status).toBe(503);
  expect(f.joins.replace).toHaveBeenCalledTimes(2); expect(f.deps.provisioner.provision).not.toHaveBeenCalled();
});
it('rechecks the winning owner after an owner-lock conflict', async () => {
  const f = await fixture(); const replace = f.joins.replace;
  vi.spyOn(f.joins, 'replace').mockImplementationOnce(async (id, revision, record) => {
    await replace(id, revision, { ...record, ownerId: 'other' }, 'winner'); return { kind: 'conflict' };
  });
  expect((await f.handlers.confirm(f.request('POST'))).status).toBe(409);
  expect(f.deps.provisioner.provision).not.toHaveBeenCalled();
});
it('keeps an owner-map write retryable if the final join write fails', async () => {
  const f = await fixture(); const replace = f.joins.replace;
  vi.spyOn(f.joins, 'replace').mockImplementation(async (...args) => args[3] === 'confirm' ? { kind: 'unavailable' } : replace(...args));
  expect((await f.handlers.confirm(f.request('POST'))).status).toBe(503);
  vi.mocked(f.joins.replace).mockImplementation(replace);
  expect((await f.handlers.confirm(f.request('POST'))).status).toBe(200);
});
it('fails closed on an unresolved final confirmation conflict', async () => {
  const f = await fixture(); const replace = f.joins.replace;
  vi.spyOn(f.joins, 'replace').mockImplementation(async (...args) => args[3] === 'confirm' ? { kind: 'conflict' } : replace(...args));
  expect((await f.handlers.confirm(f.request('POST'))).status).toBe(503);
});

it('shows expired confirmed records with identity and refuses confirmation', async () => {
  const f = await fixture(); await f.handlers.confirm(f.request('POST')); f.advance();
  expect(await (await f.handlers.status(f.request())).json()).toMatchObject({ state: 'expired', agentUserId: credentials.userId });
  expect((await f.handlers.confirm(f.request('POST'))).status).toBe(404);
});

it('assigns the profile-based name, previews it and persists the reservation and owner index', async () => {
  const f = await fixture({ username: 'Kevin', harness: 'codex' });
  for (const handler of [f.handlers.view, f.handlers.status]) {
    expect(await (await handler(f.request())).json()).toMatchObject({ state: 'pending', label: 'Kevin-Codex' });
  }
  const confirmed = await f.handlers.confirm(f.request('POST'));
  expect(confirmed.status).toBe(200);
  expect(await confirmed.json()).toMatchObject({ label: 'Kevin-Codex', state: 'confirmed' });
  expect(f.deps.provisioner.provision).toHaveBeenCalledWith({ joinId: f.joinId, ownerId: 'owner', label: 'Kevin-Codex', roomId: credentials.roomId });
  const owner = await f.store.read(agentOwnerRecordKey(credentials.userId));
  expect(owner.kind === 'record' && owner.record.value).toMatchObject({ label: 'Kevin-Codex', ownerLabel: 'Kevin' });
  const reservation = await f.store.read(nameKey('Kevin-Codex'));
  expect(reservation.kind === 'record' && reservation.record.value).toEqual({ v: 1, kind: 'agent', ownerId: 'owner', matrixUserId: credentials.userId });
  const index = await f.store.read(ownerAgentsKey('owner'));
  expect(index.kind === 'record' && index.record.value).toEqual({ v: 1, ownerId: 'owner', agents: [credentials.userId] });
  expect((await f.handlers.confirm(f.request('POST'))).status).toBe(200);
  expect(await f.store.read(nameKey('Kevin-Codex-2'))).toEqual({ kind: 'absent' });
  expect(f.deps.provisioner.provision).toHaveBeenCalledTimes(1);
});
it('uses the email suggestion without reserving a username when there is no profile', async () => {
  const f = await fixture({ harness: 'codex', email: 'kevin.weaver2@x' });
  expect(await (await f.handlers.view(f.request())).json()).toMatchObject({ label: 'Kevin-Codex' });
  expect(await (await f.handlers.confirm(f.request('POST'))).json()).toMatchObject({ label: 'Kevin-Codex' });
  expect(await f.store.read(nameKey('Kevin'))).toEqual({ kind: 'absent' });
});
it('reuses the reservation after provisioning fails and does not append the index twice', async () => {
  const f = await fixture({ username: 'Kevin', harness: 'codex' });
  f.deps.provisioner.provision.mockRejectedValueOnce(Error('offline'));
  expect((await f.handlers.confirm(f.request('POST'))).status).toBe(503);
  expect(await (await f.handlers.confirm(f.request('POST'))).json()).toMatchObject({ label: 'Kevin-Codex' });
  expect(await f.store.read(nameKey('Kevin-Codex-2'))).toEqual({ kind: 'absent' });
  const index = await f.store.read(ownerAgentsKey('owner'));
  expect(index.kind === 'record' && index.record.value).toMatchObject({ agents: [credentials.userId] });
});
it('fails closed when the profile or name namespace is unavailable', async () => {
  for (const prefix of ['profiles/', 'names/']) {
    const f = await fixture(); const read = f.store.read, write = f.store.compareAndSet;
    vi.spyOn(f.store, 'read').mockImplementation((key, ...args) => key.startsWith(prefix) ? Promise.resolve({ kind: 'unavailable' }) : read(key, ...args));
    vi.spyOn(f.store, 'compareAndSet').mockImplementation((input, ...args) => input.key.startsWith(prefix) ? Promise.resolve({ kind: 'unavailable' }) : write(input, ...args));
    expect((await f.handlers.confirm(f.request('POST'))).status).toBe(503);
    expect(f.deps.provisioner.provision).not.toHaveBeenCalled();
  }
});
it('does not fail confirmation when the owner index is unavailable', async () => {
  const f = await fixture(); const read = f.store.read;
  vi.spyOn(f.store, 'read').mockImplementation((key, ...args) => key.startsWith('owner-agents/') ? Promise.reject(Error('offline')) : read(key, ...args));
  expect((await f.handlers.confirm(f.request('POST'))).status).toBe(200);
});

it('expires a name reserved by a join that never confirms', async () => {
  const f = await fixture({ username: 'Kevin' });
  f.deps.provisioner.provision.mockResolvedValue({ kind: 'unavailable' } as never);
  expect((await f.handlers.confirm(f.request('POST'))).status).toBe(503);
  const claim = await f.store.read(nameKey('Kevin-Claude'));
  expect(claim.kind === 'record' && claim.record.expiresAt).toBe(f.record.expiresAt);
  f.advance();
  expect(await f.store.read(nameKey('Kevin-Claude'))).toEqual({ kind: 'absent' });
});
it('expires a pending name when the final confirmation write never succeeds', async () => {
  const f = await fixture({ username: 'Kevin' });
  const replace = f.joins.replace;
  vi.spyOn(f.joins, 'replace').mockImplementation(async (...args) => args[3] === 'confirm' ? { kind: 'unavailable' } : replace(...args));
  expect((await f.handlers.confirm(f.request('POST'))).status).toBe(503);
  expect(await f.store.read(ownerAgentsKey('owner'))).toEqual({ kind: 'absent' });
  f.advance();
  await f.joins.read(f.joinId);
  expect(await f.store.read(nameKey('Kevin-Claude'))).toEqual({ kind: 'absent' });
});
it('makes a confirmed name permanent even after the join deadline', async () => {
  const f = await fixture({ username: 'Kevin' });
  expect((await f.handlers.confirm(f.request('POST'))).status).toBe(200);
  f.advance();
  const claim = await f.store.read(nameKey('Kevin-Claude'));
  expect(claim.kind === 'record' && claim.record.expiresAt).toBeNull();
});

it('does not publish confirmation or credentials when name promotion fails', async () => {
  const f = await fixture({ username: 'Kevin' }); const write = f.store.compareAndSet;
  vi.spyOn(f.store, 'compareAndSet').mockImplementation((input, options) => input.key === nameKey('Kevin-Claude') && input.expectedRevision !== null && input.next.expiresAt === null
    ? Promise.resolve({ kind: 'unavailable' }) : write(input, options));
  expect((await f.handlers.confirm(f.request('POST'))).status).toBe(503);
  const read = await f.joins.read(f.joinId);
  expect(read.kind === 'found' && read.record).toMatchObject({ state: 'pending', label: 'Kevin-Claude', agentUserId: credentials.userId });
  expect(read.kind === 'found' && read.record.sealedCredentials).toBeUndefined();
});
it('releases a promoted name when an unconfirmed staged join expires', async () => {
  const f = await fixture({ username: 'Kevin' }); const replace = f.joins.replace;
  vi.spyOn(f.joins, 'replace').mockImplementation((...args) => args[3] === 'confirm' ? Promise.resolve({ kind: 'unavailable' }) : replace(...args));
  expect((await f.handlers.confirm(f.request('POST'))).status).toBe(503);
  const claim = await f.store.read(nameKey('Kevin-Claude'));
  expect(claim.kind === 'record' && claim.record.expiresAt).toBeNull();
  f.advance();
  expect(await (await f.handlers.status(f.request())).json()).toMatchObject({ state: 'expired' });
  expect(await f.store.read(nameKey('Kevin-Claude'))).toEqual({ kind: 'absent' });
  const expired = await f.joins.read(f.joinId);
  expect(expired.kind === 'found' && expired.record.sealedCredentials).toBeUndefined();
});
it('refuses confirmation if provisioning crosses the join deadline', async () => {
  const f = await fixture({ username: 'Kevin' });
  f.deps.provisioner.provision.mockImplementationOnce(async () => { f.advance(); return { kind: 'ok', credentials }; });
  expect((await f.handlers.confirm(f.request('POST'))).status).toBe(404);
  expect(await f.store.read(nameKey('Kevin-Claude'))).toEqual({ kind: 'absent' });
});
it('keeps confirmed reservations permanent when the unclaimed join expires', async () => {
  const f = await fixture({ username: 'Kevin' });
  expect((await f.handlers.confirm(f.request('POST'))).status).toBe(200);
  f.advance(); await f.joins.read(f.joinId);
  expect((await f.store.read(nameKey('Kevin-Claude'))).kind).toBe('record');
});

it('keeps one hosted identity and its rename across fresh join requests for the same session', async () => {
  const f = await fixture({ username: 'Kevin', harness: 'codex' });
  const initial = await f.joins.read(f.joinId);
  if (initial.kind !== 'found') throw Error();
  await f.joins.replace(f.joinId, initial.revision, { ...initial.record, sessionId: 'thread-1', rejoinSecretHash: hashPollSecret('S'.repeat(43)) }, 'session');
  expect((await f.handlers.confirm(f.request('POST'))).status).toBe(200);
  const identityId = f.deps.provisioner.agentUserId.mock.calls[0]![0];
  expect(identityId).toMatch(/^session\.[a-f0-9]{64}$/);
  expect(await renameAgent(f.deps, 'owner' as OwnerId, credentials.userId, 'Reviewer')).toBe('ok');
  const nextId = randomBytes(16).toString('base64url');
  await f.joins.create({ ...f.record, joinId: nextId, sessionId: 'thread-1', rejoinSecretHash: hashPollSecret('S'.repeat(43)) });
  const rejoined = await f.handlers.confirm(f.request('POST', `joinId=${nextId}`));
  expect(rejoined.status).toBe(200);
  expect(await rejoined.json()).toMatchObject({ label: 'Reviewer', agentUserId: credentials.userId });
  expect(f.deps.provisioner.agentUserId.mock.calls.at(-1)![0]).toBe(identityId);
  expect(f.deps.provisioner.provision).toHaveBeenLastCalledWith({ joinId: nextId, identityId, ownerId: 'owner', label: 'Reviewer', roomId: credentials.roomId });
  expect(await f.store.read(nameKey('Kevin-Codex-2'))).toEqual({ kind: 'absent' });
});

it('recovers a stable account after a failed initial confirmation expires', async () => {
  const f = await fixture({ username: 'Kevin', harness: 'codex' });
  const first = await f.joins.read(f.joinId);
  if (first.kind !== 'found') throw Error();
  await f.joins.replace(f.joinId, first.revision, { ...first.record, sessionId: 'thread-1', rejoinSecretHash: hashPollSecret('S'.repeat(43)) }, 'session');
  const replace = f.joins.replace;
  const failure = vi.spyOn(f.joins, 'replace').mockImplementation(async (...args) => args[3] === 'confirm' ? { kind: 'unavailable' } : replace(...args));
  expect((await f.handlers.confirm(f.request('POST'))).status).toBe(503);
  failure.mockRestore();
  f.advance();
  await f.joins.read(f.joinId);
  const now = f.deps.clock();
  const nextId = randomBytes(16).toString('base64url');
  await f.joins.create({ ...f.record, joinId: nextId, sessionId: 'thread-1', rejoinSecretHash: hashPollSecret('S'.repeat(43)), createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 600000).toISOString() });
  expect((await f.handlers.confirm(f.request('POST', `joinId=${nextId}`))).status).toBe(200);
  expect(await f.store.read(nameKey('Kevin-Codex-2'))).toEqual({ kind: 'absent' });
});

it('allocates the suffix only for a different hosted session', async () => {
  const f = await fixture({ username: 'Kevin', harness: 'codex' });
  f.deps.provisioner.agentUserId.mockImplementation((identityId, ownerId) => agentIdentity(identityId, ownerId, 'matrix.test', secret).userId);
  f.deps.provisioner.provision.mockImplementation(async input => ({ kind: 'ok', credentials: {
    ...credentials, userId: f.deps.provisioner.agentUserId(input.identityId ?? input.joinId, input.ownerId),
  } }));
  const members: string[] = [];
  for (const sessionId of ['thread-1', 'thread-1', 'thread-2']) {
    const joinId = randomBytes(16).toString('base64url');
    await f.joins.create({ ...f.record, joinId, sessionId, rejoinSecretHash: hashPollSecret('S'.repeat(43)) });
    const response = await f.handlers.confirm(f.request('POST', `joinId=${joinId}`));
    expect(response.status).toBe(200);
    const view = await response.json() as { label: string; agentUserId: string };
    expect(view.label).toBe(sessionId === 'thread-1' ? 'Kevin-Codex' : 'Kevin-Codex-2');
    members.push(view.agentUserId);
  }
  expect(members[0]).toBe(members[1]);
  expect(members[2]).not.toBe(members[0]);
});

it('keeps sibling hosted agents separate when a session id is asserted without its secret', async () => {
  const f = await fixture({ username: 'Kevin', harness: 'codex' });
  f.deps.provisioner.agentUserId.mockImplementation((identityId, ownerId) => agentIdentity(identityId, ownerId, 'matrix.test', secret).userId);
  f.deps.provisioner.provision.mockImplementation(async input => ({ kind: 'ok', credentials: {
    ...credentials, userId: f.deps.provisioner.agentUserId(input.identityId ?? input.joinId, input.ownerId),
  } }));
  const members: string[] = [];
  const names: string[] = [];
  for (const rejoinSecretHash of [hashPollSecret('S'.repeat(43)), hashPollSecret('X'.repeat(43)), undefined, hashPollSecret('S'.repeat(43))]) {
    const joinId = randomBytes(16).toString('base64url');
    await f.joins.create({ ...f.record, joinId, sessionId: 'thread-1', ...(rejoinSecretHash ? { rejoinSecretHash } : {}) });
    const response = await f.handlers.confirm(f.request('POST', `joinId=${joinId}`));
    expect(response.status).toBe(200);
    const view = await response.json() as { label: string; agentUserId: string };
    members.push(view.agentUserId); names.push(view.label);
  }
  expect(new Set(members)).toHaveProperty('size', 3);
  expect(members[0]).toBe(members[3]);
  expect(names).toEqual(['Kevin-Codex', 'Kevin-Codex-2', 'Kevin-Codex-3', 'Kevin-Codex']);
});

it('never reuses a hosted identity for a session id confirmed without any rejoin secret', async () => {
  const f = await fixture({ username: 'Kevin', harness: 'codex' });
  f.deps.provisioner.agentUserId.mockImplementation((identityId, ownerId) => agentIdentity(identityId, ownerId, 'matrix.test', secret).userId);
  f.deps.provisioner.provision.mockImplementation(async input => ({ kind: 'ok', credentials: {
    ...credentials, userId: f.deps.provisioner.agentUserId(input.identityId ?? input.joinId, input.ownerId),
  } }));
  const members: string[] = [];
  for (let i = 0; i < 2; i++) {
    const joinId = randomBytes(16).toString('base64url');
    await f.joins.create({ ...f.record, joinId, sessionId: 'cursor-default' });
    const response = await f.handlers.confirm(f.request('POST', `joinId=${joinId}`));
    expect(response.status).toBe(200);
    members.push((await response.json() as { agentUserId: string }).agentUserId);
  }
  expect(members[0]).not.toBe(members[1]);
});
