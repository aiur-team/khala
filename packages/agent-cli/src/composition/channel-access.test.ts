import { generateKeyPairSync } from 'node:crypto';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ChannelDiscoveryCredentialClient, createProofSigner,
} from '@khala/connector/bootstrap/index';
import type { DiscoveryCredential } from '@khala/contracts/messaging/index';
import { CHANNEL_ACCESS_REQUEST_PATH, CHANNEL_ACCESS_STATUS_PATH, createHttpChannelAccess } from './channel-access.js';

const signer = createProofSigner(generateKeyPairSync('ed25519').privateKey);
const session = { harness: 'codex', sessionId: 'session-1', workdir: '/workspace' };
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

async function loopback(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function credential(origin: string): DiscoveryCredential {
  return {
    v: 1, credentialRef: 'credential-ref-1', audience: 'khala-channel-discovery',
    requester: {
      principal: 'principal-1', origin, sessionGeneration: 0,
      proofKey: { algorithm: 'Ed25519', publicKey: 'A'.repeat(43), thumbprint: signer.jkt },
    },
    scopes: ['list_channels', 'request_channel_access', 'request_channel_create'],
    expiresAt: '2999-01-01T00:00:00Z',
  } as unknown as DiscoveryCredential;
}

function credentials(held: DiscoveryCredential | null) {
  let current = held;
  return {
    authorize: vi.fn<ChannelDiscoveryCredentialClient['authorize']>(async () => ({ kind: 'denied' })),
    refresh: vi.fn<ChannelDiscoveryCredentialClient['refresh']>(async () => ({ kind: 'missing' })),
    current: () => current,
    invalidate: vi.fn(() => { current = null; }),
  } satisfies ChannelDiscoveryCredentialClient;
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString());
}

function access(origin: string, held = credentials(credential(origin)), extra: Partial<Parameters<typeof createHttpChannelAccess>[0]> = {}) {
  return createHttpChannelAccess({ credentials: held, signer, session, trustedOrigins: [origin], defaultOrigin: origin, ...extra });
}

describe('HTTP channel access', () => {
  it('posts a listing-ref request with the operation ID and a DPoP-bound credential', async () => {
    const seen: { request: IncomingMessage; body: unknown }[] = [];
    const origin = await loopback(async (request, response) => {
      seen.push({ request, body: await readBody(request) });
      json(response, 200, { v: 1, operationId: 'op-1', outcome: 'pending_owner' });
    });
    const result = await access(origin).requestChannelAccess(
      { target: { kind: 'listing_ref', listingRef: 'ref-alpha' }, operationId: 'op-1', origin: null },
    );
    expect(result).toEqual({ kind: 'status', status: { v: 1, operationId: 'op-1', outcome: 'pending_owner' } });
    const [{ request, body }] = seen as [(typeof seen)[number]];
    expect(request.method).toBe('POST');
    expect(request.url).toBe(CHANNEL_ACCESS_REQUEST_PATH);
    expect(request.headers.authorization).toBe('DPoP credential-ref-1');
    expect(body).toEqual({ v: 1, kind: 'listing_ref', operationId: 'op-1', credentialRef: 'credential-ref-1', listingRef: 'ref-alpha' });
  });

  it('sends a channel URL to the service it names, and refuses a conflicting --origin', async () => {
    const seen: unknown[] = [];
    const origin = await loopback(async (request, response) => {
      seen.push(await readBody(request));
      json(response, 200, { v: 1, operationId: 'op-1', outcome: 'pending_owner' });
    });
    const channelUrl = `${origin}/channels/channel-1`;
    const port = access(origin);
    await expect(port.requestChannelAccess({ target: { kind: 'channel_url', channelUrl }, operationId: 'op-1', origin: null }))
      .resolves.toMatchObject({ kind: 'status' });
    expect(seen).toEqual([{ v: 1, kind: 'channel_url', operationId: 'op-1', credentialRef: 'credential-ref-1', channelUrl }]);
    await expect(port.requestChannelAccess({
      target: { kind: 'channel_url', channelUrl }, operationId: 'op-1', origin: 'https://khala.aiur.team',
    })).resolves.toEqual({ kind: 'refused', code: 'untrusted_origin' });
    expect(seen).toHaveLength(1);
  });

  it('refuses a channel URL on an origin outside the allowlist before any network step', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const held = credentials(null);
    const port = createHttpChannelAccess({
      credentials: held, signer, session, fetch,
      trustedOrigins: ['https://khala.aiur.team'], defaultOrigin: 'https://khala.aiur.team',
    });
    await expect(port.requestChannelAccess({
      target: { kind: 'channel_url', channelUrl: 'https://evil.example/channels/c' }, operationId: 'op-1', origin: null,
    })).resolves.toEqual({ kind: 'refused', code: 'untrusted_origin' });
    await expect(port.channelAccessStatus({ operationId: 'op-1', origin: 'https://evil.example' }))
      .resolves.toEqual({ kind: 'refused', code: 'untrusted_origin' });
    expect(fetch).not.toHaveBeenCalled();
    expect(held.authorize).not.toHaveBeenCalled();
  });

  it('reads status with the closed query and the access operation kind', async () => {
    const seen: IncomingMessage[] = [];
    const origin = await loopback((request, response) => {
      seen.push(request);
      json(response, 200, { v: 1, operationId: 'op/1', outcome: 'connecting' });
    });
    await expect(access(origin).channelAccessStatus({ operationId: 'op/1', origin: null }))
      .resolves.toMatchObject({ kind: 'status' });
    expect(seen[0]!.method).toBe('GET');
    expect(seen[0]!.url).toBe(`${CHANNEL_ACCESS_STATUS_PATH}?v=1&operationId=op%2F1&operationKind=access`);
  });

  it('rejects a cross-origin redirect without following it', async () => {
    const target = vi.fn((_request: IncomingMessage, response: ServerResponse) => json(response, 200, {}));
    const other = await loopback(target);
    const origin = await loopback((_request, response) => {
      response.writeHead(307, { location: `${other}/api/agent/channel-access/request` }).end();
    });
    await expect(access(origin).requestChannelAccess(
      { target: { kind: 'listing_ref', listingRef: 'ref' }, operationId: 'op-1', origin: null },
    )).resolves.toEqual({ kind: 'refused', code: 'untrusted_origin' });
    expect(target).not.toHaveBeenCalled();
  });

  it.each([
    [400, { kind: 'refused', code: 'invalid_request' }],
    [403, { kind: 'refused', code: 'discovery_denied' }],
    [404, { kind: 'refused', code: 'not_found' }],
    [409, { kind: 'refused', code: 'operation_conflict' }],
    [429, { kind: 'refused', code: 'rate_limited' }],
    [500, { kind: 'unavailable' }],
    [503, { kind: 'unavailable' }],
  ])('maps HTTP %i to %j', async (status, expected) => {
    const origin = await loopback((_request, response) => json(response, status, { v: 1, kind: 'rejected' }));
    await expect(access(origin).channelAccessStatus({ operationId: 'op-1', origin: null })).resolves.toEqual(expected);
  });

  it('drops the credential on 401 and asks for discovery again', async () => {
    const origin = await loopback((_request, response) => json(response, 401, { v: 1, kind: 'rejected' }));
    const held = credentials(credential(origin));
    await expect(access(origin, held).channelAccessStatus({ operationId: 'op-1', origin: null }))
      .resolves.toEqual({ kind: 'refused', code: 'discovery_required' });
    expect(held.invalidate).toHaveBeenCalledOnce();
  });

  it('treats a non-JSON or oversized body as unavailable', async () => {
    const text = await loopback((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }).end('<html>'); });
    await expect(access(text).channelAccessStatus({ operationId: 'op-1', origin: null })).resolves.toEqual({ kind: 'unavailable' });
    const big = await loopback((_request, response) => json(response, 200, { pad: 'x'.repeat(10_000) }));
    await expect(access(big).channelAccessStatus({ operationId: 'op-1', origin: null })).resolves.toEqual({ kind: 'unavailable' });
  });

  it('maps a bootstrap denial without contacting the service', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const port = createHttpChannelAccess({
      credentials: credentials(null), signer, session, fetch,
      trustedOrigins: ['https://khala.aiur.team'], defaultOrigin: 'https://khala.aiur.team',
    });
    await expect(port.channelAccessStatus({ operationId: 'op-1', origin: null }))
      .resolves.toEqual({ kind: 'refused', code: 'discovery_denied' });
    expect(fetch).not.toHaveBeenCalled();
  });
});
