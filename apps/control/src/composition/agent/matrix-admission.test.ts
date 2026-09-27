import { createHmac } from 'node:crypto';
import type { OwnerId, SessionBinding } from '@khala/contracts/messaging/index';
import { describe, expect, it, vi } from 'vitest';
import { ROOM_ID, SECRET, T0, harness, principal } from '../../invitations/support.test';
import { createInviteEvidenceReader } from './invite-evidence';
import { agentMatrixIdentity, createMatrixAgentAdmission } from './matrix-admission';

const serverName = 'matrix.example.test';
const homeserverOrigin = `https://${serverName}`;
const registrationSharedSecret = 'registration-secret-with-more-than-32-bytes';
const passwordDerivationSecret = 'password-secret-with-more-than-32-bytes';
const ownerUserId = (ownerId: string) => `@khala_${Buffer.from(ownerId).toString('base64url')}:${serverName}`;
const ownerPassword = (ownerId: string) => createHmac('sha256', passwordDerivationSecret)
  .update('khala-matrix-password-v1\0').update(ownerId).digest('base64url');

function fakeMatrix() {
  const passwords = new Map<string, string>();
  const tokens = new Map<string, string>();
  const members = new Set<string>();
  const calls: string[] = [];
  for (const ownerId of ['owner_1', 'owner_2']) {
    passwords.set(ownerUserId(ownerId), ownerPassword(ownerId));
    members.add(`${ROOM_ID}|${ownerUserId(ownerId)}`);
  }
  const fetch = vi.fn(async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const path = url.pathname;
    calls.push(`${init?.method ?? 'GET'} ${path}`);
    const reply = (status: number, value: unknown) => new Response(JSON.stringify(value), {
      status, headers: { 'content-type': 'application/json' },
    });
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    const bearer = init?.headers && new Headers(init.headers).get('authorization')?.slice('Bearer '.length);
    if (path.startsWith('/_matrix/client/v3/profile/')) {
      const userId = decodeURIComponent(path.slice('/_matrix/client/v3/profile/'.length));
      return passwords.has(userId) ? reply(200, {}) : reply(404, { errcode: 'M_NOT_FOUND' });
    }
    if (path === '/_synapse/admin/v1/register' && !init?.method) return reply(200, { nonce: 'nonce-1' });
    if (path === '/_synapse/admin/v1/register' && init?.method === 'POST') {
      const userId = `@${body.username}:${serverName}`;
      if (passwords.has(userId)) return reply(400, { errcode: 'M_USER_IN_USE' });
      expect(String(body.mac)).toHaveLength(40);
      passwords.set(userId, String(body.password));
      return reply(200, { user_id: userId });
    }
    if (path === '/_matrix/client/v3/login') {
      const userId = (body.identifier as { user: string }).user;
      if (passwords.get(userId) !== body.password) return reply(403, { errcode: 'M_FORBIDDEN' });
      const token = `token-${userId}-${body.device_id}`;
      tokens.set(token, userId);
      return reply(200, { user_id: userId, device_id: body.device_id, access_token: token });
    }
    if (path === '/_matrix/client/v3/keys/query') {
      if (!bearer || !tokens.has(bearer)) return reply(401, {});
      const requested = body.device_keys as Record<string, string[]>;
      return reply(200, { device_keys: Object.fromEntries(Object.entries(requested).map(([userId, devices]) => [
        userId, Object.fromEntries(devices.map(deviceId => [deviceId, {
          user_id: userId, device_id: deviceId,
          keys: { [`ed25519:${deviceId}`]: 'A'.repeat(43), [`curve25519:${deviceId}`]: 'B'.repeat(43) },
        }])),
      ])) });
    }
    const member = /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/state\/m\.room\.member\/(.+)$/u.exec(path);
    if (member) {
      const roomId = decodeURIComponent(member[1]!);
      const userId = decodeURIComponent(member[2]!);
      if (!bearer || !tokens.has(bearer)) return reply(401, {});
      return members.has(`${roomId}|${userId}`) ? reply(200, { membership: 'join' }) : reply(404, {});
    }
    const invite = /^\/_matrix\/client\/v3\/rooms\/([^/]+)\/invite$/u.exec(path);
    if (invite) return tokens.has(bearer ?? '') ? reply(200, {}) : reply(403, {});
    const join = /^\/_matrix\/client\/v3\/join\/(.+)$/u.exec(path);
    if (join) {
      const roomId = decodeURIComponent(join[1]!);
      const userId = tokens.get(bearer ?? '');
      if (!userId) return reply(403, {});
      members.add(`${roomId}|${userId}`);
      return reply(200, { room_id: roomId });
    }
    return reply(404, {});
  });
  return { fetch: fetch as typeof globalThis.fetch, calls, members };
}

describe('Matrix agent admission production adapter', () => {
  it('binds two signed-in owners to distinct existing sessions and rejects wrong owner, stale link and revoked link', async () => {
    const h = harness();
    const shared = await h.service.share({ operationId: 'share-agent', roomId: ROOM_ID });
    expect(shared.kind).toBe('ok');
    if (shared.kind !== 'ok') return;
    const { inviteRef } = shared.value;
    const matrix = fakeMatrix();
    const adapter = createMatrixAgentAdmission({
      homeserverOrigin, serverName, registrationSharedSecret, passwordDerivationSecret,
      invitationHmacSecret: SECRET, store: h.store.store, clock: () => T0, fetch: matrix.fetch,
    });
    const evidenceFor = createInviteEvidenceReader({ store: h.store.store, secret: SECRET, clock: () => T0 });
    for (const owner of ['owner_1', 'owner_2']) {
      const ownerId = owner as OwnerId;
      const session = { harness: 'codex', sessionId: `existing-${owner}`, generation: 1 };
      const evidence = await evidenceFor(principal(owner), inviteRef);
      expect(evidence).not.toBeNull();
      const input = { ownerId, principal: principal(owner), inviteRef, session, inviteEvidence: evidence };
      const inspected = await adapter.agents.inspect(input);
      expect(inspected.kind).toBe('ok');
      if (inspected.kind !== 'ok') continue;
      const admitted = await adapter.agents.admit({
        ...input, deviceId: `device_${owner}`, operationId: `bootstrap-${owner}`,
        expectedRoomId: ROOM_ID, expectedAgentParticipantId: inspected.value.agentParticipantId,
      });
      expect(admitted).toEqual(inspected);
      const identity = agentMatrixIdentity(ownerId, session, serverName);
      expect(matrix.members.has(`${ROOM_ID}|${identity.userId}`)).toBe(true);
      const issued = await adapter.deviceSession.issue({
        v: 1, bindingId: `binding_${owner}`, ownerId,
        agentParticipantId: identity.participantId, deviceId: `device_${owner}`,
        ...session,
      } as SessionBinding, ROOM_ID);
      expect(issued).toMatchObject({ baseUrl: homeserverOrigin, userId: identity.userId, deviceId: `device_${owner}`, roomId: ROOM_ID });
      const binding = { v: 1, bindingId: `binding_${owner}`, ownerId,
        agentParticipantId: identity.participantId, deviceId: `device_${owner}`, ...session } as SessionBinding;
      expect(await adapter.publishedDeviceFingerprint(binding)).toBe('A'.repeat(43));
      expect(await adapter.publishedDeviceIdentityKey(binding)).toBe('B'.repeat(43));
    }
    expect(agentMatrixIdentity('owner_1' as OwnerId, { harness: 'codex', sessionId: 'existing-owner_1', generation: 1 }, serverName).userId)
      .not.toBe(agentMatrixIdentity('owner_2' as OwnerId, { harness: 'codex', sessionId: 'existing-owner_2', generation: 1 }, serverName).userId);

    const evidence = await evidenceFor(principal('owner_1'), inviteRef);
    const wrong = await adapter.agents.inspect({
      ownerId: 'owner_2' as OwnerId, principal: principal('owner_1'), inviteRef,
      session: { harness: 'codex', sessionId: 'wrong', generation: 1 }, inviteEvidence: evidence,
    });
    expect(wrong).toEqual({ kind: 'rejected', code: 'forbidden' });

    const record = [...h.store.records.values()].find(value => value.value && typeof value.value === 'object'
      && 'inviteRefDigest' in value.value)!;
    h.store.records.set(record.key, { ...record, revision: `${record.revision}.stale` });
    expect((await adapter.agents.inspect({
      ownerId: 'owner_1' as OwnerId, principal: principal('owner_1'), inviteRef,
      session: { harness: 'codex', sessionId: 'new', generation: 1 }, inviteEvidence: evidence,
    })).kind).toBe('rejected');
    expect(await h.service.revoke({ operationId: 'revoke-agent', inviteRef })).toEqual({ kind: 'ok', value: null });
    expect((await adapter.agents.inspect({
      ownerId: 'owner_1' as OwnerId, principal: principal('owner_1'), inviteRef,
      session: { harness: 'codex', sessionId: 'new', generation: 1 }, inviteEvidence: evidence,
    })).kind).toBe('rejected');
  });
});
