import { describe, expect, it, vi } from 'vitest';
import { HEALTH_PATH, createGateway, normalizePathname, wrapRegistration, type RouteRegistration } from './handler';

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

describe('wrapRegistration', () => {
  it('rejects a method the registration does not declare', async () => {
    const wrapped = wrapRegistration(registration({ methods: ['GET'] }));
    const response = await wrapped.handle(new Request('https://example.test/api/human/example', { method: 'POST' }));
    expect(response.status).toBe(405);
    expect((await jsonOf(response)).code).toBe('method_not_allowed');
  });

  it('rejects a declared payload over the size bound', async () => {
    const wrapped = wrapRegistration(registration({ methods: ['POST'] }));
    const response = await wrapped.handle(new Request('https://example.test/api/human/example', {
      method: 'POST',
      headers: { 'content-length': '5000000' },
    }));
    expect(response.status).toBe(413);
  });

  it('maps an unexpected throw to a generic 500 with a request ID and no error detail', async () => {
    const wrapped = wrapRegistration(registration({
      handle: async () => {
        throw new Error('secret-bearing-stack-trace');
      },
    }));
    const response = await wrapped.handle(new Request('https://example.test/api/human/example'));
    expect(response.status).toBe(500);
    const body = await jsonOf(response);
    expect(body).toEqual({ code: 'internal_error', requestId: expect.any(String) });
    expect(JSON.stringify(body)).not.toContain('secret-bearing-stack-trace');
  });

  it('passes a deliberate 401/403 response through unchanged', async () => {
    const wrapped = wrapRegistration(registration({
      handle: async () => new Response(JSON.stringify({ code: 'unauthenticated' }), { status: 401 }),
    }));
    const response = await wrapped.handle(new Request('https://example.test/api/human/example'));
    expect(response.status).toBe(401);
  });

  it('redacts request headers and body content from logs on failure', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const wrapped = wrapRegistration(registration({
      handle: async () => {
        throw new Error('boom');
      },
    }));
    await wrapped.handle(new Request('https://example.test/api/human/example', {
      headers: { authorization: 'Bearer super-secret-token' },
    }));
    const logged = spy.mock.calls.map(call => call.join(' ')).join('\n');
    expect(logged).not.toContain('super-secret-token');
    expect(logged).not.toContain('authorization');
    spy.mockRestore();
  });
});

describe('createGateway', () => {
  it('serves the built-in health route without a producer', async () => {
    const gateway = createGateway({ registrations: [], absentPrefixes: [] });
    const response = await gateway(new Request(`https://example.test${HEALTH_PATH}`));
    expect(response.status).toBe(200);
    expect((await jsonOf(response)).status).toBe('ok');
  });

  it('dispatches a known path to its registration', async () => {
    const handle = vi.fn(async () => new Response(null, { status: 204 }));
    const gateway = createGateway({ registrations: [registration({ handle })], absentPrefixes: [] });
    const response = await gateway(new Request('https://example.test/api/human/example'));
    expect(response.status).toBe(204);
    expect(handle).toHaveBeenCalledOnce();
  });

  it('returns 404 for a genuinely unknown path', async () => {
    const gateway = createGateway({ registrations: [], absentPrefixes: [] });
    const response = await gateway(new Request('https://example.test/api/nonexistent'));
    expect(response.status).toBe(404);
    expect((await jsonOf(response)).code).toBe('not_found');
  });

  it('returns 503 feature_unavailable for a reserved prefix with no built producer, never falling through to 404', async () => {
    const gateway = createGateway({ registrations: [], absentPrefixes: ['/api/agent/'] });
    const response = await gateway(new Request('https://example.test/api/agent/bootstrap'));
    expect(response.status).toBe(503);
    expect((await jsonOf(response)).code).toBe('feature_unavailable');
  });

  it('dispatches a direct function-URL invocation identically to the /api/* form, including validation', async () => {
    const handle = vi.fn(async () => new Response(null, { status: 204 }));
    const gateway = createGateway({ registrations: [registration({ handle, methods: ['GET'] })], absentPrefixes: [] });
    const direct = await gateway(new Request('https://example.test/.netlify/functions/khala-control/human/example', { method: 'POST' }));
    expect(direct.status).toBe(405);
    expect(handle).not.toHaveBeenCalled();
  });

  it('rejects a duplicate registered path at construction time', () => {
    expect(() => createGateway({
      registrations: [registration(), registration()],
      absentPrefixes: [],
    })).toThrow(/duplicate route path/);
  });

  it('never leaks configuration details in an API response body', async () => {
    const gateway = createGateway({ registrations: [], absentPrefixes: [] });
    const response = await gateway(new Request('https://example.test/api/unknown'));
    const text = await response.text();
    expect(text).not.toMatch(/token|secret|namespace/i);
  });
});
