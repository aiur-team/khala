import { createHash, createPublicKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { AuthPrincipal, OwnerId, StableAgentPrincipal } from '@khala/contracts/messaging/index';
import { T0, fakeStore, secureRandom } from '../auth/support.test';
import { thumbprint } from '../agent-bootstrap/proof';
import { AUTHORIZE_PATH, CREDENTIAL_TTL_MS, TOKEN_PATH, createChannelDiscoveryBootstrapHandlers } from './bootstrap/handler';
import { ALLOWLIST_PATH, LIST_PATH, SETTINGS_PATH, createChannelDiscoveryHandlers } from './handler';

const ORIGIN = 'https://khala.aiur.team';
const REDIRECT_URI = 'http://127.0.0.1:49152/khala/discovery/callback';
const SESSION = { harness: 'codex', session_id: 'thread-b', generation: 3 };

function owner(ownerId: string): AuthPrincipal {
  return {
    v: 1, ownerId: ownerId as OwnerId, providerIssuer: 'https://id.example.test', providerSubject: `sub-${ownerId}`,
    verifiedEmail: `${ownerId}@example.test`, sessionExpiresAt: '2026-09-18T20:00:00Z',
  };
}

/** Real RD2A credential issuance and validation composed with the discovery routes on one store. */
function setup() {
  let now = T0;
  const clock = () => now;
  const store = fakeStore(clock);
  let authority: 'verified' | 'rebound' | 'removed' = 'verified';
  let generation = SESSION.generation;
  const bootstrap = createChannelDiscoveryBootstrapHandlers({
    origin: ORIGIN, store: store.store, clock, random: secureRandom,
    async authenticate() {
      return { kind: 'authenticated', context: { principal: owner('owner_b'), csrfToken: 'csrf' } };
    },
    sessionAuthority: {
      async inspect() {
        return authority === 'verified'
          ? { kind: 'verified', principal: 'agent_b' as StableAgentPrincipal, currentGeneration: generation }
          : { kind: authority };
      },
    },
    trustedSource: async () => ({ kind: 'trusted', source: 'edge:test' }),
    limiter: {
      reserve: async () => ({ kind: 'reserved', permit: { permitId: randomBytes(8).toString('hex') } }),
      finalize: async input => (input.disposition === 'release' ? { kind: 'released' } : { kind: 'finalized' }),
    },
  });
  const discovery = createChannelDiscoveryHandlers({
    store: store.store, clock, random: secureRandom, credentials: bootstrap.credentials, publicDiscovery: 'enabled',
    authorizeMutation: async request => ({ kind: 'authorized', context: { principal: owner(request.headers.get('x-owner')!), csrfToken: 'csrf' } }),
    ownerAuthority: { canManage: async ({ ownerId }) => (ownerId === 'owner_a' ? 'allowed' : 'forbidden') },
    principals: { inspect: async () => ({ kind: 'known', agentOwnerId: 'owner_b' as OwnerId, currentGeneration: generation }) },
  });

  const { privateKey } = generateKeyPairSync('ed25519');
  const x = createPublicKey(privateKey).export({ format: 'jwk' }).x!;
  function proof(method: string, url: string, accessToken?: string) {
    const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'dpop+jwt', jwk: { kty: 'OKP', crv: 'Ed25519', x } })).toString('base64url');
    const claims: Record<string, unknown> = { htm: method, htu: url, iat: Math.floor(clock() / 1000), jti: randomBytes(16).toString('base64url') };
    if (accessToken) claims.ath = createHash('sha256').update(accessToken).digest('base64url');
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${header}.${payload}.${sign(null, Buffer.from(`${header}.${payload}`), privateKey).toString('base64url')}`;
  }

  async function credential(): Promise<string> {
    const verifier = randomBytes(32).toString('base64url');
    const form = new URLSearchParams({
      redirect_uri: REDIRECT_URI, state: 'state-0123456789abcdef', code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256', origin: ORIGIN, harness: SESSION.harness, session_id: SESSION.session_id,
      generation: String(generation), proof_jkt: thumbprint(x), csrf_token: 'csrf', decision: 'allow',
    });
    const consent = await bootstrap.human[0]!.handle(new Request(`${ORIGIN}${AUTHORIZE_PATH}`, {
      method: 'POST', body: form,
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: ORIGIN, 'sec-fetch-site': 'same-origin' },
    }));
    const code = new URL(consent.headers.get('location')!).searchParams.get('code')!;
    const token = await bootstrap.agent[0]!.handle(new Request(`${ORIGIN}${TOKEN_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', dpop: proof('POST', `${ORIGIN}${TOKEN_PATH}`) },
      body: JSON.stringify({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT_URI, ...SESSION, generation }),
    }));
    return (await token.json() as { credential: { credentialRef: string } }).credential.credentialRef;
  }

  function list(credentialRef: string, requestOrigin = ORIGIN, proofOrigin = requestOrigin) {
    return discovery.agent[0]!.handle(new Request(`${requestOrigin}${LIST_PATH}`, {
      headers: { authorization: `DPoP ${credentialRef}`, dpop: proof('GET', `${proofOrigin}${LIST_PATH}`, credentialRef) },
    }));
  }

  async function publish(visibility = 'public') {
    const response = await discovery.human[0]!.handle(new Request(`${ORIGIN}${SETTINGS_PATH}`, {
      method: 'PUT', headers: { 'content-type': 'application/json', 'x-owner': 'owner_a' },
      body: JSON.stringify({ v: 1, operationId: 'publish', roomId: '!room_a', visibility, title: 'Alpha', expectedRevision: null }),
    }));
    expect(response.status).toBe(200);
  }

  async function allow() {
    const response = await discovery.human[1]!.handle(new Request(`${ORIGIN}${ALLOWLIST_PATH}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-owner': 'owner_a' },
      body: JSON.stringify({
        v: 1, action: 'allow', operationId: 'allow', roomId: '!room_a', principal: 'agent_b',
        expectedSessionGeneration: generation, expectedRevision: '1',
      }),
    }));
    expect(response.status).toBe(200);
  }

  return { list, credential, publish, allow, rebind() { generation += 1; }, advance(ms: number) { now += ms; }, setAuthority(next: typeof authority) { authority = next; } };
}

describe('external discovery with a real bootstrap credential', () => {
  it('lists with a live sender-constrained credential and refuses it after expiry', async () => {
    const h = setup();
    await h.publish();
    const credentialRef = await h.credential();
    const response = await h.list(credentialRef);
    expect(response.status).toBe(200);
    expect((await response.json() as { items: Array<{ title: string }> }).items.map(item => item.title)).toEqual(['Alpha']);
    h.advance(CREDENTIAL_TTL_MS);
    const expired = await h.list(credentialRef);
    expect(expired.status).toBe(401);
    expect(await expired.json()).toEqual({ error: 'invalid_credential' });
  });

  it.each(['rebound', 'removed'] as const)('refuses the credential after the session is %s', async state => {
    const h = setup();
    await h.publish();
    const credentialRef = await h.credential();
    h.setAuthority(state);
    expect((await h.list(credentialRef)).status).toBe(401);
  });

  it('invalidates the old credential on rebind while the stable allowlist admits the new generation', async () => {
    const h = setup();
    await h.publish('private');
    await h.allow();
    const before = await h.credential();
    const listed = await h.list(before);
    expect((await listed.json() as { items: Array<{ title: string }> }).items.map(item => item.title)).toEqual(['Alpha']);

    h.rebind();
    const stale = await h.list(before);
    expect(stale.status).toBe(401);
    expect(await stale.json()).toEqual({ error: 'invalid_credential' });
    const after = await h.list(await h.credential());
    expect(after.status).toBe(200);
    expect((await after.json() as { items: Array<{ title: string }> }).items.map(item => item.title)).toEqual(['Alpha']);
  });

  it('refuses requests addressed to another origin and never redirects', async () => {
    const h = setup();
    await h.publish();
    const credentialRef = await h.credential();
    const foreign = await h.list(credentialRef, 'https://attacker.example');
    expect(foreign.status).toBe(401);
    expect(await foreign.json()).toEqual({ error: 'proof_target_mismatch' });
    expect(foreign.headers.get('location')).toBeNull();
    const wrongProof = await h.list(credentialRef, ORIGIN, 'https://attacker.example');
    expect(wrongProof.status).toBe(401);
    expect(wrongProof.headers.get('location')).toBeNull();
  });
});
