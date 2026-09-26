import { generateKeyPairSync } from 'node:crypto';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type ChannelDiscoveryAuthorizationOutcome, type ChannelDiscoveryCredentialClient, createProofSigner,
} from '@khala/connector/bootstrap/index';
import type { DiscoveryCredential } from '@khala/contracts/messaging/index';
import { PAGE } from '../cli/channels/fixtures/listing.js';
import { CHANNEL_LIST_PATH, createHttpChannelListing } from './channel-listing.js';

const signer = createProofSigner(generateKeyPairSync('ed25519').privateKey);
const session = { harness: 'codex', sessionId: 'session-1', workdir: '/workspace' };
const servers: Server[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

type Handler = (request: IncomingMessage, response: ServerResponse) => void;
async function loopback(handler: Handler): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function credential(origin: string, credentialRef = 'credential-ref-1'): DiscoveryCredential {
  return {
    v: 1, credentialRef, audience: 'khala-channel-discovery',
    requester: {
      principal: 'principal-1', origin, sessionGeneration: 0,
      proofKey: { algorithm: 'Ed25519', publicKey: 'A'.repeat(43), thumbprint: signer.jkt },
    },
    scopes: ['list_channels', 'request_channel_access', 'request_channel_create'],
    expiresAt: '2999-01-01T00:00:00Z',
  } as unknown as DiscoveryCredential;
}

function credentials(
  held: DiscoveryCredential | null,
  outcome: (origin: string) => ChannelDiscoveryAuthorizationOutcome = origin => ({ kind: 'authorized', credential: credential(origin) }),
) {
  let current = held;
  const client = {
    authorize: vi.fn<ChannelDiscoveryCredentialClient['authorize']>(async input => {
      const result = outcome(input.origin);
      if (result.kind === 'authorized') current = result.credential;
      return result;
    }),
    refresh: vi.fn<ChannelDiscoveryCredentialClient['refresh']>(async () => ({ kind: 'missing' })),
    current: () => current,
    invalidate: vi.fn(() => { current = null; }),
  } satisfies ChannelDiscoveryCredentialClient;
  return client;
}

function json(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
}

function decodeProof(header: unknown): Record<string, unknown> {
  return JSON.parse(Buffer.from(String(header).split('.')[1]!, 'base64url').toString()) as Record<string, unknown>;
}

describe('HTTP channel listing', () => {
  it('lists over loopback HTTP with a DPoP-bound discovery credential and passes the cursor through', async () => {
    const seen: IncomingMessage[] = [];
    const origin = await loopback((request, response) => { seen.push(request); json(response, 200, PAGE); });
    const list = createHttpChannelListing({
      credentials: credentials(credential(origin)), signer, session, trustedOrigins: [origin], defaultOrigin: origin,
    });

    await expect(list({ origin: null, cursor: 'cursor/2 +' })).resolves.toEqual({ kind: 'listed', page: PAGE });
    const [request] = seen;
    const target = `${origin}${CHANNEL_LIST_PATH}?cursor=cursor%2F2+%2B`;
    expect(`${origin}${request!.url}`).toBe(target);
    expect(request!.method).toBe('GET');
    expect(request!.headers.authorization).toBe('DPoP credential-ref-1');
    expect(request!.headers.cookie).toBeUndefined();
    expect(decodeProof(request!.headers.dpop)).toMatchObject({ htm: 'GET', htu: target });
  });

  it('obtains discovery scope through owner bootstrap when no credential is held', async () => {
    const origin = await loopback((_request, response) => json(response, 200, PAGE));
    const held = credentials(null);
    const list = createHttpChannelListing({ credentials: held, signer, session, trustedOrigins: [origin], defaultOrigin: origin });

    await expect(list({ origin: null, cursor: null })).resolves.toMatchObject({ kind: 'listed' });
    expect(held.authorize).toHaveBeenCalledWith({ origin, session }, undefined);
    await list({ origin: null, cursor: null });
    expect(held.authorize).toHaveBeenCalledOnce();
  });

  it.each([
    [{ kind: 'denied' }, 'discovery_denied'],
    [{ kind: 'cancelled' }, 'discovery_required'],
    [{ kind: 'timed_out' }, 'discovery_required'],
    [{ kind: 'rejected', code: 'session_missing' }, 'discovery_required'],
    [{ kind: 'rejected', code: 'untrusted_origin' }, 'untrusted_origin'],
  ] as const)('maps bootstrap outcome %j to %s without listing', async (outcome, code) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const list = createHttpChannelListing({
      credentials: credentials(null, () => outcome), signer, session, fetch,
      trustedOrigins: ['https://khala.aiur.team'], defaultOrigin: 'https://khala.aiur.team',
    });
    await expect(list({ origin: null, cursor: null })).resolves.toEqual({ kind: 'refused', code });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([[{ kind: 'unavailable' }], [{ kind: 'outcome_unknown' }]] as const)('reports bootstrap %j as unavailable', async outcome => {
    const list = createHttpChannelListing({
      credentials: credentials(null, () => outcome), signer, session, fetch: vi.fn(),
      trustedOrigins: ['https://khala.aiur.team'], defaultOrigin: 'https://khala.aiur.team',
    });
    await expect(list({ origin: null, cursor: null })).resolves.toEqual({ kind: 'unavailable' });
  });

  it('refuses an --origin outside the exact configured allowlist before any network or browser step', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const held = credentials(null);
    const list = createHttpChannelListing({
      credentials: held, signer, session, fetch,
      trustedOrigins: ['https://khala.aiur.team'], defaultOrigin: 'https://khala.aiur.team',
    });
    for (const origin of ['https://evil.example', 'https://khala.aiur.team:444', 'https://preview.khala.aiur.team']) {
      await expect(list({ origin, cursor: null })).resolves.toEqual({ kind: 'refused', code: 'untrusted_origin' });
    }
    expect(fetch).not.toHaveBeenCalled();
    expect(held.authorize).not.toHaveBeenCalled();
  });

  it('re-authorizes for a different trusted origin instead of replaying another origin credential', async () => {
    const origin = await loopback((request, response) => json(response, 200, PAGE));
    const held = credentials(credential('https://khala.aiur.team'));
    const list = createHttpChannelListing({
      credentials: held, signer, session, trustedOrigins: ['https://khala.aiur.team', origin], defaultOrigin: 'https://khala.aiur.team',
    });
    await expect(list({ origin, cursor: null })).resolves.toMatchObject({ kind: 'listed' });
    expect(held.authorize).toHaveBeenCalledWith({ origin, session }, undefined);
  });

  it('rejects cross-origin redirects without following them', async () => {
    let followed = false;
    const other = await loopback((_request, response) => { followed = true; json(response, 200, PAGE); });
    const origin = await loopback((_request, response) => {
      response.writeHead(302, { location: `${other}${CHANNEL_LIST_PATH}` }).end();
    });
    const list = createHttpChannelListing({
      credentials: credentials(credential(origin)), signer, session, trustedOrigins: [origin, other], defaultOrigin: origin,
    });
    await expect(list({ origin: null, cursor: null })).resolves.toEqual({ kind: 'refused', code: 'untrusted_origin' });
    expect(followed).toBe(false);
  });

  it('does not follow same-origin redirects either', async () => {
    let requests = 0;
    const origin = await loopback((_request, response) => {
      requests += 1;
      response.writeHead(307, { location: `${CHANNEL_LIST_PATH}?cursor=other` }).end();
    });
    const list = createHttpChannelListing({
      credentials: credentials(credential(origin)), signer, session, trustedOrigins: [origin], defaultOrigin: origin,
    });
    await expect(list({ origin: null, cursor: null })).resolves.toEqual({ kind: 'unavailable' });
    expect(requests).toBe(1);
  });

  it.each([
    [401, 'discovery_required'], [403, 'discovery_denied'], [400, 'cursor_unavailable'], [410, 'cursor_unavailable'], [429, 'rate_limited'],
  ] as const)('maps HTTP %i to %s', async (status, code) => {
    const origin = await loopback((_request, response) => json(response, status, { error: 'x' }));
    const held = credentials(credential(origin));
    const list = createHttpChannelListing({ credentials: held, signer, session, trustedOrigins: [origin], defaultOrigin: origin });
    await expect(list({ origin: null, cursor: null })).resolves.toEqual({ kind: 'refused', code });
    expect(held.invalidate).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
  });

  it.each([
    ['server error', (response: ServerResponse) => json(response, 503, { error: 'feature_unavailable' })],
    ['non-JSON body', (response: ServerResponse) => response.writeHead(200, { 'content-type': 'text/html' }).end('<p>hi</p>')],
    ['invalid JSON', (response: ServerResponse) => response.writeHead(200, { 'content-type': 'application/json' }).end('{')],
    ['oversized body', (response: ServerResponse) => json(response, 200, { pad: 'x'.repeat(70_000) })],
  ])('reports %s as unavailable', async (_label, reply) => {
    const origin = await loopback((_request, response) => reply(response));
    const list = createHttpChannelListing({
      credentials: credentials(credential(origin)), signer, session, trustedOrigins: [origin], defaultOrigin: origin,
    });
    await expect(list({ origin: null, cursor: null })).resolves.toEqual({ kind: 'unavailable' });
  });

  it('refuses to compose with a non-exact or untrusted default origin', () => {
    const options = { credentials: credentials(null), signer, session };
    expect(() => createHttpChannelListing({ ...options, trustedOrigins: ['http://khala.aiur.team'], defaultOrigin: 'http://khala.aiur.team' })).toThrow();
    expect(() => createHttpChannelListing({ ...options, trustedOrigins: ['https://khala.aiur.team'], defaultOrigin: 'https://evil.example' })).toThrow();
  });
});
