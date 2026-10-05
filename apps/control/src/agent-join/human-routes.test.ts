import { recordRemoval } from '../invitations/removals';
import { randomBytes } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { ownerAgentsKey } from '@khala/contracts/m1/names';
import { profileRecordKey } from '@khala/contracts/m1/profile';
import { agentOwnerRecordKey } from '@khala/contracts/m1/participants';
import type { AuthPrincipal, OwnerId, RoomId } from '@khala/contracts/messaging/index';
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
  const roomNames: string[] = [];
  const deps = { auth, joins, store, clock, random: randomBytes, sealSecret: secret,
    roomMemberNames: vi.fn(async (): Promise<readonly string[] | null> => [...roomNames]),
    inspectMembership: vi.fn(async (): Promise<GatewayInspection> => ({ kind: 'joined', historyReady: true })),
    provisioner: { setDisplayName: vi.fn(async () => true), agentUserId: vi.fn<AgentProvisioner['agentUserId']>(() => credentials.userId), provision: vi.fn<AgentProvisioner['provision']>(async () => ({ kind: 'ok' as const, credentials })) },
  };
  const request = (method = 'GET', query = `joinId=${joinId}`) => new Request(`https://khala.test/api/human/agent-join?${query}`, { method });
  return { deps, joins, store, record, joinId, request, roomNames, handlers: createAgentJoinHumanHandlers(deps), advance: () => { now += 600000; }, owner: (id: string) => { ownerId = id as OwnerId; } };
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

it('assigns the profile-based name, previews it and persists the owner index', async () => {
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
  const index = await f.store.read(ownerAgentsKey('owner'));
  expect(index.kind === 'record' && index.record.value).toEqual({ v: 1, ownerId: 'owner', agents: [credentials.userId] });
  expect((await f.handlers.confirm(f.request('POST'))).status).toBe(200);
  expect(f.deps.provisioner.provision).toHaveBeenCalledTimes(1);
});
it('uses the email suggestion when there is no profile', async () => {
  const f = await fixture({ harness: 'codex', email: 'kevin.weaver2@x' });
  expect(await (await f.handlers.view(f.request())).json()).toMatchObject({ label: 'Kevin-Codex' });
  expect(await (await f.handlers.confirm(f.request('POST'))).json()).toMatchObject({ label: 'Kevin-Codex' });
});
it('keeps the staged name after provisioning fails and does not append the index twice', async () => {
  const f = await fixture({ username: 'Kevin', harness: 'codex' });
  f.deps.provisioner.provision.mockRejectedValueOnce(Error('offline'));
  expect((await f.handlers.confirm(f.request('POST'))).status).toBe(503);
  expect(await (await f.handlers.confirm(f.request('POST'))).json()).toMatchObject({ label: 'Kevin-Codex' });
  const index = await f.store.read(ownerAgentsKey('owner'));
  expect(index.kind === 'record' && index.record.value).toMatchObject({ agents: [credentials.userId] });
});
it('fails closed when the profile is unavailable', async () => {
  for (const prefix of ['profiles/']) {
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


it('refuses confirmation if provisioning crosses the join deadline', async () => {
  const f = await fixture({ username: 'Kevin' });
  f.deps.provisioner.provision.mockImplementationOnce(async () => { f.advance(); return { kind: 'ok', credentials }; });
  expect((await f.handlers.confirm(f.request('POST'))).status).toBe(404);
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
});

it('numbers the default name only for a different hosted session in the same channel', async () => {
  const f = await fixture({ username: 'Kevin', harness: 'codex' });
  f.deps.provisioner.agentUserId.mockImplementation((identityId, ownerId) => agentIdentity(identityId, ownerId, 'matrix.test', secret).userId);
  f.deps.provisioner.provision.mockImplementation(async input => ({ kind: 'ok', credentials: {
    ...credentials, accessToken: 'token-' + input.joinId, userId: f.deps.provisioner.agentUserId(input.identityId ?? input.joinId, input.ownerId),
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
    if (!f.roomNames.includes(view.label)) f.roomNames.push(view.label);
  }
  expect(members[0]).toBe(members[1]);
  expect(members[2]).not.toBe(members[0]);
});

it('keeps sibling hosted agents separate when a session id is asserted without its secret', async () => {
  const f = await fixture({ username: 'Kevin', harness: 'codex' });
  f.deps.provisioner.agentUserId.mockImplementation((identityId, ownerId) => agentIdentity(identityId, ownerId, 'matrix.test', secret).userId);
  f.deps.provisioner.provision.mockImplementation(async input => ({ kind: 'ok', credentials: {
    ...credentials, accessToken: 'token-' + input.joinId, userId: f.deps.provisioner.agentUserId(input.identityId ?? input.joinId, input.ownerId),
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
    if (!f.roomNames.includes(view.label)) f.roomNames.push(view.label);
  }
  expect(new Set(members)).toHaveProperty('size', 3);
  expect(members[0]).toBe(members[3]);
  expect(names).toEqual(['Kevin-Codex', 'Kevin-Codex-2', 'Kevin-Codex-3', 'Kevin-Codex']);
});

it('never reuses a hosted identity for a session id confirmed without any rejoin secret', async () => {
  const f = await fixture({ username: 'Kevin', harness: 'codex' });
  f.deps.provisioner.agentUserId.mockImplementation((identityId, ownerId) => agentIdentity(identityId, ownerId, 'matrix.test', secret).userId);
  f.deps.provisioner.provision.mockImplementation(async input => ({ kind: 'ok', credentials: {
    ...credentials, accessToken: 'token-' + input.joinId, userId: f.deps.provisioner.agentUserId(input.identityId ?? input.joinId, input.ownerId),
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

it('previews and confirms the lowest free number when someone in the channel holds the default name', async () => {
  const f = await fixture({ username: 'Kevin', harness: 'codex' });
  f.roomNames.push('kevin', 'kevin-codex', 'Kevin-Codex-3');
  expect(await (await f.handlers.view(f.request())).json()).toMatchObject({ state: 'pending', label: 'Kevin-Codex-2' });
  expect(await (await f.handlers.confirm(f.request('POST'))).json()).toMatchObject({ state: 'confirmed', label: 'Kevin-Codex-2' });
  expect(f.deps.provisioner.provision).toHaveBeenCalledWith(expect.objectContaining({ label: 'Kevin-Codex-2' }));
  expect(f.deps.roomMemberNames).toHaveBeenCalledWith('owner', credentials.roomId);
});
it('lets the same default name exist in another channel', async () => {
  const f = await fixture({ username: 'Kevin', harness: 'codex' });
  // Another owner's Kevin-Codex in some other channel is invisible here: only this channel's members count.
  expect(await (await f.handlers.confirm(f.request('POST'))).json()).toMatchObject({ label: 'Kevin-Codex' });
});
it('fails closed when the channel members cannot be read', async () => {
  const f = await fixture({ username: 'Kevin' });
  f.deps.roomMemberNames.mockResolvedValue(null);
  expect((await f.handlers.confirm(f.request('POST'))).status).toBe(503);
  expect(f.deps.provisioner.provision).not.toHaveBeenCalled();
});

it('revokes provisioned credentials and refuses confirmation when owner removal races provisioning', async () => {
  const f = await fixture();
  const revokeAgentSession = vi.fn(async () => true);
  f.deps.provisioner.provision.mockImplementation(async () => {
    await recordRemoval(f.store, credentials.roomId as RoomId, 'creator' as OwnerId, 'owner' as OwnerId, [credentials.userId], 'Owner');
    return { kind: 'ok', credentials };
  });
  const handlers = createAgentJoinHumanHandlers({ ...f.deps, revokeAgentSession });
  expect((await handlers.confirm(f.request('POST'))).status).toBe(403);
  expect(revokeAgentSession).toHaveBeenCalledWith(credentials.userId, credentials.roomId);
  const read = await f.joins.read(f.joinId);
  expect(read.kind === 'found' && read.record.state).toBe('pending');
});

it('auto-confirms a saved hosted session after one human approval, even after join expiry', async () => {
  const f = await fixture({ username: 'Kevin', harness: 'codex' });
  const { createAgentJoinAgentHandlers } = await import('./agent-routes');
  const { createDigests } = await import('../invitations/internal');
  const digests = createDigests(secret), ref = 'inv_abcdefgh';
  await f.store.compareAndSet({ key: digests.inviteKey(ref), expectedRevision: null, operationId: 'invite', next: { value: {
    v: 1, roomId: credentials.roomId, creatorOwnerId: 'owner', inviteRefDigest: digests.inviteRef(ref), policyRevision: 1,
    policy: { v: 1, kind: 'link', history: 'none' }, status: 'active', expiresAt: null, lastAuthorizedOperationDigest: null,
  }, expiresAt: null } });
  const agents = () => createAgentJoinAgentHandlers({ ...f.deps, origin: 'https://khala.test', secret,
    roomName: async () => 'Channel', autoConfirm: createAgentJoinHumanHandlers(f.deps).autoConfirm });
  const create = async (overrides = {}) => {
    const response = await agents().create(new Request('https://khala.test/api/agent/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      link: `https://khala.test/join/${ref}`, harness: 'codex', label: 'Codex', sessionId: 'thread-1', rejoinSecret: 'S'.repeat(43), ...overrides,
    }) }));
    expect(response.status).toBe(201);
    return await response.json() as { joinId: string; pollSecret: string; autoConfirmed?: boolean };
  };
  const first = await create();
  expect((await f.joins.read(first.joinId)).kind).toBe('found');
  expect(f.deps.provisioner.provision).not.toHaveBeenCalled();
  expect((await f.handlers.confirm(f.request('POST', `joinId=${first.joinId}`))).status).toBe(200);
  f.advance();
  const second = await create();
  expect(second.autoConfirmed).toBe(true);
  const polled = await agents().poll(new Request(`https://khala.test/api/agent/join/poll?joinId=${second.joinId}`, { headers: { authorization: `Bearer ${second.pollSecret}` } }));
  expect(await polled.json()).toEqual({ state: 'confirmed', credentials });
  expect(f.deps.provisioner.provision).toHaveBeenCalledTimes(2);
  for (const changes of [{ rejoinSecret: 'X'.repeat(43) }, { sessionId: 'thread-2' }, { harness: 'claude' }]) {
    const next = await create(changes);
    const read = await f.joins.read(next.joinId);
    expect(read.kind === 'found' && read.record.state).toBe('pending');
  }
  f.deps.inspectMembership.mockResolvedValueOnce({ kind: 'absent' });
  const absent = await create();
  expect(absent.autoConfirmed).toBeUndefined();
  expect(f.deps.provisioner.provision).toHaveBeenCalledTimes(2);
  // Previously granted approval cannot survive removal, even when membership returns.
  await recordRemoval(f.store, credentials.roomId as RoomId, 'owner' as OwnerId, 'owner' as OwnerId, [credentials.userId], 'Kevin');
  const removedId = randomBytes(16).toString('base64url');
  await f.joins.create({ ...f.record, joinId: removedId, sessionId: 'thread-1', rejoinSecretHash: hashPollSecret('S'.repeat(43)), createdAt: new Date(f.deps.clock()).toISOString(), expiresAt: new Date(f.deps.clock() + 600000).toISOString() });
  expect(await f.handlers.autoConfirm(removedId)).toBe(true);
  const read = await f.joins.read(removedId);
  expect(read.kind === 'found' && read.record.state).toBe('pending');
  expect(f.deps.provisioner.provision).toHaveBeenCalledTimes(2);
});

async function enableRejoin(f: Awaited<ReturnType<typeof fixture>>) {
  const first = await f.joins.read(f.joinId);
  if (first.kind !== 'found') throw Error();
  await f.joins.replace(f.joinId, first.revision, { ...first.record, sessionId: 'thread-1', rejoinSecretHash: hashPollSecret('S'.repeat(43)) }, 'session');
}
async function nextRejoin(f: Awaited<ReturnType<typeof fixture>>) {
  const joinId = randomBytes(16).toString('base64url');
  expect(await f.joins.create({ ...f.record, joinId, sessionId: 'thread-1', rejoinSecretHash: hashPollSecret('S'.repeat(43)) })).toBe('created');
  return joinId;
}
it('repairs approval persistence when human confirmation is retried after a storage outage', async () => {
  const f = await fixture({ username: 'Kevin', harness: 'codex' });
  await enableRejoin(f);
  const write = f.store.compareAndSet;
  const outage = vi.spyOn(f.store, 'compareAndSet').mockImplementation(async (...args) => args[0].key.startsWith('agent-rejoin-approval.') ? { kind: 'unavailable' } : write(...args));
  expect((await f.handlers.confirm(f.request('POST'))).status).toBe(503);
  outage.mockRestore();
  expect((await f.handlers.confirm(f.request('POST'))).status).toBe(200);
  const joinId = await nextRejoin(f);
  expect(await f.handlers.autoConfirm(joinId)).toBe(true);
  const read = await f.joins.read(joinId);
  expect(read.kind === 'found' && read.record.state).toBe('confirmed');
});
it('requires fresh human approval after observing owner membership loss, even if membership returns', async () => {
  const f = await fixture({ username: 'Kevin', harness: 'codex' });
  await enableRejoin(f);
  expect((await f.handlers.confirm(f.request('POST'))).status).toBe(200);
  f.deps.inspectMembership.mockResolvedValueOnce({ kind: 'absent' });
  expect(await f.handlers.autoConfirm(await nextRejoin(f))).toBe(true);
  // Retrying the old confirmation must not clear the revocation.
  expect((await f.handlers.confirm(f.request('POST'))).status).toBe(200);
  const joinId = await nextRejoin(f);
  expect(await f.handlers.autoConfirm(joinId)).toBe(true);
  const read = await f.joins.read(joinId);
  expect(read.kind === 'found' && read.record.state).toBe('pending');
  expect(f.deps.provisioner.provision).toHaveBeenCalledTimes(1);
  expect((await f.handlers.confirm(f.request('POST', `joinId=${joinId}`))).status).toBe(200);
  const resumedId = await nextRejoin(f);
  expect(await f.handlers.autoConfirm(resumedId)).toBe(true);
  const resumed = await f.joins.read(resumedId);
  expect(resumed.kind === 'found' && resumed.record.state).toBe('confirmed');
});

it('refreshes the owner label from the current profile when auto-confirming', async () => {
  const f = await fixture({ username: 'Kevin', harness: 'codex' });
  await enableRejoin(f);
  expect((await f.handlers.confirm(f.request('POST'))).status).toBe(200);
  const profile = await f.store.read(profileRecordKey('owner' as OwnerId));
  if (profile.kind !== 'record') throw Error();
  expect((await f.store.compareAndSet({ key: profileRecordKey('owner' as OwnerId), expectedRevision: profile.record.revision, operationId: 'profile.rename',
    next: { value: { v: 1, ownerId: 'owner', username: 'Alex', updatedAt: new Date(f.deps.clock()).toISOString() }, expiresAt: null } })).kind).toBe('applied');
  expect(await f.handlers.autoConfirm(await nextRejoin(f))).toBe(true);
  const map = await f.store.read<{ ownerLabel: string }>(agentOwnerRecordKey(credentials.userId));
  expect(map.kind === 'record' && map.record.value.ownerLabel).toBe('Alex');
});

it('does not reuse an approval in another room or provision on unavailable/corrupt grants', async () => {
  const f = await fixture({ username: 'Kevin', harness: 'codex' });
  await enableRejoin(f);
  expect((await f.handlers.confirm(f.request('POST'))).status).toBe(200);
  const otherId = randomBytes(16).toString('base64url');
  expect(await f.joins.create({ ...f.record, joinId: otherId, roomId: '!other:matrix.test', sessionId: 'thread-1', rejoinSecretHash: hashPollSecret('S'.repeat(43)) })).toBe('created');
  expect(await f.handlers.autoConfirm(otherId)).toBe(true);
  const other = await f.joins.read(otherId);
  expect(other.kind === 'found' && other.record.state).toBe('pending');
  const nextId = await nextRejoin(f), read = f.store.read;
  const outage = vi.spyOn(f.store, 'read').mockImplementation(async (...args) => args[0].startsWith('agent-rejoin-approval.') ? { kind: 'unavailable' } : read(...args));
  await expect(f.handlers.autoConfirm(nextId)).rejects.toThrow('unavailable');
  outage.mockRestore();
  const corrupt = vi.spyOn(f.store, 'read').mockImplementation(async (...args) => {
    const result = await read(...args);
    return args[0].startsWith('agent-rejoin-approval.') && result.kind === 'record'
      ? { ...result, record: { ...result.record, value: { v: 1, ownerId: 'owner', ownerLabel: 'Kevin', generation: -1 } } } : result;
  });
  await expect(f.handlers.autoConfirm(nextId)).rejects.toThrow('unavailable');
  corrupt.mockRestore();
  expect(f.deps.provisioner.provision).toHaveBeenCalledTimes(1);
});
