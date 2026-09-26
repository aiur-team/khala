import { generateKeyPairSync } from 'node:crypto';
import type {
  ChannelAccessReadiness,
  DiscoveryCredential,
  GrantExchangeRequest,
  StableAgentPrincipal,
} from '@khala/contracts/messaging/index';
import { describe, expect, it } from 'vitest';
import { createHttpChannelAccessClient, createHttpChannelAccessStatus } from './channel-access-http';
import { createProofSigner } from './proof';

const ORIGIN = 'https://khala.example';
const T0 = Date.parse('2026-09-25T12:00:00Z');
const signer = createProofSigner(generateKeyPairSync('ed25519').privateKey, () => T0);
const REQUESTER = 'principal_1' as StableAgentPrincipal;

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
  it('posts the exchange to the exact origin with a fresh proof and passes the envelope through', async () => {
    const t = transport(() => json(200, ENVELOPE));
    const client = createHttpChannelAccessClient({ signer, trustedOrigins: [ORIGIN], fetch: t.fetchStub });
    expect(await client.exchange(REQUEST)).toEqual({ kind: 'sealed', envelope: ENVELOPE });
    const [call] = t.calls;
    expect(call!.url).toBe(`${ORIGIN}/api/agent/channel-access/exchange?operation=op_access_1`);
    expect(call!.init).toMatchObject({ method: 'POST', redirect: 'error', credentials: 'omit' });
    const headers = call!.init.headers as Record<string, string>;
    expect(headers.origin).toBe(ORIGIN);
    expect(headers.dpop?.split('.')).toHaveLength(3);
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
      const client = createHttpChannelAccessClient({ signer, trustedOrigins: [ORIGIN], fetch: t.fetchStub });
      expect(await client.exchange(REQUEST)).toEqual(expected);
    }
  });

  it('refuses an origin outside the configured allowlist without sending anything', async () => {
    const t = transport(() => json(200, ENVELOPE));
    const client = createHttpChannelAccessClient({ signer, trustedOrigins: [ORIGIN], fetch: t.fetchStub });
    expect(await client.exchange({ ...REQUEST, origin: 'https://evil.example' })).toEqual({ kind: 'rejected', code: 'wrong_origin' });
    expect(await client.acknowledge({ ...READINESS, origin: 'https://evil.example' })).toBe('rejected');
    expect(t.calls).toHaveLength(0);
    expect(() => createHttpChannelAccessClient({ signer, trustedOrigins: ['http://khala.example'] })).toThrow();
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
      const client = createHttpChannelAccessClient({ signer, trustedOrigins: [ORIGIN], fetch: t.fetchStub });
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
});
