import { randomBytes } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { OwnerId } from '@khala/contracts/messaging/index';
import type { AgentJoinCreated } from '@khala/contracts/m1/agent-join';
import type { BlobsStoreLike } from '../runtime/control-store';
import { createGateway } from '../runtime/handler';
import { registerHostedProductionRoutes } from '../composition/hosted-production';
import { createProductionHumanRuntimeLoader } from '../composition/human/production';
import { createSession, csrfTokenFor, SESSION_COOKIE } from '../auth/sessions';
import { createDigests } from '../invitations/internal';
import { createAgentJoinRoutes } from './production';

const origin = 'https://khala.aiur.team';
const env = {
  PUBLIC_APP_ORIGIN: origin,
  PUBLIC_HOMESERVER_ORIGIN: 'https://matrix.example.test',
  OIDC_ISSUER: 'https://issuer.example.test',
  OIDC_CLIENT_ID: 'khala-web', OIDC_CLIENT_SECRET: 'oidc-secret',
  CONTROL_STATE_NAMESPACE: 'khala-production', MATRIX_SERVER_NAME: 'matrix.example.test',
  MATRIX_REGISTRATION_SHARED_SECRET: 'registration-secret-with-more-than-32-bytes',
  MATRIX_PASSWORD_DERIVATION_SECRET: 'password-secret-with-more-than-32-bytes',
  INVITATION_HMAC_SECRET: 'invitation-secret-with-more-than-32-bytes',
};

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


const c2 = [
  ['/api/human/agents/rename', ['POST']],
  ['/api/agent/join', ['POST']],
  ['/api/agent/join/poll', ['GET']],
  ['/api/agent/join/ready', ['POST']],
  ['/api/human/agent-join', ['GET']],
  ['/api/human/agent-join/confirm', ['POST']],
  ['/api/human/agent-join/status', ['GET']],
] as const;
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

it('registers join and rename paths with their methods without loading adapters', () => {
  const load = vi.fn(() => { throw Error('unavailable'); });
  expect(createAgentJoinRoutes(load).map(({ path, methods }) => [path, methods])).toEqual(c2);
  expect(load).not.toHaveBeenCalled();
  const registrations = registerHostedProductionRoutes();
  for (const [path, methods] of c2) {
    expect(registrations.filter(route => route.path === path).map(route => route.methods)).toEqual([methods]);
  }
});

it('maps runtime initialization failures to 503 on every C2 route', async () => {
  const load = vi.fn(() => { throw Error('private configuration'); });
  const handle = createGateway({ registrations: createAgentJoinRoutes(load), absentPrefixes: [], appOrigin: origin });
  for (const [path, [method]] of c2) {
    const response = await handle(new Request(origin + path, { method, headers: { origin } }));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'unavailable' });
  }
  expect(load).toHaveBeenCalledTimes(7);
  const response = await handle(new Request(origin + '/api/agent/join/poll/abc'));
  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({ code: 'not_found' });
  expect(load).toHaveBeenCalledTimes(7);
});

it.each([
  { roomName: 'Release planning', channelName: 'Release planning' },
  { roomName: '', channelName: 'Untitled channel' },
])('runs the full C2 handshake through production adapters with room name $roomName', async ({ roomName, channelName }) => {
  const clock = () => Date.parse('2026-10-01T12:00:00Z');
  const blobs = durableStores();
  const registered: string[] = [];
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const path = new URL(input instanceof Request ? input.url : input.toString()).pathname;
    if (path === '/_synapse/admin/v1/register') {
      if (init?.method !== 'POST') return json({ nonce: 'nonce' });
      const body = JSON.parse(String(init.body));
      registered.push(`@${body.username}:matrix.example.test`);
      return json({ user_id: `@${body.username}:matrix.example.test` });
    }
    if (path === '/_matrix/client/v3/login') {
      const body = JSON.parse(String(init?.body));
      return json({ user_id: body.identifier.user, device_id: body.device_id,
        access_token: body.identifier.user.startsWith('@agent-') ? 'agent-token' : 'control-token' });
    }
    if (path.endsWith('/displayname') && init?.method === 'PUT' || path === '/_matrix/client/v3/logout') return json({});
    if (path.includes('/state/m.room.member/')) return json({ membership: 'join' });
    if (path.endsWith('/state/m.room.name/')) return json({ name: roomName });
    // Another owner's agent here already holds the default name, so this one joins numbered.
    if (path.endsWith('/joined_members')) return json({ joined: Object.fromEntries([['@other-agent:matrix.example.test', { display_name: 'Alice-Codex' }],
      ...registered.map(userId => [userId, { display_name: 'Ally-Codex-2' }])]) });
    throw Error(`Unexpected Synapse path: ${path}`);
  });
  const options = { env, stores: blobs.storeFor, fetch, clock };
  const active = createProductionHumanRuntimeLoader(options)();
  const ownerId = 'owner_alice' as OwnerId;
  const roomId = '!release:matrix.example.test';
  const ref = 'inv_abcdefgh';
  const digests = createDigests(env.INVITATION_HMAC_SECRET);
  expect((await active.store.compareAndSet({ key: digests.inviteKey(ref), expectedRevision: null, operationId: 'invite',
    next: { value: { v: 1, roomId, creatorOwnerId: ownerId, inviteRefDigest: digests.inviteRef(ref), policyRevision: 1,
      policy: { v: 1, kind: 'link', history: 'none' }, status: 'active', expiresAt: null, lastAuthorizedOperationDigest: null }, expiresAt: null },
  })).kind).toBe('applied');
  const session = await createSession(active.store, randomBytes, { ownerId,
    identity: { issuer: env.OIDC_ISSUER, subject: 'alice', verifiedEmail: 'alice@example.test' }, expiresAtMs: clock() + 3600000 });
  if (session.kind !== 'created') throw Error('session unavailable');
  const handle = createGateway({ registrations: registerHostedProductionRoutes(options), absentPrefixes: [], appOrigin: origin });
  const created = await handle(new Request(origin + '/api/agent/join', { method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ link: `${origin}/join/${ref}`, harness: 'codex', label: 'Release helper' }) }));
  expect(created.status).toBe(201);
  const join = await created.json() as AgentJoinCreated;
  const cookie = `${SESSION_COOKIE}=${session.token}`;
  const humanRequest = (path: string, method = 'GET') => new Request(`${origin}${path}?joinId=${join.joinId}`, {
    method, headers: { cookie, origin, 'sec-fetch-site': 'same-origin', 'x-khala-csrf': csrfTokenFor(session.token) },
  });
  const mutation = (path: string, body: unknown, csrf = true) => new Request(origin + path, { method: 'POST',
    headers: { cookie, origin, 'content-type': 'application/json', 'sec-fetch-site': 'same-origin',
      ...(csrf ? { 'x-khala-csrf': csrfTokenFor(session.token) } : {}) }, body: JSON.stringify(body) });
  expect((await handle(mutation('/api/human/profile/username', { username: 'Alice' }))).status).toBe(200);
  expect(await (await handle(humanRequest('/api/human/agent-join'))).json()).toMatchObject({ state: 'pending', channelName });
  const confirm = await handle(humanRequest('/api/human/agent-join/confirm', 'POST'));
  expect(confirm.status).toBe(200);
  expect(await confirm.json()).toMatchObject({ state: 'confirmed', label: 'Alice-Codex-2' });
  const agentRequest = (path: string, method = 'GET') => new Request(`${origin}${path}?joinId=${join.joinId}`, {
    method, headers: { origin, authorization: `Bearer ${join.pollSecret}` },
  });
  const poll = await handle(agentRequest('/api/agent/join/poll'));
  expect(poll.status).toBe(200);
  const pollBody = await poll.json() as { credentials: { userId: string } };
  expect(pollBody).toMatchObject({ state: 'confirmed', credentials: {
    accessToken: 'agent-token', userId: expect.stringMatching(/^@agent-/), roomId,
  } });
  expect(await (await handle(agentRequest('/api/agent/join/poll'))).json()).toEqual({ state: 'claimed' });
  expect((await handle(agentRequest('/api/agent/join/ready', 'POST'))).status).toBe(204);
  const status = await handle(humanRequest('/api/human/agent-join/status'));
  expect(status.status).toBe(200);
  expect(await status.json()).toMatchObject({ state: 'ready' });
  const matrixUserId = pollBody.credentials.userId;
  expect((await handle(mutation('/api/human/profile/username', { username: 'Ally' }))).status).toBe(200);
  const owner = await active.store.read(`agents/${encodeURIComponent(matrixUserId)}`);
  expect(owner.kind === 'record' && owner.record.value).toMatchObject({ label: 'Ally-Codex-2' });
  const clash = await handle(mutation('/api/human/agents/rename', { matrixUserId, name: 'alice-codex', roomId }));
  expect(clash.status).toBe(409);
  expect(await clash.json()).toEqual({ error: 'name_taken' });
  expect((await handle(mutation('/api/human/agents/rename', { matrixUserId, name: 'Reviewer' }, false))).status).toBe(403);
  const renamed = await handle(mutation('/api/human/agents/rename', { matrixUserId, name: 'Reviewer' }));
  expect(renamed.status).toBe(200);
  expect(await renamed.json()).toEqual({ matrixUserId, name: 'Reviewer' });
  expect(fetch.mock.calls.filter(([input, init]) => String(input).endsWith('/displayname') && init?.method === 'PUT')
    .some(([, init]) => init?.body === JSON.stringify({ displayname: 'Reviewer' }))).toBe(true);
});
