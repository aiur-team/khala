import { createHash, generateKeyPairSync } from 'node:crypto';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ChannelDiscoveryCredentialClient, createProofSigner,
} from '@khala/connector/bootstrap/index';
import type { DiscoveryCredential } from '@khala/contracts/messaging/index';
import { CHANNEL_ACCESS_CREATE_PATH, CHANNEL_ACCESS_REQUEST_PATH, CHANNEL_ACCESS_STATUS_PATH,
  CHANNEL_LINK_REQUEST_PATH, createHttpChannelAccess } from './channel-access.js';

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
  it('reports only fixed failure stages and HTTP status, without request data', async () => {
    const origin = 'https://khala.aiur.team';
    const diagnostic = vi.fn();
    const request = { target: { kind: 'channel_url' as const, channelUrl: `${origin}/join/inviteRef123` },
      operationId: 'op-1', origin: null };
    await expect(access(origin, credentials(null), { diagnostic, candidate: async () => ({ kind: 'unavailable' }) })
      .requestChannelAccess(request)).resolves.toEqual({ kind: 'unavailable' });
    expect(diagnostic).toHaveBeenCalledWith({ stage: 'candidate', result: 'unavailable' });

    diagnostic.mockClear();
    await expect(access(origin, credentials(credential(origin)), { diagnostic, fetch: async () => { throw new Error('secret'); } })
      .requestChannelAccess(request)).resolves.toEqual({ kind: 'unavailable' });
    expect(diagnostic).toHaveBeenCalledWith({ stage: 'http_transport', result: 'unavailable' });

    diagnostic.mockClear();
    await expect(access(origin, credentials(credential(origin)), { diagnostic,
      fetch: async () => new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } }) })
      .requestChannelAccess(request)).resolves.toEqual({ kind: 'unavailable' });
    expect(diagnostic).toHaveBeenCalledWith({ stage: 'http_response', result: 'unavailable', httpStatus: 503 });
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('inviteRef123');
    expect(JSON.stringify(diagnostic.mock.calls)).not.toContain('secret');
  });

  it('waits for exact-session approval before sending a hosted create intent', async () => {
    const posted: unknown[] = [];
    const origin = await loopback(async (request, response) => {
      expect(request.url).toBe(`${CHANNEL_ACCESS_CREATE_PATH}?agent_create=owner_1.${'B'.repeat(43)}`);
      posted.push(await readBody(request));
      json(response, 200, { v: 1, operationId: 'op-create', outcome: 'pending_owner' });
    });
    const held = credentials(null);
    held.authorize.mockImplementation(async () => ({ kind: 'authorized', credential: credential(origin) }));
    const approvalUrl = `${origin}/api/human/channel-discovery/authority/approve?candidate=${'A'.repeat(43)}`;
    const candidate = vi.fn()
      .mockResolvedValueOnce({ kind: 'pending_owner', candidateId: 'candidate-1', approveUrl: approvalUrl })
      .mockResolvedValueOnce({ kind: 'approved', candidateId: 'candidate-1', approveUrl: approvalUrl });
    const port = access(origin, held, { candidate });
    const input = { title: 'Planning', operationId: 'op-create', origin: null,
      target: `${origin}/new?agent_create=owner_1.${'B'.repeat(43)}` };
    expect(await port.requestChannelCreate(input)).toEqual({ kind: 'handoff', approvalUrl });
    expect(posted).toEqual([]);
    expect(held.authorize).not.toHaveBeenCalled();
    expect(await port.requestChannelCreate(input)).toEqual({ kind: 'status', status: {
      v: 1, operationId: 'op-create', outcome: 'pending_owner',
    } });
    expect(posted).toEqual([{ v: 1, operationId: 'op-create', credentialRef: 'credential-ref-1',
      origin, proposedTitle: 'Planning' }]);
  });

  it('resubmits the same channel request after proof-key approval before checking access status', async () => {
    const posted: unknown[] = [];
    const origin = await loopback(async (request, response) => {
      posted.push(await readBody(request));
      json(response, 200, { v: 1, kind: 'request', operationId: 'op-1', outcome: 'pending_owner' });
    });
    const held = credentials(null);
    held.authorize.mockImplementation(async () => ({ kind: 'authorized', credential: credential(origin) }));
    const candidate = vi.fn()
      .mockResolvedValueOnce({ kind: 'pending_owner', candidateId: 'candidate-1', approveUrl: `${origin}/approve` })
      .mockResolvedValueOnce({ kind: 'approved', candidateId: 'candidate-1', approveUrl: `${origin}/approve` });
    const port = access(origin, held, { candidate });
    const request = { target: { kind: 'channel_url' as const, channelUrl: `${origin}/join/inviteRef123` },
      operationId: 'op-1', origin: null };

    await expect(port.requestChannelAccess(request)).resolves.toEqual({ kind: 'proof_key_candidate', candidateId: 'candidate-1' });
    expect(posted).toEqual([]);
    expect(held.authorize).not.toHaveBeenCalled();

    await expect(port.requestChannelAccess(request)).resolves.toEqual({ kind: 'status', status: {
      v: 1, operationId: 'op-1', outcome: 'pending_owner',
    } });
    expect(candidate).toHaveBeenCalledTimes(2);
    expect(posted).toEqual([{ v: 1, kind: 'channel_url', operationId: 'op-1',
      credentialRef: 'credential-ref-1', channelUrl: request.target.channelUrl }]);
  });

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

  it('posts a create intent bound to the credential and reads create status by kind', async () => {
    const seen: { url: string | undefined; method: string | undefined; body: unknown }[] = [];
    const origin = await loopback(async (request, response) => {
      seen.push({ url: request.url, method: request.method, body: request.method === 'POST' ? await readBody(request) : null });
      json(response, 200, { v: 1, operationId: 'op-1', outcome: 'pending_owner' });
    });
    const port = access(origin);
    await expect(port.requestChannelCreate({ title: 'Planning', operationId: 'op-1', origin: null }))
      .resolves.toEqual({ kind: 'status', status: { v: 1, operationId: 'op-1', outcome: 'pending_owner' } });
    await port.channelCreateStatus({ operationId: 'op-1', origin: null });
    expect(seen).toEqual([
      {
        url: '/api/agent/channel-access/create', method: 'POST',
        body: { v: 1, operationId: 'op-1', credentialRef: 'credential-ref-1', origin, proposedTitle: 'Planning' },
      },
      { url: `${CHANNEL_ACCESS_STATUS_PATH}?v=1&operationId=op-1&operationKind=create`, method: 'GET', body: null },
    ]);
    await expect(port.requestChannelCreate({ title: 'T', operationId: 'op-1', origin: 'https://evil.example' }))
      .resolves.toEqual({ kind: 'refused', code: 'untrusted_origin' });
  });

  it('rejects a cross-origin redirect on create without following it', async () => {
    const other = vi.fn();
    const target = await loopback((_request, response) => { other(); json(response, 200, {}); });
    const origin = await loopback((_request, response) => {
      response.writeHead(307, { location: `${target}/api/agent/channel-access/create` }).end();
    });
    const result = await access(origin).requestChannelCreate({ title: 'T', operationId: 'op-1', origin: null });
    expect(result).toEqual({ kind: 'refused', code: 'untrusted_origin' });
    expect(other).not.toHaveBeenCalled();
  });

  it('sends a channel URL to the service it names, and refuses a conflicting --origin', async () => {
    const seen: { url: string | undefined; body: unknown; raw: string; proof: string | undefined;
      origin: string | undefined }[] = [];
    const origin = await loopback(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString();
      seen.push({ url: request.url, body: JSON.parse(raw) as unknown, raw,
        proof: Array.isArray(request.headers.dpop) ? undefined : request.headers.dpop,
        origin: request.headers.origin });
      if (request.headers.origin !== origin) {
        json(response, 403, { code: 'forbidden_origin' });
        return;
      }
      json(response, 200, { v: 1, kind: 'request', operationId: 'op-1', outcome: 'pending_owner' });
    });
    const channelUrl = `${origin}/join/inviteRef123`;
    const port = access(origin);
    await expect(port.requestChannelAccess({ target: { kind: 'channel_url', channelUrl }, operationId: 'op-1', origin: null }))
      .resolves.toMatchObject({ kind: 'status' });
    expect(seen[0]).toMatchObject({ url: CHANNEL_LINK_REQUEST_PATH,
      origin,
      body: { v: 1, kind: 'channel_url', operationId: 'op-1', credentialRef: 'credential-ref-1', channelUrl } });
    const claims = JSON.parse(Buffer.from(seen[0]!.proof!.split('.')[1]!, 'base64url').toString()) as Record<string, unknown>;
    expect(claims).toMatchObject({ htm: 'POST', htu: `${origin}${CHANNEL_LINK_REQUEST_PATH}`,
      ath: createHash('sha256').update('credential-ref-1').digest('base64url'),
      body_hash: createHash('sha256').update(seen[0]!.raw).digest('base64url') });
    await expect(port.requestChannelAccess({
      target: { kind: 'channel_url', channelUrl }, operationId: 'op-1', origin: 'https://khala.aiur.team',
    })).resolves.toEqual({ kind: 'refused', code: 'untrusted_origin' });
    expect(seen).toHaveLength(1);
  });

  it('explains a sponsor-bound link refusal without opening the browser', async () => {
    const origin = await loopback(async (request, response) => {
      await readBody(request);
      json(response, 409, { v: 1, kind: 'use_your_link', action: 'join_in_browser_then_copy_your_link' });
    });
    await expect(access(origin).requestChannelAccess({
      target: { kind: 'channel_url', channelUrl: `${origin}/join/inviteRef123` },
      operationId: 'op-1', origin: null,
    })).resolves.toEqual({ kind: 'refused', code: 'sponsor_link_required' });
  });

  it('refuses a channel URL on an origin outside the allowlist before any network step', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const held = credentials(null);
    const port = createHttpChannelAccess({
      credentials: held, signer, session, fetch,
      trustedOrigins: ['https://khala.aiur.team'], defaultOrigin: 'https://khala.aiur.team',
    });
    await expect(port.requestChannelAccess({
      target: { kind: 'channel_url', channelUrl: 'https://evil.example/join/inviteRef123' }, operationId: 'op-1', origin: null,
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
