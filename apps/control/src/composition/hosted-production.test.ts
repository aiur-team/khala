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
import { createDigests } from '../invitations/internal';
import { registerHostedProductionRoutes } from './hosted-production';
import { createHostedDiscoveryBootstrap } from './hosted-discovery-bootstrap';
import { createHostedChannelRequester } from './human/hosted-channel-requester';
import { createProductionHumanRuntimeLoader } from './human/production';
import { thumbprint } from '../agent-bootstrap/proof';
import { PROOF_KEY_APPROVE_PATH, PROOF_KEY_CANDIDATE_PATH, PROOF_KEY_CHALLENGE_PATH,
  PROOF_KEY_REVOKE_PATH } from './hosted-proof-key-authority';
import type { HostedChannelAccessPorts } from './human/hosted-channel-access-routes';
import { connectorRequest, DIGEST, DEVICE } from '@khala/messaging/channel-access/exchange/journal-harness.test';

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
    expect((await gatewayRoute(request)).status).toBe(401);
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
      next: { value: { v: 1, roomId, ownerId: 'owner_2' }, expiresAt: null } })).kind).toBe('applied');
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
    // Owner 1 is a joined sponsor holding a personal link. Owner 2 created the
    // room; their inbox must stay empty even though the link points to it.
    const verifier = randomBytes(32).toString('base64url');
    const redirectUri = 'http://127.0.0.1:49152/khala/discovery/callback';
    const consent = new URLSearchParams({ redirect_uri: redirectUri, state: 'state-0123456789abcdef',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
      origin, harness: 'codex', session_id: 'caller-label', generation: '0', proof_jkt: jkt });
    const consentResponse = await route(new Request(`${origin}/api/human/channel-discovery/bootstrap/authorize`, {
      method: 'POST', headers: { origin, ...ownerCookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...Object.fromEntries(consent), csrf_token: csrfTokenFor(owner.token), decision: 'allow' }),
    }));
    expect(consentResponse.status).toBe(303);
    const code = new URL(consentResponse.headers.get('location')!).searchParams.get('code');
    expect(code).toBeTruthy();
    const signedProof = (method: 'GET' | 'POST', target: string, token?: string) => {
      const claims = { htm: method, htu: target, iat: Math.floor(now / 1000),
        jti: randomBytes(16).toString('base64url'),
        ...(token ? { ath: createHash('sha256').update(token).digest('base64url') } : {}) };
      const encoded = Buffer.from(JSON.stringify(claims)).toString('base64url');
      return `${header}.${encoded}.${sign(null, Buffer.from(`${header}.${encoded}`), privateKey).toString('base64url')}`;
    };
    const tokenPath = `${origin}/api/agent/channel-discovery/bootstrap/token`;
    const tokenResponse = await route(new Request(tokenPath, { method: 'POST',
      headers: { origin, 'content-type': 'application/json', dpop: signedProof('POST', tokenPath) },
      body: JSON.stringify({ grant_type: 'authorization_code', code, code_verifier: verifier,
        redirect_uri: redirectUri, harness: 'codex', session_id: 'caller-label', generation: 0 }),
    }));
    const tokenValue = await tokenResponse.json() as { credential: { credentialRef: string } };
    expect(tokenResponse.status, JSON.stringify(tokenValue)).toBe(200);
    const credential = tokenValue;
    const requestPath = `${origin}/api/agent/channel-access/request`;
    const creatorInviteRef = 'inv_creator_a';
    expect((await control.compareAndSet({ key: digests.inviteKey(creatorInviteRef), expectedRevision: null,
      operationId: 'create-a-link', next: { value: { v: 1, roomId, creatorOwnerId: 'owner_2',
        inviteRefDigest: digests.inviteRef(creatorInviteRef), policyRevision: 1,
        policy: { v: 1, kind: 'link', history: 'none' }, status: 'active', expiresAt: null,
        lastAuthorizedOperationDigest: null }, expiresAt: null } })).kind).toBe('applied');
    const wrongLink = await route(new Request(requestPath, { method: 'POST',
      headers: { origin, 'content-type': 'application/json', authorization: `DPoP ${credential.credential.credentialRef}`,
        dpop: signedProof('POST', requestPath, credential.credential.credentialRef) },
      body: JSON.stringify({ v: 1, kind: 'channel_url', operationId: 'b-agent-wrong-link',
        credentialRef: credential.credential.credentialRef, channelUrl: `${origin}/join/${creatorInviteRef}` }),
    }));
    expect(wrongLink.status).toBe(200);
    expect(await wrongLink.json()).toMatchObject({ outcome: 'unavailable' });
    const accessRequest = await route(new Request(requestPath, { method: 'POST',
      headers: { origin, 'content-type': 'application/json', authorization: `DPoP ${credential.credential.credentialRef}`,
        dpop: signedProof('POST', requestPath, credential.credential.credentialRef) },
      body: JSON.stringify({ v: 1, kind: 'channel_url', operationId: 'b-agent-request',
        credentialRef: credential.credential.credentialRef, channelUrl: link }),
    }));
    expect(accessRequest.status).toBe(200);
    expect(await accessRequest.json()).toMatchObject({ outcome: 'pending_owner' });
    // A stale row must not make the sponsor's entire inbox unavailable.
    const staleInviteRef = 'inv_stale_b';
    const staleInviteKey = digests.inviteKey(staleInviteRef);
    const staleInvite = { v: 1, roomId, creatorOwnerId: 'owner_1',
      inviteRefDigest: digests.inviteRef(staleInviteRef), policyRevision: 1,
      policy: { v: 1, kind: 'link', history: 'none' }, status: 'active', expiresAt: null,
      lastAuthorizedOperationDigest: null };
    expect((await control.compareAndSet({ key: staleInviteKey, expectedRevision: null,
      operationId: 'create-stale-link', next: { value: staleInvite, expiresAt: null } })).kind).toBe('applied');
    const staleRequest = await route(new Request(requestPath, { method: 'POST',
      headers: { origin, 'content-type': 'application/json', authorization: `DPoP ${credential.credential.credentialRef}`,
        dpop: signedProof('POST', requestPath, credential.credential.credentialRef) },
      body: JSON.stringify({ v: 1, kind: 'channel_url', operationId: 'b-agent-stale',
        credentialRef: credential.credential.credentialRef, channelUrl: `${origin}/join/${staleInviteRef}` }),
    }));
    expect(await staleRequest.json()).toMatchObject({ outcome: 'pending_owner' });
    const staleRecord = await control.read(staleInviteKey);
    if (staleRecord.kind !== 'record') throw new Error('stale invite missing');
    expect((await control.compareAndSet({ key: staleInviteKey, expectedRevision: staleRecord.record.revision,
      operationId: 'revoke-stale-link', next: { value: { ...staleInvite, status: 'revoked' }, expiresAt: null } })).kind)
      .toBe('applied');
    const restarted = createGateway({ registrations: registerHostedProductionRoutes({
      env: { ...env, KHALA_ADMISSION_MODE: 'explicit_browser_consent' }, stores: blobs.storeFor,
      clock: () => now, fetch: matrixFetch,
    }), absentPrefixes: [], appOrigin: origin });
    const inboxPath = `${origin}/api/human/channel-access/inbox`;
    const sponsorInbox = await restarted(new Request(inboxPath, { headers: ownerCookie }));
    expect(sponsorInbox.status).toBe(200);
    const sponsorRequests = await sponsorInbox.json() as { requests: { requestHandle: string; revision: string }[] };
    expect(sponsorRequests.requests).toHaveLength(1);
    const accessPolicy = createChannelAccessPolicy({ key: createHash('sha256')
      .update('khala.hosted.channel-access.policy.v1\0').update(env.INVITATION_HMAC_SECRET).digest() });
    const accessJournal = createChannelAccessStore({ store: control, policy: accessPolicy, clock: () => now });
    const sponsorRows = await accessJournal.listOwner({ ownerId: 'owner_1' });
    expect(sponsorRows.kind).toBe('found');
    if (sponsorRows.kind === 'found') expect(sponsorRows.requests.map(row => row.outcome).sort())
      .toEqual(['pending_owner', 'revoked']);
    const roomCreatorInbox = await restarted(new Request(inboxPath, {
      headers: { cookie: `${SESSION_COOKIE}=${other.token}` },
    }));
    expect(roomCreatorInbox.status).toBe(200);
    expect((await roomCreatorInbox.json() as { requests: unknown[] }).requests).toHaveLength(0);
    const wrongDecision = await restarted(new Request(`${origin}/api/human/channel-access/decision`, {
      method: 'POST', headers: { origin, cookie: `${SESSION_COOKIE}=${other.token}`,
        'content-type': 'application/json', 'x-khala-csrf': csrfTokenFor(other.token) },
      body: JSON.stringify({ v: 1, requestHandle: sponsorRequests.requests[0]!.requestHandle,
        expectedRevision: sponsorRequests.requests[0]!.revision, decision: 'approve', operationId: 'wrong-owner' }),
    }));
    expect(wrongDecision.status).toBe(404);
    const decision = await restarted(new Request(`${origin}/api/human/channel-access/decision`, {
      method: 'POST', headers: { origin, ...ownerCookie, 'content-type': 'application/json',
        'x-khala-csrf': csrfTokenFor(owner.token) },
      body: JSON.stringify({ v: 1, requestHandle: sponsorRequests.requests[0]!.requestHandle,
        expectedRevision: sponsorRequests.requests[0]!.revision, decision: 'approve', operationId: 'b-approval' }),
    }));
    expect(decision.status).toBe(200);
    expect(await decision.json()).toMatchObject({ outcome: 'approved' });
    const statusPath = `${origin}/api/agent/channel-access/status?v=1&operationId=b-agent-request&operationKind=access`;
    const status = await restarted(new Request(statusPath, { headers: {
      authorization: `DPoP ${credential.credential.credentialRef}`,
      dpop: signedProof('GET', statusPath, credential.credential.credentialRef),
    } }));
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ outcome: 'approved' });
    const active = createProductionHumanRuntimeLoader({
      env: { ...env, KHALA_ADMISSION_MODE: 'explicit_browser_consent' }, stores: blobs.storeFor,
      clock: () => now, fetch: matrixFetch,
    })();
    const signedRequester = createHostedChannelRequester(active, createHostedDiscoveryBootstrap({
      env: { ...env, KHALA_ADMISSION_MODE: 'explicit_browser_consent' }, stores: blobs.storeFor,
      clock: () => now, fetch: matrixFetch,
    }).authorize);
    const authenticated = await signedRequester.authenticateAgent(new Request(statusPath, { headers: {
      authorization: `DPoP ${credential.credential.credentialRef}`,
      dpop: signedProof('GET', statusPath, credential.credential.credentialRef),
    } }));
    expect(authenticated.kind).toBe('authenticated');
    if (authenticated.kind !== 'authenticated') throw new Error('signed requester missing');
    const admission = { providerOperationId: 'proof-bound-admission', ownerId: 'owner_1' as never,
      channelRef: digests.inviteKey(inviteRef) as never, requester: authenticated.context.principal,
      sessionGeneration: authenticated.context.sessionGeneration,
      sessionFingerprint: authenticated.context.sessionFingerprint, deviceId: 'DEVICE_B' as never,
      history: 'none' as const };
    expect(await signedRequester.admissionAuthority.current(admission)).toBe('current');
    expect(await signedRequester.admissionAuthority.current({ ...admission, ownerId: 'owner_2' as never }))
      .toBe('revoked');
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
    expect(await signedRequester.admissionAuthority.current(admission)).toBe('revoked');
    const afterRevocation = await restarted(new Request(statusPath, { headers: {
      authorization: `DPoP ${credential.credential.credentialRef}`,
      dpop: signedProof('GET', statusPath, credential.credential.credentialRef),
    } }));
    expect(afterRevocation.status).toBe(401);
  });
  it('uses live invite and Matrix owner checks for a staged request and decision', async () => {
    const blobs = durableStores();
    const now = Date.parse('2026-09-25T12:00:00Z');
    const roomId = '!room:matrix.example.test';
    const inviteRef = 'invite_12345678';
    const digests = createDigests(env.INVITATION_HMAC_SECRET);
    const control = createControlStore({ records: blobs.storeFor(`${env.CONTROL_STATE_NAMESPACE}-records`),
      operations: blobs.storeFor(`${env.CONTROL_STATE_NAMESPACE}-operations`), clock: () => now });
    const session = await createSession(control, () => new Uint8Array(32).fill(7), {
      ownerId: 'owner_1' as never,
      identity: { issuer: env.OIDC_ISSUER, subject: 'owner-one', verifiedEmail: 'one@example.test' },
      expiresAtMs: now + 3600_000,
    });
    if (session.kind !== 'created') throw new Error('session unavailable');
    expect((await control.compareAndSet({ key: digests.inviteKey(inviteRef), expectedRevision: null,
      operationId: 'share_1', next: { value: { v: 1, roomId, creatorOwnerId: 'owner_1',
        inviteRefDigest: digests.inviteRef(inviteRef), policyRevision: 1,
        policy: { v: 1, kind: 'link', history: 'none' }, status: 'active', expiresAt: null,
        lastAuthorizedOperationDigest: null }, expiresAt: null } })).kind).toBe('applied');
    expect((await control.compareAndSet({ key: `matrix.room-authority.v1.${createHash('sha256').update(roomId).digest('hex')}`,
      expectedRevision: null, operationId: 'claim-room-owner',
      next: { value: { v: 1, roomId, ownerId: 'owner_1' }, expiresAt: null } })).kind).toBe('applied');
    const matrixFetch: typeof fetch = async (resource, init) => {
      const path = new URL(String(resource)).pathname;
      if (path === '/_matrix/client/v3/login') {
        const body = JSON.parse(String(init?.body)) as { identifier: { user: string }; device_id: string };
        return Response.json({ user_id: body.identifier.user, device_id: body.device_id, access_token: 'test-token' });
      }
      if (path.includes('/state/m.room.member/')) return Response.json({ membership: 'join' });
      return Response.json({ errcode: 'M_NOT_FOUND' }, { status: 404 });
    };
    const requester = { principal: `agent_${'a'.repeat(43)}` as never, origin,
      proofKey: { algorithm: 'Ed25519' as const, publicKey: 'b'.repeat(43), thumbprint: 'a'.repeat(43) },
      sessionGeneration: 2 };
    const context = { v: 1 as const, principal: requester.principal, origin, sessionGeneration: 2,
      sessionFingerprint: requester.proofKey.thumbprint, harness: 'proof-key',
      displayLabel: null, workspaceLabel: null };
    let inviteUnavailable = false;
    const storeFor = (name: string): BlobsStoreLike => {
      const store = blobs.storeFor(name);
      return {
        getWithMetadata: (key, options) => inviteUnavailable && key === digests.inviteKey(inviteRef)
          ? Promise.reject(new Error('temporary Blobs failure')) : store.getWithMetadata(key, options),
        setJSON: (key, data, options) => store.setJSON(key, data, options),
      };
    };
    const channelAccess: HostedChannelAccessPorts = {
      authenticateAgent: async () => ({ kind: 'authenticated', requester, context }),
      requesterAuthority: {
        inspect: async (_requester, ownerId) => ownerId === 'owner_1' ? 'current' : 'revoked',
        inspectContext: async (_context, ownerId) => ownerId === 'owner_1' ? 'current' : 'revoked',
        checkContext: async () => 'current',
      },
    };
    const routes = () => createGateway({ registrations: registerHostedProductionRoutes({
      env: { ...env, KHALA_ADMISSION_MODE: 'explicit_browser_consent' }, stores: storeFor,
      clock: () => now, fetch: matrixFetch, channelAccess,
    }), absentPrefixes: [], appOrigin: origin });
    const request = await routes()(new Request(`${origin}/api/agent/channel-access/request`, {
      method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({ v: 1, kind: 'channel_url', operationId: 'op_real_target',
        credentialRef: 'credential_1', channelUrl: `${origin}/join/${inviteRef}` }),
    }));
    expect(await request.json()).toEqual({ v: 1, operationId: 'op_real_target', outcome: 'pending_owner' });
    const restarted = routes();
    const ownerHeaders = { cookie: `${SESSION_COOKIE}=${session.token}` };
    const inbox = await restarted(new Request(`${origin}/api/human/channel-access/inbox`, { headers: ownerHeaders }));
    expect(inbox.status).toBe(200);
    const listed = await inbox.json() as { requests: { requestHandle: string; revision: string }[] };
    expect(listed.requests).toHaveLength(1);
    const approve = () => restarted(new Request(`${origin}/api/human/channel-access/decision`, {
      method: 'POST', headers: { ...ownerHeaders, origin, 'content-type': 'application/json',
        'x-khala-csrf': csrfTokenFor(session.token) },
      body: JSON.stringify({ v: 1, requestHandle: listed.requests[0]!.requestHandle,
        expectedRevision: listed.requests[0]!.revision, decision: 'approve', operationId: 'owner_approve_1' }),
    }));
    inviteUnavailable = true;
    expect((await approve()).status).toBe(503);
    inviteUnavailable = false;
    const decision = await approve();
    expect(decision.status).toBe(200);
    expect(await decision.json()).toMatchObject({ outcome: 'approved' });
    expect((await restarted(new Request(`${origin}/api/agent/channel-access/exchange`, {
      method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}',
    }))).status).toBe(503);
  });
  it('runs request, owner decision and one exchange across durable restart with exact authority', async () => {
    const blobs = durableStores();
    const now = Date.parse('2026-09-25T12:00:00Z');
    const roomId = '!room:matrix.example.test';
    const control = createControlStore({
      records: blobs.storeFor(`${env.CONTROL_STATE_NAMESPACE}-records`),
      operations: blobs.storeFor(`${env.CONTROL_STATE_NAMESPACE}-operations`),
      clock: () => now,
    });
    const session = await createSession(control, () => new Uint8Array(32).fill(7), {
      ownerId: 'owner_1' as never,
      identity: { issuer: env.OIDC_ISSUER, subject: 'owner-one', verifiedEmail: 'one@example.test' },
      expiresAtMs: now + 3600_000,
    });
    expect(session.kind).toBe('created');
    if (session.kind !== 'created') throw new Error('session unavailable');
    expect((await control.compareAndSet({
      key: `matrix.room-authority.v1.${createHash('sha256').update(roomId).digest('hex')}`,
      expectedRevision: null, operationId: 'claim-room-owner',
      next: { value: { v: 1, roomId, ownerId: 'owner_1' }, expiresAt: null },
    })).kind).toBe('applied');
    const matrixFetch: typeof fetch = async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/_matrix/client/v3/login') {
        const body = JSON.parse(String(init?.body)) as { identifier: { user: string }; device_id: string };
        return Response.json({ user_id: body.identifier.user, device_id: body.device_id, access_token: 'test-token' });
      }
      if (path.includes('/state/m.room.member/')) return Response.json({ membership: 'join' });
      return Response.json({ errcode: 'M_NOT_FOUND' }, { status: 404 });
    };
    const requester = {
      principal: 'principal_1' as never, origin,
      proofKey: { algorithm: 'Ed25519' as const, publicKey: 'b'.repeat(43), thumbprint: 'c'.repeat(43) },
      sessionGeneration: 3,
    };
    const context = {
      v: 1 as const, principal: requester.principal, origin, sessionGeneration: 3,
      sessionFingerprint: DIGEST, harness: 'codex', displayLabel: 'Build agent', workspaceLabel: 'Khala',
    };
    const exchangeBody = await connectorRequest({ origin }, now);
    const admitted = new Set<string>();
    const ports: HostedChannelAccessPorts = {
      authenticateAgent: async request => request.headers.get('authorization') === 'Bearer exact-test-session'
        ? { kind: 'authenticated', requester, context } : { kind: 'rejected', code: 'auth_required' },
      authenticateConnector: async request => request.headers.get('authorization') === 'Bearer exact-test-connector'
        ? { kind: 'authenticated', connector: {
          requester: requester.principal, origin, sessionGeneration: 3, sessionFingerprint: DIGEST,
          deviceId: DEVICE, proofKeyThumbprint: exchangeBody.proofKey.thumbprint,
        } } : { kind: 'rejected', code: 'auth_required' },
      resolver: () => ({
        async resolveAccess() {
          return { kind: 'resolved', ownerId: 'owner_1' as never, channelRef: roomId as never,
            targetRevision: `matrix:${roomId}`, title: 'Owner room' };
        },
        async resolveCreate() { return { kind: 'unavailable' }; },
        async revalidateAccess() {
          return { kind: 'current', ownerId: 'owner_1' as never, targetRevision: `matrix:${roomId}`, title: 'Owner room' };
        },
        async revalidateCreate() { return { kind: 'unavailable' }; },
        async currentAccessOwner() {
          return { kind: 'owned', ownerId: 'owner_1' as never, targetRevision: `matrix:${roomId}` };
        },
        async checkRequester() { return { kind: 'current' }; },
      }),
      provider: {
        async admit(input) {
          const membership = admitted.has(input.providerOperationId) ? 'already_joined' : 'joined';
          admitted.add(input.providerOperationId);
          return { kind: 'admitted', membership };
        },
        async reconcile(input) {
          return admitted.has(input.providerOperationId)
            ? { kind: 'admitted', membership: 'joined' } : { kind: 'not_applied' };
        },
      },
      bindings: { async resumeAdapterCapability() { return { kind: 'refused', code: 'binding_revoked' }; } },
    };
    const route = () => createGateway({ registrations: registerHostedProductionRoutes({
      env: { ...env, KHALA_ADMISSION_MODE: 'explicit_browser_consent' }, stores: blobs.storeFor,
      clock: () => now, fetch: matrixFetch, channelAccess: ports,
    }), absentPrefixes: [], appOrigin: origin });
    const first = route();
    const requestUrl = `${origin}/api/agent/channel-access/request`;
    const requestBody = {
      v: 1, kind: 'listing_ref', operationId: 'op_access_1',
      credentialRef: 'credential_1', listingRef: 'listing_1',
    };
    const postRequest = (body: unknown, authorization = 'Bearer exact-test-session') => first(new Request(requestUrl, {
      method: 'POST', headers: { 'content-type': 'application/json', origin, authorization }, body: JSON.stringify(body),
    }));
    expect((await postRequest(requestBody, '')).status).toBe(401);
    expect((await postRequest({ ...requestBody, ownerId: 'owner_2' })).status).toBe(400);
    expect((await postRequest({ ...requestBody, operationId: 3 })).status).toBe(400);
    const foreign = createGateway({ registrations: registerHostedProductionRoutes({
      env: { ...env, KHALA_ADMISSION_MODE: 'explicit_browser_consent' }, stores: blobs.storeFor,
      clock: () => now, fetch: matrixFetch,
      channelAccess: { ...ports, authenticateAgent: async () => ({
        kind: 'authenticated', requester: { ...requester, origin: 'https://evil.example' }, context,
      }) },
    }), absentPrefixes: [], appOrigin: origin });
    expect((await foreign(new Request(requestUrl, { method: 'POST',
      headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify(requestBody),
    }))).status).toBe(403);
    expect(await (await postRequest(requestBody)).json()).toEqual({
      v: 1, operationId: 'op_access_1', outcome: 'pending_owner',
    });
    const restarted = route();
    const ownerHeaders = { cookie: `${SESSION_COOKIE}=${session.token}` };
    const inbox = await restarted(new Request(`${origin}/api/human/channel-access/inbox`, { headers: ownerHeaders }));
    expect(inbox.status).toBe(200);
    const projection = await inbox.json() as { requests: { requestHandle: string; revision: string }[] };
    expect(projection.requests).toHaveLength(1);
    const decisionUrl = `${origin}/api/human/channel-access/decision`;
    const decision = {
      v: 1, requestHandle: projection.requests[0]!.requestHandle,
      expectedRevision: projection.requests[0]!.revision, decision: 'approve', operationId: 'owner-decision-1',
    };
    const ownerPost = (requestOrigin: string, csrf: string) => restarted(new Request(decisionUrl, {
      method: 'POST', headers: { ...ownerHeaders, origin: requestOrigin, 'content-type': 'application/json',
        'x-khala-csrf': csrf }, body: JSON.stringify(decision),
    }));
    expect((await ownerPost('https://evil.example', csrfTokenFor(session.token))).status).toBe(403);
    expect((await ownerPost(origin, 'wrong')).status).toBe(403);
    const otherOwner = await createSession(control, () => new Uint8Array(32).fill(8), {
      ownerId: 'owner_2' as never,
      identity: { issuer: env.OIDC_ISSUER, subject: 'owner-two', verifiedEmail: 'two@example.test' },
      expiresAtMs: now + 3600_000,
    });
    expect(otherOwner.kind).toBe('created');
    if (otherOwner.kind !== 'created') throw new Error('other session unavailable');
    const crossOwner = await restarted(new Request(decisionUrl, {
      method: 'POST', headers: { cookie: `${SESSION_COOKIE}=${otherOwner.token}`, origin,
        'content-type': 'application/json', 'x-khala-csrf': csrfTokenFor(otherOwner.token) },
      body: JSON.stringify(decision),
    }));
    expect(crossOwner.status).toBe(404);
    const approved = await ownerPost(origin, csrfTokenFor(session.token));
    expect(approved.status).toBe(200);
    expect(await approved.json()).toMatchObject({ outcome: 'approved' });
    const status = await restarted(new Request(
      `${origin}/api/agent/channel-access/status?v=1&operationId=op_access_1&operationKind=access`,
      { headers: { authorization: 'Bearer exact-test-session' } },
    ));
    expect(await status.json()).toEqual({ v: 1, operationId: 'op_access_1', outcome: 'approved' });
    const mute = await restarted(new Request(`${origin}/api/human/channel-access/mute`, {
      method: 'POST', headers: { ...ownerHeaders, origin, 'content-type': 'application/json',
        'x-khala-csrf': csrfTokenFor(session.token) },
      body: JSON.stringify({ v: 1, requestHandle: decision.requestHandle,
        expectedRevision: null, action: 'mute', operationId: 'owner-mute-1' }),
    }));
    expect(mute.status).toBe(200);
    expect(await mute.json()).toMatchObject({ muted: true });
    const exchangeUrl = `${origin}/api/agent/channel-access/exchange?operation=op_access_1`;
    const exchange = (authorization: string) => restarted(new Request(exchangeUrl, {
      method: 'POST', headers: { authorization, origin, 'content-type': 'application/json' },
      body: JSON.stringify(exchangeBody),
    }));
    expect((await exchange('')).status).toBe(401);
    const wrongOrigin = await restarted(new Request(exchangeUrl, {
      method: 'POST', headers: { authorization: 'Bearer exact-test-connector', origin: 'https://evil.example',
        'content-type': 'application/json' }, body: JSON.stringify(exchangeBody),
    }));
    expect(wrongOrigin.status).toBe(403);
    const envelope = await exchange('Bearer exact-test-connector');
    expect(envelope.status).toBe(200);
    const bytes = await envelope.text();
    expect(JSON.parse(bytes)).toMatchObject({ v: 1, recipientKeyThumbprint: exchangeBody.encryptionKey.thumbprint });
    expect(await (await exchange('Bearer exact-test-connector')).text()).toBe(bytes);
    expect(admitted.size).toBe(1);
    expect((await restarted(new Request(`${origin}/api/agent/channel-access/resume?operation=op_access_1`, {
      method: 'POST', headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    }))).status).toBe(401);
  });
  it('authenticates the durable owner inbox across a composition restart without leaking another owner', async () => {
    const blobs = durableStores();
    let blockReconciliation = false;
    const storeFor: typeof blobs.storeFor = name => {
      const store = blobs.storeFor(name);
      return {
        ...store,
        async setJSON(key, data, options) {
          if (blockReconciliation && key === 'channel-access.journal.v1') {
            throw Object.assign(new Error('journal write blocked'), { status: 403 });
          }
          return store.setJSON(key, data, options);
        },
      };
    };
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
      env: { ...env, KHALA_ADMISSION_MODE: 'explicit_browser_consent' }, stores: storeFor,
      clock: () => now, fetch: matrixFetch,
    }), absentPrefixes: [], appOrigin: origin });
    const inbox = `${origin}/api/human/channel-access/inbox`;
    expect((await route(new Request(inbox))).status).toBe(401);
    const headers = { cookie: `${SESSION_COOKIE}=${session.token}` };
    const response = await route(new Request(inbox, { headers }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ kind: 'ok', requests: [{ detail: { title: 'Owner one room' } }] });
    const createExtra = (index: number) => journal.create({ requester: 'agent-one',
      sessionFingerprint: 'a'.repeat(43), sessionGeneration: 1, origin,
      operationId: `request-${index}`, ownerId: 'owner_1', targetFingerprint: `target-${index}`,
      detail: { kind: 'access', authorizedChannelRef: roomId, targetRevision: `revision-${index}`,
        title: `Owner room ${index}` }, harness: 'codex', requesterLabel: 'Agent one', workspaceLabel: null });
    for (let index = 2; index <= 5; index += 1) {
      expect((await createExtra(index)).kind).toBe('accepted');
    }
    expect((await createExtra(6)).kind).toBe('unavailable');
    membershipJoined = false;
    blockReconciliation = true;
    expect((await route(new Request(inbox, { headers }))).status).toBe(503);
    blockReconciliation = false;
    expect(await (await route(new Request(inbox, { headers }))).json()).toMatchObject({ kind: 'ok', requests: [] });
    const reconciled = await journal.listOwner({ ownerId: 'owner_1' });
    expect(reconciled.kind).toBe('found');
    if (reconciled.kind === 'found') expect(reconciled.requests.map(row => row.outcome))
      .toEqual(['revoked', 'revoked', 'revoked', 'revoked', 'revoked']);
    expect((await createExtra(6)).kind).toBe('accepted');
    membershipJoined = true;
    const authorityKey = `matrix.room-authority.v1.${createHash('sha256').update(roomId).digest('hex')}`;
    const currentAuthority = await control.read(authorityKey);
    expect(currentAuthority.kind).toBe('record');
    if (currentAuthority.kind !== 'record') throw new Error('room authority missing');
    expect((await control.compareAndSet({ key: authorityKey, expectedRevision: currentAuthority.record.revision,
      operationId: 'move-room-owner',
      next: { value: { v: 1, roomId, ownerId: 'owner_2' }, expiresAt: null },
    })).kind).toBe('applied');
    expect(await (await route(new Request(inbox, { headers }))).json()).toMatchObject({ kind: 'ok', requests: [] });
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
    expect(sameOrigin.status).toBe(400);
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
