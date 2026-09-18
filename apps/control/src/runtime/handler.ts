// Bounded Netlify function wrapper: exact-path routing, method/size/origin
// checks, request IDs and sanitized error mapping. Owned by KHA-131;
// KHA-132/133 own the domain handlers this dispatches to.

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
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-request-id': requestId,
    },
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

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export type OriginCheck = 'ok' | 'not_a_mutation' | 'forbidden_origin';

/**
 * Exact-origin check for state-changing requests. Mirrors the policy in
 * `apps/control/src/auth/csrf.ts` (KHA-110); duplicated here rather than
 * imported because that module doesn't exist on this ticket's dependency yet.
 * Unify once both land.
 */
export function checkMutationOrigin(request: Pick<Request, 'method' | 'headers'>, origin: string): OriginCheck {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return 'not_a_mutation';
  if (request.headers.get('origin') !== origin) return 'forbidden_origin';
  const site = request.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin') return 'forbidden_origin';
  return 'ok';
}

/**
 * Reads the body while enforcing `MAX_REQUEST_BYTES`, rather than trusting the
 * client-supplied `content-length` header: a streamed body can omit or lie
 * about that header entirely. Returns the buffered body so the wrapped
 * registration can still consume it once the limit check has passed.
 */
async function readBoundedBody(request: Request): Promise<{ tooLarge: true } | { tooLarge: false; body: Uint8Array | null }> {
  if (request.body === null) return { tooLarge: false, body: null };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_REQUEST_BYTES) {
      await reader.cancel();
      return { tooLarge: true };
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { tooLarge: false, body };
}

export type WrapOptions = Readonly<{
  /** The single production/preview app origin state-changing requests must present. */
  appOrigin: string;
}>;

/**
 * Wraps one domain registration with method enforcement, an Origin check on
 * state-changing methods, a payload size bound enforced against the actual
 * body (not the declared `content-length`), a request ID and sanitized error
 * mapping. Authentication/authorization stays the domain handler's own
 * responsibility via its injected identity port — this wrapper only ever
 * produces a generic 500 for an *unexpected* failure; a deliberate 401/403
 * `Response` from the handler passes through untouched.
 */
export function wrapRegistration(registration: RouteRegistration, options: WrapOptions): RouteRegistration {
  return {
    path: registration.path,
    methods: registration.methods,
    async handle(request) {
      const requestId = createRequestId();
      if (!registration.methods.includes(request.method)) return jsonResponse(405, 'method_not_allowed', requestId);
      if (checkMutationOrigin(request, options.appOrigin) === 'forbidden_origin') {
        return jsonResponse(403, 'forbidden_origin', requestId);
      }
      const bodyCheck = await readBoundedBody(request);
      if (bodyCheck.tooLarge) return jsonResponse(413, 'payload_too_large', requestId);
      const boundedRequest = bodyCheck.body !== null ? new Request(request, { body: bodyCheck.body }) : request;
      try {
        const response = await registration.handle(boundedRequest);
        // netlify.toml's `[[headers]]` rules apply to static/CDN-served paths,
        // never to a function's own response — force the same baseline here.
        if (response.status === 500) {
          // Never trust a domain handler's own 500 body: force the generic
          // shape so an unsanitized detail can't leak through it either.
          return jsonResponse(500, 'internal_error', requestId);
        }
        const headers = new Headers(response.headers);
        headers.set('cache-control', 'no-store');
        headers.set('x-content-type-options', 'nosniff');
        if (!headers.has('x-request-id')) headers.set('x-request-id', requestId);
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
  /** The single production/preview app origin state-changing requests must present. */
  appOrigin: string;
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
    byPath.set(registration.path, wrapRegistration(registration, { appOrigin: options.appOrigin }));
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
