import { createHash, generateKeyPairSync } from 'node:crypto';
import type {
  ChannelAccessReadiness,
  DiscoveryCredential,
  GrantExchangeRequest,
  StableAgentPrincipal,
} from '@khala/contracts/messaging/index';
import { describe, expect, it } from 'vitest';
import { createHttpChannelAccessClient, createHttpChannelAccessRedeem, createHttpChannelAccessStatus,
  type ExchangeHttpDiagnostic } from './channel-access-http';
import { createProofSigner } from './proof';

const ORIGIN = 'https://khala.example';
const T0 = Date.parse('2026-09-25T12:00:00Z');
const signer = createProofSigner(generateKeyPairSync('ed25519').privateKey, () => T0);
const REQUESTER = 'principal_1' as StableAgentPrincipal;
const credential = {
  v: 1, credentialRef: 'credential_ref_1', audience: 'khala-channel-discovery',
  requester: { principal: REQUESTER, origin: ORIGIN, proofKey: { algorithm: 'Ed25519', publicKey: signer.publicKey, thumbprint: signer.jkt }, sessionGeneration: 3 },
  scopes: ['list_channels', 'request_channel_access', 'request_channel_create'],
  expiresAt: new Date(T0 + 300_000).toISOString(),
} as unknown as DiscoveryCredential;
const credentialFor = (): DiscoveryCredential => credential;

const REQUEST: GrantExchangeRequest = {
  v: 1,
  operationId: 'op_access_1',
  requester: REQUESTER,
  origin: ORIGIN,
  proofKey: { algorithm: 'Ed25519', publicKey: signer.publicKey, thumbprint: signer.jkt },
  encryptionKey: { algorithm: 'X25519', publicKey: 'B'.repeat(42) + 'A', thumbprint: 'A'.repeat(43) },
  deviceId: 'device_1' as GrantExchangeRequest['deviceId'],
  sessionGeneration: 3,
  expiresAt: new Date(T0 + 60_000).toISOString(),
};

const READINESS: ChannelAccessReadiness = {
  v: 1, operationId: 'op_access_1', requester: REQUESTER, origin: ORIGIN, sessionGeneration: 3,
  deviceId: REQUEST.deviceId, proofKeyThumbprint: signer.jkt, recipientKeyThumbprint: 'A'.repeat(43),
};

const ENVELOPE = { v: 1, algorithm: 'crypto_box_seal_x25519_xsalsa20poly1305', recipientKeyThumbprint: 'A'.repeat(43), ciphertext: 'Q'.repeat(96) };

function transport(reply: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchStub = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return reply();
  }) as unknown as typeof fetch;
  return { calls, fetchStub };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('channel-access HTTP client', () => {
  it.each([
    ['credential_unavailable', (): null => null, signer, () => json(200, ENVELOPE), undefined],
    ['credential_mismatch', () => ({ ...credential, requester: { ...credential.requester,
      proofKey: { ...credential.requester.proofKey, thumbprint: 'other' } } }), signer, () => json(200, ENVELOPE), undefined],
    ['proof_unavailable', credentialFor, { ...signer, proof() { throw new Error('secret grant URL'); } },
      () => json(200, ENVELOPE), undefined],
    ['transport_failed', credentialFor, signer, () => { throw new Error('secret grant URL'); }, undefined],
    ['http_status', credentialFor, signer, () => json(401, { error: 'secret grant URL' }), 401],
    ['body_media_type', credentialFor, signer,
      () => new Response('secret grant URL', { status: 200, headers: { 'content-type': 'text/html' } }), 200],
    ['body_missing', credentialFor, signer,
      () => new Response(null, { status: 200, headers: { 'content-type': 'application/json' } }), 200],
    ['body_read_failed', credentialFor, signer, () => json(200, 'x'.repeat(40_000)), 200],
    ['body_json_invalid', credentialFor, signer,
      () => new Response('secret grant URL', { status: 200, headers: { 'content-type': 'application/json' } }), 200],
  ] as const)('reports only fixed exchange HTTP stage %s', async (stage, held, proofSigner, response, httpStatus) => {
    const t = transport(response);
    const events: ExchangeHttpDiagnostic[] = [];
    const client = createHttpChannelAccessClient({ signer: proofSigner, trustedOrigins: [ORIGIN],
      credential: held as () => DiscoveryCredential | null, fetch: t.fetchStub, diagnostic: event => events.push(event) });
    expect(await client.exchange(REQUEST)).toEqual({ kind: 'unavailable' });
    expect(events).toEqual([{ stage, result: 'unavailable', ...(httpStatus === undefined ? {} : { httpStatus }) }]);
    expect(JSON.stringify(events)).not.toContain('secret grant URL');
  });

  it('uses HTTP status when a non-200 response has unreadable JSON', async () => {
    const events: ExchangeHttpDiagnostic[] = [];
    const t = transport(() => new Response('not JSON', { status: 503, headers: { 'content-type': 'application/json' } }));
    const client = createHttpChannelAccessClient({ signer, trustedOrigins: [ORIGIN],
      credential: credentialFor, fetch: t.fetchStub, diagnostic: event => events.push(event) });
    expect(await client.exchange(REQUEST)).toEqual({ kind: 'unavailable' });
    expect(events).toEqual([{ stage: 'http_status', result: 'unavailable', httpStatus: 503 }]);
  });

  it('keeps exchange outcomes stable when the local diagnostic sink throws', async () => {
    const t = transport(() => json(401, { error: 'secret grant URL' }));
    const client = createHttpChannelAccessClient({ signer, trustedOrigins: [ORIGIN],
      credential: credentialFor, fetch: t.fetchStub, diagnostic() { throw new Error('local diagnostics unavailable'); } });
    expect(await client.exchange(REQUEST)).toEqual({ kind: 'unavailable' });
  });

  it('posts the exchange to the exact origin with a fresh proof and passes the envelope through', async () => {
    const t = transport(() => json(200, ENVELOPE));
    const client = createHttpChannelAccessClient({ signer, trustedOrigins: [ORIGIN], credential: credentialFor, fetch: t.fetchStub });
    expect(await client.exchange(REQUEST)).toEqual({ kind: 'sealed', envelope: ENVELOPE });
    const [call] = t.calls;
    expect(call!.url).toBe(`${ORIGIN}/api/agent/channel-access/exchange?operation=op_access_1`);
    expect(call!.init).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit' });
    const headers = call!.init.headers as Record<string, string>;
    expect(headers.origin).toBe(ORIGIN);
    expect(headers.dpop?.split('.')).toHaveLength(3);
    expect(headers.authorization).toBe(`DPoP ${credential.credentialRef}`);
    const claims = JSON.parse(Buffer.from(headers.dpop!.split('.')[1]!, 'base64url').toString()) as Record<string, unknown>;
    expect(claims).toMatchObject({ htm: 'POST', htu: call!.url,
      ath: createHash('sha256').update(credential.credentialRef).digest('base64url'),
      body_hash: createHash('sha256').update(call!.init.body as string).digest('base64url') });
    expect(JSON.parse(call!.init.body as string)).toEqual(REQUEST);
  });

  it('maps rejections to finite codes and everything else to unavailable', async () => {
    for (const [response, expected] of [
      [() => json(410, { v: 1, kind: 'rejected', code: 'closed' }), { kind: 'rejected', code: 'closed' }],
      [() => json(409, { v: 1, kind: 'rejected', code: 'encryption_key_mismatch' }), { kind: 'rejected', code: 'encryption_key_mismatch' }],
      [() => json(409, { v: 1, kind: 'rejected', code: 'approve' }), { kind: 'unavailable' }],
      [() => json(503, { v: 1, kind: 'unavailable' }), { kind: 'unavailable' }],
      [() => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }), { kind: 'unavailable' }],
      [() => json(200, 'x'.repeat(40_000)), { kind: 'unavailable' }],
      [() => { throw new TypeError('connection reset after send'); }, { kind: 'unavailable' }],
    ] as const) {
      const t = transport(response);
      const client = createHttpChannelAccessClient({ signer, trustedOrigins: [ORIGIN], credential: credentialFor, fetch: t.fetchStub });
      expect(await client.exchange(REQUEST)).toEqual(expected);
    }
  });

  it('refuses an origin outside the configured allowlist without sending anything', async () => {
    const t = transport(() => json(200, ENVELOPE));
    const client = createHttpChannelAccessClient({ signer, trustedOrigins: [ORIGIN], credential: credentialFor, fetch: t.fetchStub });
    expect(await client.exchange({ ...REQUEST, origin: 'https://evil.example' })).toEqual({ kind: 'rejected', code: 'wrong_origin' });
    expect(await client.acknowledge({ ...READINESS, origin: 'https://evil.example' })).toBe('rejected');
    expect(t.calls).toHaveLength(0);
    expect(() => createHttpChannelAccessClient({ signer, trustedOrigins: ['http://khala.example'], credential: credentialFor })).toThrow();
  });

  it('acknowledges readiness only on the exact acknowledgement body', async () => {
    for (const [response, expected] of [
      [() => json(200, { v: 1, kind: 'acknowledged' }), 'acknowledged'],
      [() => json(200, { v: 1, kind: 'acknowledged', connected: true }), 'unavailable'],
      [() => json(410, { v: 1, kind: 'rejected', code: 'closed' }), 'closed'],
      [() => json(409, { v: 1, kind: 'rejected', code: 'wrong_device' }), 'rejected'],
      [() => json(503, { v: 1, kind: 'unavailable' }), 'unavailable'],
      [() => { throw new TypeError('offline'); }, 'unavailable'],
    ] as const) {
      const t = transport(response);
      const client = createHttpChannelAccessClient({ signer, trustedOrigins: [ORIGIN], credential: credentialFor, fetch: t.fetchStub });
      expect(await client.acknowledge(READINESS)).toBe(expected);
      expect(t.calls[0]!.url).toBe(`${ORIGIN}/api/agent/channel-access/ready?operation=op_access_1`);
      expect(JSON.parse(t.calls[0]!.init.body as string)).toEqual(READINESS);
    }
  });

  it('reads grant-free status with the live discovery credential only', async () => {
    const credential = {
      v: 1, credentialRef: 'credential_ref_1', audience: 'khala-channel-discovery',
      requester: { principal: REQUESTER, origin: ORIGIN, proofKey: { algorithm: 'Ed25519', publicKey: signer.publicKey, thumbprint: signer.jkt }, sessionGeneration: 3 },
      scopes: ['list_channels', 'request_channel_access', 'request_channel_create'],
      expiresAt: new Date(T0 + 300_000).toISOString(),
    } as unknown as DiscoveryCredential;
    let held: DiscoveryCredential | null = credential;
    const t = transport(() => json(200, { v: 1, operationId: 'op_access_1', outcome: 'approved' }));
    const status = createHttpChannelAccessStatus({ signer, trustedOrigins: [ORIGIN], fetch: t.fetchStub, credential: () => held });
    expect(await status.inspect({ operationId: 'op_access_1', origin: ORIGIN })).toBe('approved');
    expect(t.calls[0]!.url).toBe(`${ORIGIN}/api/agent/channel-access/status?v=1&operationId=op_access_1&operationKind=access`);
    expect((t.calls[0]!.init.headers as Record<string, string>).authorization).toBe('DPoP credential_ref_1');
    // Another operation's status, or a stray field, is never trusted.
    expect(await status.inspect({ operationId: 'op_access_2', origin: ORIGIN })).toBe('unavailable');
    held = null;
    expect(await status.inspect({ operationId: 'op_access_1', origin: ORIGIN })).toBe('unavailable');
    expect(t.calls).toHaveLength(2);
  });

  it('fails closed on missing authority, 401, or a changed signed body', async () => {
    const calls: string[] = [];
    const fetchStub = (async (url: string, init: RequestInit) => {
      calls.push(url);
      const headers = init.headers as Record<string, string>;
      const claims = JSON.parse(Buffer.from(headers.dpop!.split('.')[1]!, 'base64url').toString()) as Record<string, unknown>;
      const digest = createHash('sha256').update(String(init.body)).digest('base64url');
      return claims.body_hash === digest && headers.authorization === `DPoP ${credential.credentialRef}`
        ? json(200, ENVELOPE) : json(401, { v: 1, kind: 'rejected', code: 'auth_required' });
    }) as typeof fetch;
    const missing = createHttpChannelAccessClient({ signer, trustedOrigins: [ORIGIN], credential: () => null, fetch: fetchStub });
    expect(await missing.exchange(REQUEST)).toEqual({ kind: 'unavailable' });
    expect(calls).toHaveLength(0);
    const modified = (async (url: string, init: RequestInit) => fetchStub(url,
      { ...init, body: `${String(init.body)} ` })) as typeof fetch;
    const client = createHttpChannelAccessClient({ signer, trustedOrigins: [ORIGIN], credential: credentialFor, fetch: modified });
    expect(await client.exchange(REQUEST)).toEqual({ kind: 'unavailable' });
    expect(calls).toHaveLength(1);
  });

  it('posts grant-free resume with the exact binding tuple and signed body', async () => {
    const t = transport(() => json(200, { binding: { v: 1, bindingId: 'bnd_1', ownerId: 'owner_1',
      agentParticipantId: 'agent_1', deviceId: REQUEST.deviceId, harness: 'proof-key', sessionId: REQUESTER,
      generation: 3 }, adapter_capability: { token: 'A'.repeat(43), token_type: 'DPoP',
      scope: ['publish_own', 'receive_released', 'ack_delivery'], binding_id: 'bnd_1', generation: 3,
      expires_at: T0 + 60_000 } }));
    const client = createHttpChannelAccessRedeem({ signer, trustedOrigins: [ORIGIN], credential: credentialFor, fetch: t.fetchStub });
    expect(await client.resume({ operationId: REQUEST.operationId, deviceId: REQUEST.deviceId,
      origin: ORIGIN, bindingId: 'bnd_1' })).toMatchObject({ kind: 'admitted', binding: { bindingId: 'bnd_1' } });
    expect(t.calls[0]!.url).toBe(`${ORIGIN}/api/agent/channel-access/resume?operation=op_access_1`);
    expect(JSON.parse(t.calls[0]!.init.body as string)).toMatchObject({ requester: REQUESTER,
      origin: ORIGIN, sessionGeneration: 3, deviceId: REQUEST.deviceId, bindingId: 'bnd_1',
      proofKeyThumbprint: signer.jkt });
    const headers = t.calls[0]!.init.headers as Record<string, string>;
    const claims = JSON.parse(Buffer.from(headers.dpop!.split('.')[1]!, 'base64url').toString()) as Record<string, unknown>;
    expect(claims.body_hash).toBe(createHash('sha256').update(t.calls[0]!.init.body as string).digest('base64url'));
  });

  it('looks up a lost redeem response by operation with no binding ID and a body-bound proof', async () => {
    const t = transport(() => json(409, { v: 1, kind: 'rejected', code: 'operation_mismatch' }));
    const client = createHttpChannelAccessRedeem({ signer, trustedOrigins: [ORIGIN], credential: credentialFor, fetch: t.fetchStub });
    expect(await client.resume({ operationId: REQUEST.operationId, deviceId: REQUEST.deviceId,
      origin: ORIGIN })).toEqual({ kind: 'not_redeemed' });
    const [call] = t.calls;
    expect(call!.url).toBe(`${ORIGIN}/api/agent/channel-access/resume?operation=op_access_1`);
    expect(JSON.parse(call!.init.body as string)).toEqual({ v: 1, operationId: REQUEST.operationId,
      requester: REQUESTER, origin: ORIGIN, sessionGeneration: 3, deviceId: REQUEST.deviceId,
      proofKeyThumbprint: signer.jkt });
    const headers = call!.init.headers as Record<string, string>;
    const claims = JSON.parse(Buffer.from(headers.dpop!.split('.')[1]!, 'base64url').toString()) as Record<string, unknown>;
    expect(headers.authorization).toBe(`DPoP ${credential.credentialRef}`);
    expect(claims).toMatchObject({ htm: 'POST', htu: call!.url,
      ath: createHash('sha256').update(credential.credentialRef).digest('base64url'),
      body_hash: createHash('sha256').update(call!.init.body as string).digest('base64url') });
  });

  it.each([
    [409, 'proof_mismatch', { kind: 'refused', code: 'binding_conflict' }],
    [409, 'wrong_device', { kind: 'refused', code: 'binding_conflict' }],
    [409, 'wrong_generation', { kind: 'refused', code: 'binding_conflict' }],
    [410, 'closed', { kind: 'refused', code: 'binding_revoked' }],
    [410, 'expired', { kind: 'refused', code: 'binding_revoked' }],
    [409, 'operation_mismatch', { kind: 'not_redeemed' }],
  ] as const)('returns a typed closed result for %s %s', async (status, code, expected) => {
    const t = transport(() => json(status, { v: 1, kind: 'rejected', code }));
    const client = createHttpChannelAccessRedeem({ signer, trustedOrigins: [ORIGIN], credential: credentialFor, fetch: t.fetchStub });
    expect(await client.resume({ operationId: REQUEST.operationId, deviceId: REQUEST.deviceId, origin: ORIGIN }))
      .toEqual(expected);
    expect(t.calls).toHaveLength(1);
    expect(JSON.parse(t.calls[0]!.init.body as string)).not.toHaveProperty('bindingId');
  });
});
