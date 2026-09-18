// Bounded Netlify function wrapper: exact-path routing, method/size checks,
// request IDs and sanitized error mapping. Owned by KHA-131; KHA-132/133 own
// the domain handlers this dispatches to.

/** An exact, normalized HTTP path. No regex or parameter routes. */
export type RouteRegistration = Readonly<{
  path: string;
  methods: readonly string[];
  handle(request: Request): Promise<Response>;
}>;

/** Reserved API domain prefixes. Every registration's path must fall under one. */
export const RESERVED_PREFIXES = ['/api/human/', '/api/agent/'] as const;

export const HEALTH_PATH = '/api/health';

/** Conservative default; control requests are metadata, never message/media bodies. */
export const MAX_REQUEST_BYTES = 1_000_000;

const FUNCTION_PATH_PREFIX = '/.netlify/functions/khala-control';

/**
 * Maps a direct Netlify function invocation URL back to the logical `/api/...`
 * path so direct calls dispatch identically to the `/api/*` redirect and
 * cannot bypass route, method or auth validation.
 */
export function normalizePathname(pathname: string): string {
  if (pathname === FUNCTION_PATH_PREFIX) return '/api';
  if (pathname.startsWith(`${FUNCTION_PATH_PREFIX}/`)) return `/api${pathname.slice(FUNCTION_PATH_PREFIX.length)}`;
  return pathname;
}

function createRequestId(): string {
  return crypto.randomUUID();
}

function jsonResponse(status: number, code: string, requestId: string): Response {
  return new Response(JSON.stringify({ code, requestId }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-request-id': requestId },
  });
}

/**
 * Strips anything that could carry secrets or participant content before a
 * failure reaches logs: only the request ID, path and a generic reason survive.
 */
function logSanitizedError(requestId: string, path: string, error: unknown): void {
  const reason = error instanceof Error ? error.name : 'unknown_error';
  console.error(JSON.stringify({ requestId, path, reason }));
}

function payloadTooLarge(request: Request): boolean {
  const declared = request.headers.get('content-length');
  if (declared === null) return false;
  const size = Number(declared);
  return !Number.isFinite(size) || size > MAX_REQUEST_BYTES;
}

/**
 * Wraps one domain registration with method enforcement, a payload size bound,
 * a request ID and sanitized error mapping. Authentication/authorization stays
 * the domain handler's own responsibility via its injected identity port — this
 * wrapper only ever produces a generic 500 for an *unexpected* failure; a
 * deliberate 401/403 `Response` from the handler passes through untouched.
 */
export function wrapRegistration(registration: RouteRegistration): RouteRegistration {
  return {
    path: registration.path,
    methods: registration.methods,
    async handle(request) {
      const requestId = createRequestId();
      if (!registration.methods.includes(request.method)) return jsonResponse(405, 'method_not_allowed', requestId);
      if (payloadTooLarge(request)) return jsonResponse(413, 'payload_too_large', requestId);
      try {
        const response = await registration.handle(request);
        if (response.headers.has('x-request-id')) return response;
        const headers = new Headers(response.headers);
        headers.set('x-request-id', requestId);
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
      } catch (error) {
        logSanitizedError(requestId, registration.path, error);
        return jsonResponse(500, 'internal_error', requestId);
      }
    },
  };
}

function healthRegistration(): RouteRegistration {
  return {
    path: HEALTH_PATH,
    methods: ['GET'],
    async handle() {
      return new Response(JSON.stringify({ status: 'ok' }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
      });
    },
  };
}

export type GatewayOptions = Readonly<{
  /** Registrations from every discovered producer. Health is added automatically. */
  registrations: readonly RouteRegistration[];
  /** Reserved prefixes with no discovered producer module. */
  absentPrefixes: readonly string[];
}>;

/**
 * Builds the single Request -> Promise<Response> gateway function the
 * generated Netlify function exports. Exact-path dispatch only: 404 for an
 * unknown path outside a reserved prefix, 503 `feature_unavailable` for a
 * reserved prefix whose producer wasn't built, 405 for a known path with the
 * wrong method. Throws at construction time on a duplicate registered path —
 * that is a build-time defect, never a runtime state.
 */
export function createGateway(options: GatewayOptions): (request: Request) => Promise<Response> {
  const all = [healthRegistration(), ...options.registrations];
  const byPath = new Map<string, RouteRegistration>();
  for (const registration of all) {
    if (byPath.has(registration.path)) throw new Error(`duplicate route path: ${registration.path}`);
    byPath.set(registration.path, wrapRegistration(registration));
  }
  const absentPrefixes = options.absentPrefixes;

  return async function gateway(request: Request): Promise<Response> {
    const requestId = createRequestId();
    let pathname: string;
    try {
      pathname = normalizePathname(new URL(request.url).pathname);
    } catch {
      return jsonResponse(400, 'invalid_request', requestId);
    }
    const registration = byPath.get(pathname);
    if (registration) return registration.handle(request);
    if (absentPrefixes.some(prefix => pathname.startsWith(prefix))) return jsonResponse(503, 'feature_unavailable', requestId);
    return jsonResponse(404, 'not_found', requestId);
  };
}
