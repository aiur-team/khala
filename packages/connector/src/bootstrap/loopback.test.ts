// The loopback method runs a real 127.0.0.1 listener; the "browser" is a
// fetch against the redirect it would follow. The service is a fake transport.

import { createHash, generateKeyPairSync, verify, createPublicKey } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AUTHORIZE_PATH, type BootstrapDescriptor, REDEEM_PATH, TOKEN_PATH } from './descriptor';
import { createHttpAdmission, createLoopbackOwnership } from './loopback';
import { createProofSigner } from './proof';

const ORIGIN = 'https://khala.example';
const T0 = Date.parse('2026-09-18T12:00:00Z');
const DESCRIPTOR: BootstrapDescriptor = {
  v: 1, invite: 'room-invite', methods: ['loopback-browser-v1'],
  authorize: `${ORIGIN}${AUTHORIZE_PATH}`, token: `${ORIGIN}${TOKEN_PATH}`, redeem: `${ORIGIN}${REDEEM_PATH}`,
};
const SESSION = { harness: 'codex', sessionId: 'thread-existing-b', generation: 3 };
const signer = createProofSigner(generateKeyPairSync('ed25519').privateKey, () => T0);

type Call = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

function service(reply: (call: Call) => { status: number; body?: unknown }) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const call = { url: String(url), headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) };
    calls.push(call);
    const { status, body } = reply(call);
    return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** Plays the owner's browser: reads the authorize URL and follows the service's redirect. */
function ownerBrowser(outcome: 'approve' | 'deny' | 'wrong_state' | 'ignore', seen: URL[] = []) {
  return async (url: string) => {
    const authorize = new URL(url);
    seen.push(authorize);
    if (outcome === 'ignore') return;
    const redirect = new URL(authorize.searchParams.get('redirect_uri')!);
    redirect.searchParams.set('state', outcome === 'wrong_state' ? 'forged' : authorize.searchParams.get('state')!);
    if (outcome === 'deny') redirect.searchParams.set('error', 'access_denied');
    else redirect.searchParams.set('code', 'one-time-code');
    // Not awaited by the service in real life; the connector must not depend on it.
    void fetch(redirect).catch(() => undefined);
  };
}

const input = { method: 'loopback-browser-v1' as const, descriptor: DESCRIPTOR, session: SESSION, deviceId: 'KHALADEV1', operationId: 'bootstrap-b-1' };

describe('createLoopbackOwnership', () => {
  it('sends a loopback redirect, PKCE and its key, then exchanges the code with a proof', async () => {
    const seen: URL[] = [];
    const { fetchImpl, calls } = service(() => ({ status: 200, body: { grant: 'grant-secret', expires_at: T0 + 60_000 } }));
    const port = createLoopbackOwnership({ signer, openBrowser: ownerBrowser('approve', seen), fetch: fetchImpl, clock: () => T0, timeoutMs: 5000 });
    const outcome = await port.prove(input);
    expect(outcome).toEqual({
      kind: 'granted',
      grant: { method: 'loopback-browser-v1', redeem: DESCRIPTOR.redeem, session: SESSION, deviceId: 'KHALADEV1', expiresAt: T0 + 60_000, secret: 'grant-secret' },
    });
    const authorize = seen[0]!;
    expect(authorize.origin + authorize.pathname).toBe(DESCRIPTOR.authorize);
    expect(new URL(authorize.searchParams.get('redirect_uri')!).hostname).toBe('127.0.0.1');
    expect(authorize.searchParams.get('jkt')).toBe(signer.jkt);
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    const [exchange] = calls;
    expect(exchange!.url).toBe(DESCRIPTOR.token);
    expect(exchange!.headers.origin).toBe(ORIGIN);
    const challenge = createHash('sha256').update(String(exchange!.body.code_verifier)).digest('base64url');
    expect(challenge).toBe(authorize.searchParams.get('code_challenge'));
    expect(exchange!.body).toMatchObject({ code: 'one-time-code', session_id: SESSION.sessionId, generation: 3, device_id: 'KHALADEV1' });
  });

  it('maps a declined, timed-out or forged callback without exchanging anything', async () => {
    for (const [behaviour, code] of [['deny', 'admission_denied'], ['ignore', 'ownership_required'], ['wrong_state', 'ownership_required']] as const) {
      const { fetchImpl, calls } = service(() => ({ status: 500 }));
      const port = createLoopbackOwnership({ signer, openBrowser: ownerBrowser(behaviour), fetch: fetchImpl, clock: () => T0, timeoutMs: 300 });
      expect(await port.prove(input)).toEqual({ kind: 'refused', code });
      expect(calls).toHaveLength(0);
    }
  });

  it('reports no browser as ownership_required rather than asking the human to configure anything', async () => {
    const port = createLoopbackOwnership({ signer, openBrowser: async () => { throw new Error('no display'); }, timeoutMs: 300 });
    expect(await port.prove(input)).toEqual({ kind: 'refused', code: 'ownership_required' });
  });

  it('refuses an already-expired or malformed grant', async () => {
    for (const body of [{ grant: 'g', expires_at: T0 }, { grant: 7, expires_at: T0 + 1000 }, {}]) {
      const { fetchImpl } = service(() => ({ status: 200, body }));
      const port = createLoopbackOwnership({ signer, openBrowser: ownerBrowser('approve'), fetch: fetchImpl, clock: () => T0, timeoutMs: 5000 });
      expect(await port.prove(input)).toEqual({ kind: 'refused', code: 'ownership_required' });
    }
  });
});

describe('createHttpAdmission', () => {
  const grant = { method: 'loopback-browser-v1' as const, redeem: DESCRIPTOR.redeem, session: SESSION, deviceId: 'KHALADEV1', expiresAt: T0 + 60_000, secret: 'grant-secret' };

  it('presents the grant with a bound proof and returns the binding', async () => {
    const binding = { v: 1, bindingId: 'b', ownerId: 'o', agentParticipantId: 'a', deviceId: 'KHALADEV1', harness: 'codex', sessionId: SESSION.sessionId, generation: 3 };
    const { fetchImpl, calls } = service(() => ({ status: 200, body: { binding, device_credential: { secret: 'login', expires_at: T0 + 1 } } }));
    const outcome = await createHttpAdmission({ signer, fetch: fetchImpl }).redeem({ grant, operationId: 'bootstrap-b-1' });
    expect(outcome).toEqual({ kind: 'admitted', binding, credential: { secret: 'login', expiresAt: T0 + 1 } });
    expect(calls[0]!.headers.authorization).toBe('DPoP grant-secret');
    expect(calls[0]!.body).toMatchObject({ operation_id: 'bootstrap-b-1', device_id: 'KHALADEV1' });
  });

  it('maps refusals and treats a lost request as an unknown outcome', async () => {
    for (const [status, expected] of [
      [401, { kind: 'refused', code: 'ownership_required' }],
      [403, { kind: 'refused', code: 'admission_denied' }],
      [409, { kind: 'refused', code: 'binding_conflict' }],
      [503, { kind: 'unavailable' }],
      [500, { kind: 'outcome_unknown' }],
    ] as const) {
      const { fetchImpl } = service(() => ({ status, body: { code: 'x' } }));
      expect(await createHttpAdmission({ signer, fetch: fetchImpl }).redeem({ grant, operationId: 'bootstrap-b-1' })).toEqual(expected);
    }
    const lost = (async () => { throw new Error('socket hang up'); }) as typeof fetch;
    expect(await createHttpAdmission({ signer, fetch: lost }).redeem({ grant, operationId: 'bootstrap-b-1' })).toEqual({ kind: 'outcome_unknown' });
  });
});

describe('createProofSigner', () => {
  it('signs a verifiable EdDSA proof bound to method, URL and token', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const proof = createProofSigner(privateKey, () => T0).proof('POST', DESCRIPTOR.redeem, 'grant-secret');
    const [header, payload, signature] = proof.split('.');
    const decodedHeader = JSON.parse(Buffer.from(header!, 'base64url').toString());
    expect(decodedHeader).toMatchObject({ alg: 'EdDSA', typ: 'dpop+jwt', jwk: { kty: 'OKP', crv: 'Ed25519' } });
    expect(decodedHeader.jwk.d).toBeUndefined();
    const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString());
    expect(claims).toMatchObject({ htm: 'POST', htu: DESCRIPTOR.redeem, iat: T0 / 1000, ath: createHash('sha256').update('grant-secret').digest('base64url') });
    const key = createPublicKey({ key: decodedHeader.jwk, format: 'jwk' });
    expect(verify(null, Buffer.from(`${header}.${payload}`), key, Buffer.from(signature!, 'base64url'))).toBe(true);
  });

  it('refuses a non-Ed25519 key', () => {
    expect(() => createProofSigner(generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey)).toThrow();
  });
});
