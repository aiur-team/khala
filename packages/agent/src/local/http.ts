import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import type { LocalAuth, LocalResponse, LocalRoute, HelperContext } from './types';

export const LOCAL_OWNER_COOKIE = 'khala_local_owner';
export const LOCAL_BODY_LIMIT_BYTES = 65_536;
export const LOCAL_CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'";
export type HelperServerOptions = {
  port: number;
  routes: readonly LocalRoute[];
  createContext(origin: string): HelperContext;
  webDir: string;
  idleMs: number;
  onIdle(): void;
  authenticateCookie(value: string): boolean;
  authenticateBearer(token: string): LocalAuth;
  log?: (line: string) => void;
};
export type HelperServer = {
  listen(): Promise<{ port: number; origin: string }>;
  close(): Promise<void>;
};
const mime: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};
function respond(res: ServerResponse, result: LocalResponse) {
  if (res.destroyed || res.writableEnded) return;
  for (const [key, value] of Object.entries(result.headers ?? {})) {
    if (!key.toLowerCase().startsWith('access-control-')) res.setHeader(key, value);
  }
  res.setHeader('cache-control', 'no-store');
  res.setHeader('x-content-type-options', 'nosniff');
  if ('location' in result) { res.statusCode = 302; res.setHeader('location', result.location); res.end(); }
  else {
    const body = result.json === undefined ? undefined : JSON.stringify(result.json);
    res.statusCode = result.status;
    if (body !== undefined) res.setHeader('content-type', 'application/json; charset=utf-8');
    res.end(body);
  }
}
function error(res: ServerResponse, status: number, code: string) { respond(res, { status, json: { error: code } }); }
function readBody(req: IncomingMessage, signal: AbortSignal): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []; let size = 0;
    const cleanup = () => { req.off('data', data); req.off('end', end); req.off('error', fail); signal.removeEventListener('abort', abort); };
    const fail = (err: unknown) => { cleanup(); reject(err); };
    const abort = () => fail(new Error('client_disconnected'));
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > LOCAL_BODY_LIMIT_BYTES) { cleanup(); chunks.length = 0; req.resume(); reject(new Error('payload_too_large')); }
      else chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      try { resolve(size === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Error('invalid_request')); }
    };
    req.on('data', data); req.on('end', end); req.on('error', fail); signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  });
}
const inside = (root: string, file: string) => file === root || file.startsWith(root + path.sep);
export function createHelperServer(options: HelperServerOptions): HelperServer {
  let port = 0; let origin = ''; let ctx: HelperContext;
  let inFlight = 0; let timer: ReturnType<typeof setTimeout> | undefined;
  let closing = false; let closePromise: Promise<void> | undefined;
  let listenPromise: Promise<{ port: number; origin: string }> | undefined;
  let cancelListen: (() => void) | undefined;
  const controllers = new Set<AbortController>();
  const webDir = path.resolve(options.webDir);
  const log = options.log ?? (line => { process.stderr.write(line + '\n'); });
  const armIdle = () => {
    clearTimeout(timer);
    if (!closing) timer = setTimeout(() => { if (inFlight === 0 && !closing) options.onIdle(); }, options.idleMs);
  };
  const server = createServer((req, res) => {
    inFlight++; clearTimeout(timer);
    const controller = new AbortController(); controllers.add(controller);
    res.once('close', () => {
      if (!res.writableEnded) controller.abort();
      controllers.delete(controller); inFlight--; if (inFlight === 0) armIdle();
    });
    void handle(req, res, controller.signal);
  });
  async function serveStatic(encoded: string, res: ServerResponse) {
    const index = path.join(webDir, 'index.html');
    try { if (!(await fs.stat(index)).isFile()) return error(res, 503, 'web_not_built'); }
    catch { return error(res, 503, 'web_not_built'); }
    let decoded: string;
    try { decoded = decodeURIComponent(encoded); } catch { return error(res, 400, 'invalid_request'); }
    let file = path.join(webDir, decoded);
    if (decoded.includes('\0') || !inside(webDir, file)) return error(res, 404, 'not_found');
    const root = await fs.realpath(webDir);
    let regular = false;
    try {
      if ((await fs.stat(file)).isFile()) {
        file = await fs.realpath(file);
        if (!inside(root, file)) return error(res, 404, 'not_found');
        regular = true;
      }
    } catch { /* A missing file may be a SPA route. */ }
    if (!regular) {
      if (decoded.startsWith('/assets/')) return error(res, 404, 'not_found');
      file = await fs.realpath(index);
      if (!inside(root, file)) return error(res, 404, 'not_found');
    }
    const bytes = await fs.readFile(file);
    if (res.destroyed) return;
    const extension = path.extname(file).toLowerCase();
    res.statusCode = 200;
    res.setHeader('content-type', mime[extension] ?? 'application/octet-stream');
    res.setHeader('cache-control', 'no-cache'); res.setHeader('x-content-type-options', 'nosniff');
    if (extension === '.html') { res.setHeader('content-security-policy', LOCAL_CSP); res.setHeader('referrer-policy', 'no-referrer'); }
    res.end(bytes);
  }
  async function handle(req: IncomingMessage, res: ServerResponse, signal: AbortSignal) {
    let routeIndex = -1;
    try {
      const host = req.headers.host?.toLowerCase();
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return error(res, 421, 'misdirected');
      const method = req.method;
      if (method !== 'GET' && method !== 'POST' && method !== 'PUT' && method !== 'DELETE') return error(res, 405, 'method_not_allowed');
      let url: URL;
      try { url = new URL(req.url!, origin); } catch { return error(res, 400, 'invalid_request'); }
      const pathname = url.pathname;
      if (pathname === '/healthz') return method === 'GET' ? respond(res, { status: 200, json: { ok: true, version: ctx.version, pid: process.pid } }) : error(res, 405, 'method_not_allowed');
      let auth: LocalAuth = { kind: 'none' };
      const authorization = req.headers.authorization;
      if (authorization !== undefined) {
        const bearer = /^Bearer ([A-Za-z0-9_-]{16,256})$/.exec(authorization);
        if (bearer) auth = options.authenticateBearer(bearer[1]!);
      } else {
        const value = req.headers.cookie?.split(';').map(piece => piece.trim()).find(piece => piece.startsWith(LOCAL_OWNER_COOKIE + '='))?.slice(LOCAL_OWNER_COOKIE.length + 1);
        if (value && /^[A-Za-z0-9_-]{43}$/.test(value) && options.authenticateCookie(value)) auth = { kind: 'owner', via: 'cookie' };
      }
      if (authorization === undefined && method !== 'GET' && auth.kind === 'owner' && auth.via === 'cookie' &&
          (req.headers['x-khala-local'] !== '1' || (req.headers.origin !== undefined && req.headers.origin !== origin))) return error(res, 403, 'forbidden_origin');
      if (!pathname.startsWith('/api/') && !pathname.startsWith('/open/')) return method === 'GET' ? await serveStatic(pathname, res) : error(res, 405, 'method_not_allowed');
      let body: unknown;
      if (method === 'POST' || method === 'PUT') {
        if (Number(req.headers['content-length']) > LOCAL_BODY_LIMIT_BYTES) { res.setHeader('connection', 'close'); req.resume(); return error(res, 413, 'payload_too_large'); }
        try { body = await readBody(req, signal); }
        catch (err) {
          if (signal.aborted) return;
          if (err instanceof Error && err.message === 'payload_too_large') { res.setHeader('connection', 'close'); return error(res, 413, 'payload_too_large'); }
          return error(res, 400, 'invalid_request');
        }
      }
      let matched = false;
      for (let i = 0; i < options.routes.length; i++) {
        const route = options.routes[i]!; route.pattern.lastIndex = 0;
        const match = route.pattern.exec(pathname); route.pattern.lastIndex = 0;
        if (!match) continue;
        matched = true; if (route.method !== method) continue;
        let params: string[];
        try { params = match.slice(1).map(decodeURIComponent); } catch { return error(res, 400, 'invalid_request'); }
        routeIndex = i;
        respond(res, await route.handle({ method, path: pathname, query: url.searchParams, headers: req.headers, body, auth, origin, signal }, params, ctx));
        return;
      }
      error(res, matched ? 405 : 404, matched ? 'method_not_allowed' : 'not_found');
    } catch (err) {
      // Only the error class is exposed; messages can contain credentials.
      const reason = err instanceof Error ? err.name : 'unknown_error';
      log(JSON.stringify({ at: 'route', method: req.method, route: routeIndex, reason }));
      if (!res.headersSent) error(res, 500, 'internal_error');
    }
  }
  return {
    listen() {
      if (closing) return Promise.reject(new Error('server_closed'));
      return listenPromise ??= new Promise((resolve, reject) => {
        const fail = (err: Error) => { cancelListen = undefined; reject(err); };
        cancelListen = () => { server.off('error', fail); reject(new Error('server_closed')); };
        server.once('error', fail);
        server.listen({ host: '127.0.0.1', port: options.port }, () => {
          server.off('error', fail); cancelListen = undefined;
          const address = server.address();
          if (!address || typeof address === 'string') return reject(new Error('invalid_address'));
          port = address.port; origin = `http://127.0.0.1:${port}`;
          try { ctx = options.createContext(origin); armIdle(); resolve({ port, origin }); }
          catch (err) { void server.close(); reject(err); }
        });
      });
    },
    close() {
      if (closePromise) return closePromise;
      closing = true; clearTimeout(timer); cancelListen?.(); cancelListen = undefined;
      for (const controller of controllers) controller.abort();
      closePromise = new Promise(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
      return closePromise;
    },
  };
}
