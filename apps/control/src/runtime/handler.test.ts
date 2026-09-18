import { describe, expect, it, vi } from 'vitest';
import {
  HEALTH_PATH,
  MAX_REQUEST_BYTES,
  checkMutationOrigin,
  createGateway,
  normalizePathname,
  wrapRegistration,
  type RouteRegistration,
} from './handler';

const APP_ORIGIN = 'https://khala.aiur.team';

async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

function registration(overrides: Partial<RouteRegistration> = {}): RouteRegistration {
  return {
    path: '/api/human/example',
    methods: ['GET'],
    handle: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ...overrides,
  };
}

function wrap(overrides: Partial<RouteRegistration> = {}): RouteRegistration {
  return wrapRegistration(registration(overrides), { appOrigin: APP_ORIGIN });
}

describe('normalizePathname', () => {
  it('leaves an ordinary /api path unchanged', () => {
    expect(normalizePathname('/api/human/auth/callback')).toBe('/api/human/auth/callback');
  });

  it('maps a direct function invocation back to the logical /api path', () => {
    expect(normalizePathname('/.netlify/functions/khala-control/human/auth/callback')).toBe('/api/human/auth/callback');
    expect(normalizePathname('/.netlify/functions/khala-control')).toBe('/api');
  });

  it('leaves unrelated paths untouched', () => {
    expect(normalizePathname('/some/other/path')).toBe('/some/other/path');
  });
});

function mutationRequest(init: RequestInit): Request {
  const headers = new Headers(init.headers);
  if (!headers.has('origin')) headers.set('origin', APP_ORIGIN);
  return new Request('https://example.test/api/human/example', { ...init, headers });
}

describe('wrapRegistration', () => {
  it('rejects a method the registration does not declare', async () => {
    const wrapped = wrap({ methods: ['GET'] });
    const response = await wrapped.handle(mutationRequest({ method: 'POST' }));
    expect(response.status).toBe(405);
    expect((await jsonOf(response)).code).toBe('method_not_allowed');
  });

  it('rejects a POST with no matching Origin header', async () => {
    const wrapped = wrap({ methods: ['POST'] });
    const response = await wrapped.handle(new Request('https://example.test/api/human/example', { method: 'POST' }));
    expect(response.status).toBe(403);
    expect((await jsonOf(response)).code).toBe('forbidden_origin');
  });

  it('rejects a POST whose Origin header does not match the configured app origin', async () => {
    const wrapped = wrap({ methods: ['POST'] });
    const response = await wrapped.handle(mutationRequest({ method: 'POST', headers: { origin: 'https://evil.test' } }));
    expect(response.status).toBe(403);
  });

  it('never requires an Origin header for a safe (GET/HEAD/OPTIONS) method', async () => {
    const wrapped = wrap({ methods: ['GET'] });
    const response = await wrapped.handle(new Request('https://example.test/api/human/example'));
    expect(response.status).toBe(200);
  });

  it('rejects a body over the size bound even with no content-length header at all', async () => {
    const wrapped = wrap({ methods: ['POST'] });
    const oversized = new Uint8Array(MAX_REQUEST_BYTES + 1);
    const request = mutationRequest({ method: 'POST', body: oversized, duplex: 'half' });
    const response = await wrapped.handle(request);
    expect(response.status).toBe(413);
  });

  it('rejects a body over the size bound regardless of what content-length claims', async () => {
    const wrapped = wrap({ methods: ['POST'] });
    const oversized = new Uint8Array(MAX_REQUEST_BYTES + 1);
    const request = mutationRequest({
      method: 'POST', body: oversized, duplex: 'half',
      headers: { 'content-length': '1' },
    });
    const response = await wrapped.handle(request);
    expect(response.status).toBe(413);
  });

  it('accepts a body of exactly the size bound', async () => {
    const wrapped = wrap({ methods: ['POST'], handle: async () => new Response(null, { status: 204 }) });
    const exact = new Uint8Array(MAX_REQUEST_BYTES);
    const request = mutationRequest({ method: 'POST', body: exact, duplex: 'half' });
    const response = await wrapped.handle(request);
    expect(response.status).toBe(204);
  });

  it('rejects a body one byte over the size bound', async () => {
    const wrapped = wrap({ methods: ['POST'] });
    const overByOne = new Uint8Array(MAX_REQUEST_BYTES + 1);
    const request = mutationRequest({ method: 'POST', body: overByOne, duplex: 'half' });
    const response = await wrapped.handle(request);
    expect(response.status).toBe(413);
  });

  it('still passes the body through to the registration when it is within the size bound', async () => {
    const handle = vi.fn(async (request: Request) => new Response(await request.text(), { status: 200 }));
    const wrapped = wrap({ methods: ['POST'], handle });
    const request = mutationRequest({ method: 'POST', body: 'hello world', duplex: 'half' });
    const response = await wrapped.handle(request);
    expect(await response.text()).toBe('hello world');
  });

  it('maps an unexpected throw to a generic 500 with a request ID and no error detail', async () => {
    const wrapped = wrap({
      handle: async () => {
        throw new Error('secret-bearing-stack-trace');
      },
    });
    const response = await wrapped.handle(new Request('https://example.test/api/human/example'));
    expect(response.status).toBe(500);
    const body = await jsonOf(response);
    expect(body).toEqual({ code: 'internal_error', requestId: expect.any(String) });
    expect(JSON.stringify(body)).not.toContain('secret-bearing-stack-trace');
  });

  it('redacts a handler\'s own deliberate 500 response body instead of passing it through', async () => {
    const wrapped = wrap({
      handle: async () => new Response(JSON.stringify({ detail: 'stack trace with db connection string' }), { status: 500 }),
    });
    const response = await wrapped.handle(new Request('https://example.test/api/human/example'));
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(text).not.toContain('connection string');
    expect(JSON.parse(text)).toEqual({ code: 'internal_error', requestId: expect.any(String) });
  });

  it('passes a deliberate 401/403 response through unchanged', async () => {
    const wrapped = wrap({
      handle: async () => new Response(JSON.stringify({ code: 'unauthenticated' }), { status: 401 }),
    });
    const response = await wrapped.handle(new Request('https://example.test/api/human/example'));
    expect(response.status).toBe(401);
  });

  it('forces cache-control: no-store and nosniff on every response, since netlify.toml header rules never apply to functions', async () => {
    const wrapped = wrap({
      handle: async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'cache-control': 'public, max-age=60' } }),
    });
    const response = await wrapped.handle(new Request('https://example.test/api/human/example'));
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('redacts request headers and body content from logs on failure', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const wrapped = wrap({
      handle: async () => {
        throw new Error('boom');
      },
    });
    await wrapped.handle(new Request('https://example.test/api/human/example', {
      headers: { authorization: 'Bearer super-secret-token' },
    }));
    const logged = spy.mock.calls.map(call => call.join(' ')).join('\n');
    expect(logged).not.toContain('super-secret-token');
    expect(logged).not.toContain('authorization');
    spy.mockRestore();
  });

  it('never logs a thrown error\'s own message, since it may itself carry secret-bearing content', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const wrapped = wrap({
      handle: async () => {
        throw new Error('token=super-secret-token-value');
      },
    });
    await wrapped.handle(new Request('https://example.test/api/human/example'));
    const logged = spy.mock.calls.map(call => call.join(' ')).join('\n');
    expect(logged).not.toContain('super-secret-token-value');
    spy.mockRestore();
  });
});

describe('checkMutationOrigin', () => {
  it('never checks the origin of a safe method', () => {
    expect(checkMutationOrigin({ method: 'GET', headers: new Headers() }, APP_ORIGIN)).toBe('not_a_mutation');
    expect(checkMutationOrigin({ method: 'HEAD', headers: new Headers() }, APP_ORIGIN)).toBe('not_a_mutation');
    expect(checkMutationOrigin({ method: 'OPTIONS', headers: new Headers() }, APP_ORIGIN)).toBe('not_a_mutation');
  });

  it('forbids a mutation with a missing Origin header', () => {
    expect(checkMutationOrigin({ method: 'POST', headers: new Headers() }, APP_ORIGIN)).toBe('forbidden_origin');
  });

  it('forbids a mutation whose sec-fetch-site is not same-origin, even with a matching Origin header', () => {
    const headers = new Headers({ origin: APP_ORIGIN, 'sec-fetch-site': 'cross-site' });
    expect(checkMutationOrigin({ method: 'POST', headers }, APP_ORIGIN)).toBe('forbidden_origin');
  });

  it('allows a mutation with a matching Origin and no sec-fetch-site header (non-browser or older client)', () => {
    const headers = new Headers({ origin: APP_ORIGIN });
    expect(checkMutationOrigin({ method: 'POST', headers }, APP_ORIGIN)).toBe('ok');
  });
});

describe('createGateway', () => {
  it('serves the built-in health route without a producer', async () => {
    const gateway = createGateway({ registrations: [], absentPrefixes: [], appOrigin: APP_ORIGIN });
    const response = await gateway(new Request(`https://example.test${HEALTH_PATH}`));
    expect(response.status).toBe(200);
    expect((await jsonOf(response)).status).toBe('ok');
  });

  it('dispatches a known path to its registration', async () => {
    const handle = vi.fn(async () => new Response(null, { status: 204 }));
    const gateway = createGateway({ registrations: [registration({ handle })], absentPrefixes: [], appOrigin: APP_ORIGIN });
    const response = await gateway(new Request('https://example.test/api/human/example'));
    expect(response.status).toBe(204);
    expect(handle).toHaveBeenCalledOnce();
  });

  it('returns 404 for a genuinely unknown path', async () => {
    const gateway = createGateway({ registrations: [], absentPrefixes: [], appOrigin: APP_ORIGIN });
    const response = await gateway(new Request('https://example.test/api/nonexistent'));
    expect(response.status).toBe(404);
    expect((await jsonOf(response)).code).toBe('not_found');
  });

  it('returns 503 feature_unavailable for a reserved prefix with no built producer, never falling through to 404', async () => {
    const gateway = createGateway({ registrations: [], absentPrefixes: ['/api/agent/'], appOrigin: APP_ORIGIN });
    const response = await gateway(new Request('https://example.test/api/agent/bootstrap'));
    expect(response.status).toBe(503);
    expect((await jsonOf(response)).code).toBe('feature_unavailable');
  });

  it('dispatches a direct function-URL invocation identically to the /api/* form, including validation', async () => {
    const handle = vi.fn(async () => new Response(null, { status: 204 }));
    const gateway = createGateway({ registrations: [registration({ handle, methods: ['GET'] })], absentPrefixes: [], appOrigin: APP_ORIGIN });
    const direct = await gateway(new Request('https://example.test/.netlify/functions/khala-control/human/example', { method: 'POST' }));
    expect(direct.status).toBe(405);
    expect(handle).not.toHaveBeenCalled();
  });

  it('rejects a duplicate registered path at construction time', () => {
    expect(() => createGateway({
      registrations: [registration(), registration()],
      absentPrefixes: [],
      appOrigin: APP_ORIGIN,
    })).toThrow(/duplicate route path/);
  });

  it('never leaks configuration details in an API response body', async () => {
    const gateway = createGateway({ registrations: [], absentPrefixes: [], appOrigin: APP_ORIGIN });
    const response = await gateway(new Request('https://example.test/api/unknown'));
    const text = await response.text();
    expect(text).not.toMatch(/token|secret|namespace/i);
  });
});
