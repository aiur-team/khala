import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { BodyError, type ErrorCode, headerValues, readBoundedBody, sendError } from './http';

export const LOOPBACK_HOST = '127.0.0.1';
export const DEFAULT_START_PORT = 4870;

/**
 * `public` routes are credentialless GETs. `bootstrap` requires the exact Origin
 * before its bounded body is read. `authenticated` routes require a caller-validated
 * principal before the handler (and therefore any body reader or store) runs.
 */
export type Admission = 'public' | 'bootstrap' | 'authenticated';
export type RouteMethod = 'GET' | 'POST';

export type RouteSpec = Readonly<{
  method: RouteMethod;
  /** Exact path; `:name` segments match one unreserved, undecoded segment. */
  path: string;
  /** Normalized template used in logs. Defaults to `path`. */
  template?: string;
  admission: Admission;
  allowQuery?: boolean;
}>;

export type AuthOutcome<Principal> =
  | Readonly<{ ok: true; principal: Principal }>
  | Readonly<{ ok: false; status: number; code: ErrorCode }>;

export type RouteContext<Principal> = Readonly<{
  requestId: number;
  request: IncomingMessage;
  response: ServerResponse;
  route: RouteSpec;
  params: Readonly<Record<string, string>>;
  query: URLSearchParams;
  /** Null only on `public` and `bootstrap` routes. */
  principal: Principal | null;
  /** Reads a bounded body; available only after every admission check passed. */
  readBody(maxBytes?: number): Promise<Buffer>;
  /** Releases the ordinary request slot for a long-lived stream that is bounded separately. */
  detach(): void;
  /** Aborted when the server closes. */
  signal: AbortSignal;
}>;

export type LogEvent =
  | Readonly<{ type: 'listening'; port: number }>
  | Readonly<{ type: 'closed' }>
  | Readonly<{
    type: 'request';
    requestId: number;
    method: RouteMethod | 'OTHER';
    route: string;
    status: number;
    durationMs: number;
    code?: ErrorCode;
  }>
  | Readonly<{ type: 'client_error'; code: 'malformed_request' | 'timeout' }>;

export type ServerLimits = Readonly<{
  maxPortAttempts: number;
  maxConnections: number;
  maxConcurrentRequests: number;
  maxHeaderBytes: number;
  maxHeaderCount: number;
  maxBodyBytes: number;
  maxRequestsPerSocket: number;
  maxTargetBytes: number;
  headersTimeoutMs: number;
  requestTimeoutMs: number;
  keepAliveTimeoutMs: number;
  socketIdleTimeoutMs: number;
  timeoutCheckIntervalMs: number;
}>;

export const DEFAULT_LIMITS: ServerLimits = {
  maxPortAttempts: 16,
  maxConnections: 64,
  maxConcurrentRequests: 32,
  maxHeaderBytes: 8 * 1024,
  maxHeaderCount: 48,
  maxBodyBytes: 64 * 1024,
  maxRequestsPerSocket: 100,
  maxTargetBytes: 2048,
  headersTimeoutMs: 5_000,
  requestTimeoutMs: 10_000,
  keepAliveTimeoutMs: 5_000,
  socketIdleTimeoutMs: 60_000,
  timeoutCheckIntervalMs: 1_000,
};

export type LoopbackServerOptions<Principal> = Readonly<{
  /** First port to try; `0` requests an ephemeral port and is intended for tests. */
  startPort?: number;
  limits?: Partial<ServerLimits>;
  routes: readonly RouteSpec[];
  authenticate(input: Readonly<{
    request: IncomingMessage;
    route: RouteSpec;
    params: Readonly<Record<string, string>>;
  }>): Promise<AuthOutcome<Principal>> | AuthOutcome<Principal>;
  handle(context: RouteContext<Principal>): Promise<void> | void;
  log?: (event: LogEvent) => void;
}>;

export type LoopbackServer = Readonly<{
  port: number;
  origin: string;
  close(): Promise<void>;
}>;

export class LoopbackServerError extends Error {
  readonly code: 'invalid_options' | 'ports_exhausted' | 'listen_failed';
  constructor(code: LoopbackServerError['code']) {
    super(`loopback server: ${code}`);
    this.name = 'LoopbackServerError';
    this.code = code;
  }
}

type CompiledRoute = Readonly<{ spec: RouteSpec; segments: readonly string[] }>;

const PARAM_SEGMENT = /^[A-Za-z0-9._~-]{1,256}$/;
const TARGET_CHARACTERS = /^\/[\x21-\x7e]*$/;

function compile(routes: readonly RouteSpec[]): CompiledRoute[] {
  const seen = new Set<string>();
  return routes.map(spec => {
    if (!spec.path.startsWith('/') || seen.has(`${spec.method} ${spec.path}`)) throw new LoopbackServerError('invalid_options');
    seen.add(`${spec.method} ${spec.path}`);
    return { spec, segments: spec.path.split('/').slice(1) };
  });
}

function matchPath(route: CompiledRoute, segments: readonly string[]): Record<string, string> | null {
  if (route.segments.length !== segments.length) return null;
  const params: Record<string, string> = {};
  for (const [index, pattern] of route.segments.entries()) {
    const actual = segments[index]!;
    if (pattern.startsWith(':')) {
      if (!PARAM_SEGMENT.test(actual) || actual === '.' || actual === '..') return null;
      params[pattern.slice(1)] = actual;
    } else if (pattern !== actual) {
      return null;
    }
  }
  return params;
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ host: LOOPBACK_HOST, port, exclusive: true });
  });
}

export async function startLoopbackServer<Principal>(options: LoopbackServerOptions<Principal>): Promise<LoopbackServer> {
  const limits: ServerLimits = { ...DEFAULT_LIMITS, ...options.limits };
  const startPort = options.startPort ?? DEFAULT_START_PORT;
  if (!Number.isSafeInteger(startPort) || startPort < 0 || startPort > 65_535) throw new LoopbackServerError('invalid_options');
  const routes = compile(options.routes);
  const log = (event: LogEvent) => {
    try { options.log?.(event); } catch { /* Logging never changes request outcomes. */ }
  };
  const closing = new AbortController();
  let boundPort = 0;
  let active = 0;
  let nextRequestId = 1;

  const server = createServer({
    maxHeaderSize: limits.maxHeaderBytes,
    headersTimeout: limits.headersTimeoutMs,
    requestTimeout: limits.requestTimeoutMs,
    keepAliveTimeout: limits.keepAliveTimeoutMs,
    connectionsCheckingInterval: limits.timeoutCheckIntervalMs,
    requireHostHeader: true,
    joinDuplicateHeaders: false,
    insecureHTTPParser: false,
  });
  server.maxHeadersCount = limits.maxHeaderCount;
  server.maxRequestsPerSocket = limits.maxRequestsPerSocket;
  server.maxConnections = limits.maxConnections;
  server.timeout = limits.socketIdleTimeoutMs;
  server.on('clientError', (error: NodeJS.ErrnoException, socket: Socket) => {
    const timedOut = error.code === 'ERR_HTTP_REQUEST_TIMEOUT';
    log({ type: 'client_error', code: timedOut ? 'timeout' : 'malformed_request' });
    const status = timedOut ? '408 Request Timeout'
      : error.code === 'HPE_HEADER_OVERFLOW' ? '431 Request Header Fields Too Large' : '400 Bad Request';
    if (socket.writable && !(socket as Socket & { _httpMessage?: unknown })._httpMessage) {
      socket.end(`HTTP/1.1 ${status}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`);
    }
    socket.destroySoon();
  });

  server.on('request', (request: IncomingMessage, response: ServerResponse) => {
    const requestId = nextRequestId++;
    const started = performance.now();
    const method: RouteMethod | 'OTHER' = request.method === 'GET' || request.method === 'POST' ? request.method : 'OTHER';
    let template = 'unmatched';
    let code: ErrorCode | undefined;
    let counted = false;
    const release = () => {
      if (!counted) return;
      counted = false;
      active -= 1;
    };
    response.once('close', () => {
      release();
      log({
        type: 'request',
        requestId,
        method,
        route: template,
        status: response.statusCode,
        durationMs: Math.round(performance.now() - started),
        ...(code ? { code } : {}),
      });
    });
    const reject = (status: number, errorCode: ErrorCode, extra: Readonly<Record<string, string>> = {}) => {
      code = errorCode;
      for (const [name, value] of Object.entries(extra)) response.setHeader(name, value);
      // Closing the connection means the unread request body is never consumed.
      sendError(response, status, errorCode, true);
    };

    // Stage 1: target and exact authority, before routing.
    const target = request.url ?? '';
    if (target.length > limits.maxTargetBytes || !TARGET_CHARACTERS.test(target) || target.startsWith('//')
      || target.includes('\\')) {
      reject(400, 'bad_request');
      return;
    }
    const hosts = headerValues(request, 'host');
    if (hosts.length !== 1 || hosts[0] !== `${LOOPBACK_HOST}:${boundPort}`) {
      reject(400, 'invalid_host');
      return;
    }
    const queryIndex = target.indexOf('?');
    const path = queryIndex === -1 ? target : target.slice(0, queryIndex);
    const rawQuery = queryIndex === -1 ? '' : target.slice(queryIndex + 1);
    if (path.includes('#')) {
      reject(400, 'bad_request');
      return;
    }
    const segments = path.split('/').slice(1);
    let matched: Readonly<{ route: CompiledRoute; params: Record<string, string> }> | null = null;
    let pathKnown = false;
    for (const route of routes) {
      const params = matchPath(route, segments);
      if (!params) continue;
      pathKnown = true;
      if (route.spec.method === request.method) {
        matched = { route, params };
        break;
      }
    }
    if (!matched) {
      if (pathKnown) reject(405, 'method_not_allowed');
      else reject(404, 'not_found');
      return;
    }
    const spec = matched.route.spec;
    template = spec.template ?? spec.path;
    if (rawQuery !== '' && !spec.allowQuery) {
      reject(400, 'bad_request');
      return;
    }

    // Stage 1b: route-specific Origin and Fetch Metadata, still before any body or store.
    if (spec.admission !== 'public' && !originAdmitted(request, spec, boundPort)) {
      reject(403, 'forbidden_origin');
      return;
    }
    if (active >= limits.maxConcurrentRequests) {
      reject(503, 'too_many_requests', { 'retry-after': '1' });
      return;
    }
    active += 1;
    counted = true;

    void (async () => {
      try {
        // Stage 2: credentials, before the handler receives a body reader.
        let principal: Principal | null = null;
        if (spec.admission === 'authenticated') {
          const outcome = await options.authenticate({ request, route: spec, params: matched.params });
          if (!outcome.ok) {
            reject(outcome.status, outcome.code);
            return;
          }
          principal = outcome.principal;
        }
        await options.handle({
          requestId,
          request,
          response,
          route: spec,
          params: matched.params,
          query: new URLSearchParams(rawQuery),
          principal,
          readBody: (maxBytes = limits.maxBodyBytes) => readBoundedBody(request, Math.min(maxBytes, limits.maxBodyBytes)),
          detach: release,
          signal: closing.signal,
        });
      } catch (error) {
        if (error instanceof BodyError) reject(error.status, error.code);
        else if (!response.headersSent) reject(500, 'internal_error');
        else response.destroy();
      }
    })();
  });

  const first = startPort;
  const attempts = startPort === 0 ? 1 : limits.maxPortAttempts;
  for (let offset = 0; offset < attempts; offset += 1) {
    const port = first + offset;
    if (port > 65_535) break;
    try {
      await listen(server, port);
      const address = server.address();
      if (!address || typeof address === 'string' || address.address !== LOOPBACK_HOST) {
        server.close();
        throw new LoopbackServerError('listen_failed');
      }
      boundPort = address.port;
      break;
    } catch (error) {
      if (error instanceof LoopbackServerError) throw error;
      // Only an occupied port advances the search; every other failure is terminal.
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw new LoopbackServerError('listen_failed');
    }
  }
  if (boundPort === 0) throw new LoopbackServerError('ports_exhausted');
  log({ type: 'listening', port: boundPort });

  let closed: Promise<void> | null = null;
  return {
    port: boundPort,
    origin: `http://${LOOPBACK_HOST}:${boundPort}`,
    close() {
      closed ??= new Promise<void>(resolve => {
        closing.abort();
        server.close(() => {
          log({ type: 'closed' });
          resolve();
        });
        server.closeAllConnections();
      });
      return closed;
    },
  };
}

function originAdmitted(request: IncomingMessage, spec: RouteSpec, port: number): boolean {
  const expected = `http://${LOOPBACK_HOST}:${port}`;
  const origins = headerValues(request, 'origin');
  const sites = headerValues(request, 'sec-fetch-site');
  if (origins.length > 1 || sites.length > 1) return false;
  if (sites.length === 1 && sites[0] !== 'same-origin') return false;
  if (origins.length === 1) return origins[0] === expected;
  if (spec.admission === 'bootstrap') return false;
  // A bearer-only agent request may omit Origin; cookie-bearing mutations may not.
  const bearerOnly = headerValues(request, 'authorization').length > 0 && headerValues(request, 'cookie').length === 0;
  return spec.method === 'GET' || bearerOnly;
}
