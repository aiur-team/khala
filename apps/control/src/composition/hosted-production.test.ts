import { describe, expect, it } from 'vitest';
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { createSession, SESSION_COOKIE, csrfTokenFor } from '../auth/sessions';
import { createChannelAccessPolicy } from '@khala/messaging/channel-access/journal/policy';
import { createChannelAccessStore } from '@khala/messaging/channel-access/journal/store';
import { projectOwner } from '@khala/messaging/channel-access/journal/service';
import { createControlStore } from '../runtime/control-store';
import { decodeChannelAccessOwnerProjection } from '@khala/contracts/messaging/index';
import type { BlobsStoreLike } from '../runtime/control-store';
import { createGateway } from '../runtime/handler';
import { registerHostedProductionRoutes } from './hosted-production';
import { createHostedDiscoveryBootstrap } from './hosted-discovery-bootstrap';
import { createDigests } from '../invitations/internal';
import { thumbprint } from '../agent-bootstrap/proof';
import { PROOF_KEY_APPROVE_PATH, PROOF_KEY_CANDIDATE_PATH, PROOF_KEY_CHALLENGE_PATH,
  PROOF_KEY_REVOKE_PATH } from './hosted-proof-key-authority';

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
const stores = (): BlobsStoreLike => ({
  getWithMetadata: async () => null, setJSON: async () => ({ modified: true, etag: '1' }),
});

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

function gateway(mode?: string, appOrigin = origin) {
  return createGateway({
    registrations: registerHostedProductionRoutes({ env: { ...env, PUBLIC_APP_ORIGIN: appOrigin, KHALA_ADMISSION_MODE: mode }, stores }),
    absentPrefixes: [], appOrigin,
  });
}

describe('generated hosted production composition', () => {
  it('resolves A’s link as authenticated B and issues B’s own link after join', async () => {
    const blobs = durableStores();
    const now = Date.parse('2026-09-28T12:00:00Z');
    const roomId = '!room:matrix.example.test';
    let joined = false;
    const matrixFetch: typeof fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/_matrix/client/v3/login') {
        const body = JSON.parse(String(init?.body)) as { identifier: { user: string }; device_id: string };
        return Response.json({ user_id: body.identifier.user, device_id: body.device_id, access_token: 'test-token' });
      }
      if (path.includes('/state/m.room.member/')) return joined
        ? Response.json({ membership: 'join' }) : Response.json({ errcode: 'M_FORBIDDEN' }, { status: 403 });
      return Response.json({ errcode: 'M_NOT_FOUND' }, { status: 404 });
    };
    const control = createControlStore({ records: blobs.storeFor(`${env.CONTROL_STATE_NAMESPACE}-records`),
      operations: blobs.storeFor(`${env.CONTROL_STATE_NAMESPACE}-operations`), clock: () => now });
    const session = await createSession(control, () => new Uint8Array(32).fill(9), {
      ownerId: 'owner_b' as never,
      identity: { issuer: env.OIDC_ISSUER, subject: 'owner-b', verifiedEmail: 'b@example.test' },
      expiresAtMs: now + 3600_000,
    });
    expect(session.kind).toBe('created');
    if (session.kind !== 'created') return;
    const digests = createDigests(env.INVITATION_HMAC_SECRET);
    const inviteRef = digests.token('shared_by_a');
    expect((await control.compareAndSet({
      key: digests.inviteKey(inviteRef), expectedRevision: null, operationId: 'seed-invite',
      next: { value: { v: 1, roomId, creatorOwnerId: 'owner_a', inviteRefDigest: digests.inviteRef(inviteRef),
        policyRevision: 1, policy: { v: 1, kind: 'link', history: 'none' }, status: 'active',
        expiresAt: new Date(now + 7 * 24 * 3600_000).toISOString(), lastAuthorizedOperationDigest: null }, expiresAt: null },
    })).kind).toBe('applied');
    const route = createGateway({ registrations: registerHostedProductionRoutes({
      env: { ...env, KHALA_ADMISSION_MODE: 'explicit_browser_consent' }, stores: blobs.storeFor,
      clock: () => now, fetch: matrixFetch,
    }), absentPrefixes: [], appOrigin: origin });
    const headers = { cookie: `${SESSION_COOKIE}=${session.token}`, origin, 'content-type': 'application/json' };
    const resolve = () => route(new Request(`${origin}/api/human/channel-link/resolve`, {
      method: 'POST', headers, body: JSON.stringify({ v: 1, channelUrl: `${origin}/join/${inviteRef}` }),
    }));
    expect(await (await resolve()).json()).toEqual({ v: 1, kind: 'join_required' });
    joined = true;
    expect(await (await resolve()).json()).toEqual({ v: 1, kind: 'joined' });
    const personal = await route(new Request(`${origin}/api/human/channel-link/personal`, {
      method: 'POST', headers: { ...headers, 'x-khala-csrf': csrfTokenFor(session.token) },
      body: JSON.stringify({ v: 1, roomId }),
    }));
    expect(personal.status).toBe(200);
    const result = await personal.json() as { shareUrl: string; kind: string };
    expect(result.kind).toBe('personal_link');
    expect(result.shareUrl).not.toBe(`${origin}/join/${inviteRef}`);
    expect(await (await route(new Request(`${origin}/api/human/channel-link/personal`, {
      method: 'POST', headers: { ...headers, 'x-khala-csrf': csrfTokenFor(session.token) },
      body: JSON.stringify({ v: 1, roomId }),
    }))).json()).toEqual(result);
  });

  it('registers signed-in channel-link resolution and personal issuance in hosted mode', async () => {
    const route = gateway('explicit_browser_consent');
    for (const path of ['/api/human/channel-link/resolve', '/api/human/channel-link/personal']) {
      const response = await route(new Request(`${origin}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json', origin }, body: '{}',
      }));
      expect(response.status).toBe(401);
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('bounds anonymous proof-key challenges before allocating durable records', async () => {
    const blobs = durableStores();
    const now = Date.parse('2026-09-28T12:00:00Z');
    const control = createControlStore({ records: blobs.storeFor(`${env.CONTROL_STATE_NAMESPACE}-records`),
      operations: blobs.storeFor(`${env.CONTROL_STATE_NAMESPACE}-operations`), clock: () => now });
    expect((await control.compareAndSet({ key: `channel-discovery:hosted-attempts:${Math.floor(now / 60_000)}`,
      expectedRevision: null, operationId: 'exhaust-budget',
      next: { value: 300, expiresAt: new Date(now + 120_000).toISOString() } })).kind).toBe('applied');
    const route = createGateway({ registrations: registerHostedProductionRoutes({
      env: { ...env, KHALA_ADMISSION_MODE: 'explicit_browser_consent' }, stores: blobs.storeFor, clock: () => now,
    }), absentPrefixes: [], appOrigin: origin });
    const challenge = await route(new Request(`${origin}${PROOF_KEY_CHALLENGE_PATH}?jkt=${'A'.repeat(43)}`));
    expect(challenge.status).toBe(429);
    expect(await challenge.json()).toEqual({ kind: 'limited' });
  });
  it('bounds unauthenticated candidate JSON before parsing it', async () => {
    const blobs = durableStores();
    const route = createGateway({ registrations: registerHostedProductionRoutes({
      env: { ...env, KHALA_ADMISSION_MODE: 'explicit_browser_consent' }, stores: blobs.storeFor,
    }), absentPrefixes: [], appOrigin: origin });
    const response = await route(new Request(`${origin}${PROOF_KEY_CANDIDATE_PATH}`, {
      method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'a'.repeat(4_096) }),
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ kind: 'rejected' });
  });
  it('does not authenticate a claimed native thread without a discovery credential', async () => {
    const discovery = createHostedDiscoveryBootstrap({ env, stores });
    const request = new Request(`${origin}/api/agent/channel-access/request`, {
      method: 'POST', headers: { origin, 'x-khala-session-id': 'forged-thread', 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1, operationId: 'op-forged' }),
    });
    expect(await discovery.authenticateAgent(request)).toEqual({ kind: 'rejected', code: 'auth_required' });
    const gatewayRoute = gateway('explicit_browser_consent');
    expect((await gatewayRoute(request)).status).toBe(503);
  });
  it('requires a signed challenged key and the exact owner before making discovery authority available', async () => {
    const blobs = durableStores();
    const now = Date.parse('2026-09-28T12:00:00Z');
    const roomId = '!room:matrix.example.test';
    const inviteRef = 'inv_abcdefgh';
    const link = `${origin}/join/${inviteRef}`;
    const control = createControlStore({ records: blobs.storeFor(`${env.CONTROL_STATE_NAMESPACE}-records`),
      operations: blobs.storeFor(`${env.CONTROL_STATE_NAMESPACE}-operations`), clock: () => now });
    const digests = createDigests(env.INVITATION_HMAC_SECRET);
    expect((await control.compareAndSet({ key: digests.inviteKey(inviteRef), expectedRevision: null,
      operationId: 'create-invite', next: { value: { v: 1, roomId, creatorOwnerId: 'owner_1',
        inviteRefDigest: digests.inviteRef(inviteRef), policyRevision: 1,
        policy: { v: 1, kind: 'link', history: 'none' }, status: 'active', expiresAt: null,
        lastAuthorizedOperationDigest: null }, expiresAt: null } })).kind).toBe('applied');
    expect((await control.compareAndSet({ key: `matrix.room-authority.v1.${createHash('sha256').update(roomId).digest('hex')}`,
      expectedRevision: null, operationId: 'claim-room',
      next: { value: { v: 1, roomId, ownerId: 'owner_1' }, expiresAt: null } })).kind).toBe('applied');
    const owner = await createSession(control, () => new Uint8Array(32).fill(3), {
      ownerId: 'owner_1' as never, identity: { issuer: env.OIDC_ISSUER, subject: 'one', verifiedEmail: 'one@example.test' },
      expiresAtMs: now + 3600_000,
    });
    const other = await createSession(control, () => new Uint8Array(32).fill(4), {
      ownerId: 'owner_2' as never, identity: { issuer: env.OIDC_ISSUER, subject: 'two', verifiedEmail: 'two@example.test' },
      expiresAtMs: now + 3600_000,
    });
    if (owner.kind !== 'created' || other.kind !== 'created') throw new Error('owner sessions unavailable');
    const matrixFetch: typeof fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/_matrix/client/v3/login') {
        const body = JSON.parse(String(init?.body)) as { identifier: { user: string }; device_id: string };
        return Response.json({ user_id: body.identifier.user, device_id: body.device_id, access_token: 'test-token' });
      }
      return path.includes('/state/m.room.member/') ? Response.json({ membership: 'join' })
        : Response.json({ errcode: 'M_NOT_FOUND' }, { status: 404 });
    };
    const route = createGateway({ registrations: registerHostedProductionRoutes({
      env: { ...env, KHALA_ADMISSION_MODE: 'explicit_browser_consent' }, stores: blobs.storeFor,
      clock: () => now, fetch: matrixFetch,
    }), absentPrefixes: [], appOrigin: origin });
    const { privateKey } = generateKeyPairSync('ed25519');
    const x = createPublicKey(privateKey).export({ format: 'jwk' }).x!;
    const jkt = thumbprint(x);
    const challengeResponse = await route(new Request(`${origin}${PROOF_KEY_CHALLENGE_PATH}?jkt=${jkt}`));
    expect(challengeResponse.status).toBe(200);
    const { nonce } = await challengeResponse.json() as { nonce: string };
    const body = { operationId: 'same-operation', target: link, harness: 'codex',
      sessionId: 'caller-label', generation: 0, nonce };
    const bodyHash = createHash('sha256').update(JSON.stringify(['khala.proof-key-candidate.v1', body.operationId,
      body.target, body.harness, body.sessionId, body.generation])).digest('base64url');
    const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'dpop+jwt',
      jwk: { kty: 'OKP', crv: 'Ed25519', x } })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ htm: 'POST', htu: `${origin}${PROOF_KEY_CANDIDATE_PATH}`,
      iat: Math.floor(now / 1000), jti: randomBytes(16).toString('base64url'), nonce, body_hash: bodyHash })).toString('base64url');
    const proof = `${header}.${payload}.${sign(null, Buffer.from(`${header}.${payload}`), privateKey).toString('base64url')}`;
    const candidate = () => route(new Request(`${origin}${PROOF_KEY_CANDIDATE_PATH}`, {
      method: 'POST', headers: { origin, 'content-type': 'application/json', dpop: proof }, body: JSON.stringify(body),
    }));
    const pending = await candidate();
    expect(pending.status).toBe(202);
    const { candidateId } = await pending.json() as { candidateId: string };
    expect((await candidate()).status).toBe(403);
    const approveUrl = `${origin}${PROOF_KEY_APPROVE_PATH}?candidate=${candidateId}`;
    expect((await route(new Request(approveUrl, { headers: { cookie: `${SESSION_COOKIE}=${other.token}` } }))).status).toBe(403);
    const ownerCookie = { cookie: `${SESSION_COOKIE}=${owner.token}` };
    const page = await route(new Request(approveUrl, { headers: ownerCookie }));
    expect(page.status).toBe(200);
    const consentText = await page.text();
    expect(consentText).toContain('cannot verify that provider thread exists');
    expect(consentText).toContain('owner-wide, not limited to that one link');
    const decide = (token: string) => route(new Request(`${origin}${PROOF_KEY_APPROVE_PATH}`, {
      method: 'POST', headers: { origin, cookie: `${SESSION_COOKIE}=${token}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ candidate: candidateId, csrf_token: csrfTokenFor(token), decision: 'approve' }),
    }));
    expect((await decide(other.token)).status).toBe(403);
    expect((await decide(owner.token)).status).toBe(200);
    const changed = { ...body, nonce: (await (await route(new Request(`${origin}${PROOF_KEY_CHALLENGE_PATH}?jkt=${jkt}`))).json() as { nonce: string }).nonce };
    const changedPayload = Buffer.from(JSON.stringify({ htm: 'POST', htu: `${origin}${PROOF_KEY_CANDIDATE_PATH}`,
      iat: Math.floor(now / 1000), jti: randomBytes(16).toString('base64url'), nonce: changed.nonce,
      body_hash: bodyHash })).toString('base64url');
    const changedProof = `${header}.${changedPayload}.${sign(null, Buffer.from(`${header}.${changedPayload}`), privateKey).toString('base64url')}`;
    const approved = await route(new Request(`${origin}${PROOF_KEY_CANDIDATE_PATH}`, {
      method: 'POST', headers: { origin, 'content-type': 'application/json', dpop: changedProof }, body: JSON.stringify(changed),
    }));
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({ kind: 'approved', candidateId });
    const revokeUrl = `${origin}${PROOF_KEY_REVOKE_PATH}?${new URLSearchParams({ harness: 'codex', session_id: 'caller-label' })}`;
    const revokePage = await route(new Request(revokeUrl, { headers: ownerCookie }));
    expect(revokePage.status).toBe(200);
    expect(await revokePage.text()).toContain(jkt);
    const revokeBody = new URLSearchParams({ harness: 'codex', session_id: 'caller-label', proof_jkt: jkt,
      generation: '0', csrf_token: csrfTokenFor(owner.token), decision: 'revoke' });
    expect((await route(new Request(`${origin}${PROOF_KEY_REVOKE_PATH}`, {
      method: 'POST', headers: { origin, ...ownerCookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: revokeBody,
    }))).status).toBe(200);
    expect((await route(new Request(revokeUrl, { headers: ownerCookie }))).status).toBe(404);
  });
  it('authenticates the durable owner inbox across a composition restart without leaking another owner', async () => {
    const blobs = durableStores();
    const now = Date.parse('2026-09-28T12:00:00Z');
    const roomId = '!room:matrix.example.test';
    let membershipJoined = true;
    const matrixFetch: typeof fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/_matrix/client/v3/login') {
        const body = JSON.parse(String(init?.body)) as { identifier: { user: string }; device_id: string };
        return Response.json({ user_id: body.identifier.user, device_id: body.device_id, access_token: 'test-token' });
      }
      if (path.includes('/state/m.room.member/')) return membershipJoined
        ? Response.json({ membership: 'join' })
        : Response.json({ errcode: 'M_FORBIDDEN' }, { status: 403 });
      return Response.json({ errcode: 'M_NOT_FOUND' }, { status: 404 });
    };
    const control = createControlStore({ records: blobs.storeFor(`${env.CONTROL_STATE_NAMESPACE}-records`),
      operations: blobs.storeFor(`${env.CONTROL_STATE_NAMESPACE}-operations`), clock: () => now });
    const session = await createSession(control, () => new Uint8Array(32).fill(7), {
      ownerId: 'owner_1' as never,
      identity: { issuer: env.OIDC_ISSUER, subject: 'owner-one', verifiedEmail: 'one@example.test' },
      expiresAtMs: now + 3600_000,
    });
    expect(session.kind).toBe('created');
    if (session.kind !== 'created') throw new Error('session unavailable');
    const policy = createChannelAccessPolicy({ key: createHash('sha256')
      .update('khala.hosted.channel-access.policy.v1\0').update(env.INVITATION_HMAC_SECRET).digest() });
    const journal = createChannelAccessStore({ store: control, policy, clock: () => now });
    expect((await control.compareAndSet({
      key: `matrix.room-authority.v1.${createHash('sha256').update(roomId).digest('hex')}`,
      expectedRevision: null, operationId: 'claim-room-owner',
      next: { value: { v: 1, roomId, ownerId: 'owner_1' }, expiresAt: null },
    })).kind).toBe('applied');
    expect((await journal.create({ requester: 'agent-one', sessionFingerprint: 'a'.repeat(43),
      sessionGeneration: 1, origin, operationId: 'request-one', ownerId: 'owner_1',
      targetFingerprint: 'target-one', detail: { kind: 'access', authorizedChannelRef: roomId,
        targetRevision: 'revision-one', title: 'Owner one room' }, harness: 'codex',
      requesterLabel: 'Agent one', workspaceLabel: 'Workspace one' })).kind).toBe('accepted');
    const ownerRequests = await journal.listOwner({ ownerId: 'owner_1' });
    expect(ownerRequests.kind).toBe('found');
    if (ownerRequests.kind === 'found') {
      const projected = decodeChannelAccessOwnerProjection(projectOwner(ownerRequests.requests[0]!));
      if (!projected.ok) throw new Error(JSON.stringify(projected.error));
    }
    const route = createGateway({ registrations: registerHostedProductionRoutes({
      env: { ...env, KHALA_ADMISSION_MODE: 'explicit_browser_consent' }, stores: blobs.storeFor,
      clock: () => now, fetch: matrixFetch,
    }), absentPrefixes: [], appOrigin: origin });
    const inbox = `${origin}/api/human/channel-access/inbox`;
    expect((await route(new Request(inbox))).status).toBe(401);
    const headers = { cookie: `${SESSION_COOKIE}=${session.token}` };
    const response = await route(new Request(inbox, { headers }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ kind: 'ok', requests: [{ detail: { title: 'Owner one room' } }] });
    membershipJoined = false;
    expect((await route(new Request(inbox, { headers }))).status).toBe(503);
    membershipJoined = true;
    const authorityKey = `matrix.room-authority.v1.${createHash('sha256').update(roomId).digest('hex')}`;
    const currentAuthority = await control.read(authorityKey);
    expect(currentAuthority.kind).toBe('record');
    if (currentAuthority.kind !== 'record') throw new Error('room authority missing');
    expect((await control.compareAndSet({ key: authorityKey, expectedRevision: currentAuthority.record.revision,
      operationId: 'move-room-owner',
      next: { value: { v: 1, roomId, ownerId: 'owner_2' }, expiresAt: null },
    })).kind).toBe('applied');
    expect((await route(new Request(inbox, { headers }))).status).toBe(503);
    const other = await createSession(control, () => new Uint8Array(32).fill(8), {
      ownerId: 'owner_2' as never,
      identity: { issuer: env.OIDC_ISSUER, subject: 'owner-two', verifiedEmail: 'two@example.test' },
      expiresAtMs: now + 3600_000,
    });
    expect(other.kind).toBe('created');
    if (other.kind !== 'created') throw new Error('session unavailable');
    const restarted = createGateway({ registrations: registerHostedProductionRoutes({
      env: { ...env, KHALA_ADMISSION_MODE: 'explicit_browser_consent' }, stores: blobs.storeFor,
      clock: () => now, fetch: matrixFetch,
    }), absentPrefixes: [], appOrigin: origin });
    const second = await restarted(new Request(inbox, { headers: { cookie: `${SESSION_COOKIE}=${other.token}` } }));
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ v: 1, kind: 'ok', requests: [] });
    const denied = await restarted(new Request(`${origin}/api/human/channel-access/decision`, {
      method: 'POST', headers: { ...headers, origin: 'https://evil.example',
        'x-khala-csrf': csrfTokenFor(session.token), 'content-type': 'application/json' }, body: '{}',
    }));
    expect(denied.status).toBe(403);
    const sameOrigin = await restarted(new Request(`${origin}/api/human/channel-access/decision`, {
      method: 'POST', headers: { ...headers, origin,
        'x-khala-csrf': csrfTokenFor(session.token), 'content-type': 'application/json' }, body: '{}',
    }));
    expect(sameOrigin.status).toBe(503);
  });
  it('registers channel closure regardless of the unresolved admission mode', () => {
    for (const mode of [undefined, 'explicit_browser_consent']) {
      const routes = registerHostedProductionRoutes({ env: { ...env, KHALA_ADMISSION_MODE: mode }, stores });
      expect(routes.filter(route => route.path === '/api/human/channel-closure')).toHaveLength(1);
    }
  });
  it('keeps bootstrap and device attestation unavailable on other origins or with an invalid explicit mode', async () => {
    for (const [mode, appOrigin] of [[undefined, 'https://preview.example.test'], ['', origin], ['automatic_same_computer', origin], ['explicit_browser_consant', origin]] as const) {
      const route = gateway(mode, appOrigin);
      const descriptor = await route(new Request(`${appOrigin}/api/agent/bootstrap/descriptor?link=${encodeURIComponent(`${appOrigin}/join/inv_abcdefgh`)}`));
      const consent = await route(new Request(`${appOrigin}/api/human/agent-bootstrap/authorize`));
      expect(descriptor.status).toBe(503);
      expect(consent.status).toBe(503);
      expect((await route(new Request(`${appOrigin}/api/agent/device-attestation/challenge`))).status).toBe(503);
      expect((await route(new Request(`${appOrigin}/api/human/owner-device-proof/challenge?room_id=!room:matrix.example.test&device_id=OWNER`))).status).toBe(503);
      expect((await route(new Request(`${appOrigin}/api/human/channel-access/inbox`))).status).toBe(503);
    }
  });

  it('binds the real descriptor and explicit browser consent routes only in the exact mode', async () => {
    const route = gateway('explicit_browser_consent');
    const descriptor = await route(new Request(`${origin}/api/agent/bootstrap/descriptor?link=${encodeURIComponent(`${origin}/join/inv_abcdefgh`)}`));
    expect(descriptor.status).toBe(200);
    expect(await descriptor.json()).toMatchObject({ invite: 'inv_abcdefgh', methods: ['loopback-browser-v1'] });

    const query = new URLSearchParams({
      invite: 'inv_abcdefgh', harness: 'codex', session_id: 'existing-session', generation: '1',
      device_id: 'device_1', jkt: 'A'.repeat(43), redirect_uri: 'http://127.0.0.1:44881/callback',
      code_challenge: 'B'.repeat(43), code_challenge_method: 'S256', state: 'state-1234567890',
    });
    const consent = await route(new Request(`${origin}/api/human/agent-bootstrap/authorize?${query}`));
    expect(consent.status).toBe(303); // signed-out browser goes through the real OIDC entry
    expect(consent.headers.get('location')).toContain('/api/human/auth/login');
    expect(consent.headers.get('cache-control')).toBe('no-store');
    const ownerProof = await route(new Request(`${origin}/api/human/owner-device-proof/challenge?room_id=!room:matrix.example.test&device_id=OWNER`));
    expect(ownerProof.status).toBe(401);
  });
  it('enables explicit browser consent on the opted-in production origin when Netlify cannot set the flag', async () => {
    const route = gateway();
    const descriptor = await route(new Request(`${origin}/api/agent/bootstrap/descriptor?link=${encodeURIComponent(`${origin}/join/inv_abcdefgh`)}`));
    expect(descriptor.status).toBe(200);
    const revocation = await route(new Request(`${origin}/api/human/revocation/targets?roomId=!room:matrix.example.test`));
    expect(revocation.status).toBe(401);
    const send = await route(new Request(`${origin}/api/human/room-send/inspect`, { method: 'POST', headers: { origin } }));
    expect(send.status).toBe(400);
  });
});
