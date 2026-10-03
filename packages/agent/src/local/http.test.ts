import { afterEach, expect, test } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { request } from 'node:http';
import { createHelperServer, LOCAL_CSP, type HelperServer } from './http';
import type { HelperContext, LocalRoute } from './types';

const cookie = 'S'.repeat(43);
const admin = 'A'.repeat(43);
const servers: HelperServer[] = [];
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()));
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});
async function fixture(routes?: LocalRoute[], idleMs = 10_000, onIdle = () => {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'khala-http-'));
  dirs.push(dir);
  const webDir = path.join(dir, 'web');
  await mkdir(path.join(webDir, 'assets'), { recursive: true });
  await writeFile(path.join(webDir, 'index.html'), '<title>app</title>');
  await writeFile(path.join(webDir, 'assets/app.js'), 'app();');
  await writeFile(path.join(dir, 'secret.txt'), 'secret');
  const logs: string[] = [];
  const origins: string[] = [];
  const server = createHelperServer({ port: 0, webDir, idleMs, onIdle,
    createContext: origin => { origins.push(origin); return { origin, version: 'test' } as HelperContext; },
    authenticateCookie: value => value === cookie,
    authenticateBearer: token => token === admin ? { kind: 'owner', via: 'admin' } : token === 'G'.repeat(43) ? { kind: 'agent', userId: 'agent', roomId: 'room' } : { kind: 'none' },
    log: line => logs.push(line),
    routes: routes ?? ['GET', 'POST', 'PUT', 'DELETE'].map(method => ({ method: method as LocalRoute['method'], pattern: /^\/api\/([^/]+)$/, handle: async (req, params) => ({ status: 200, json: { auth: req.auth, body: req.body, params, query: Object.fromEntries(req.query) } }) })),
  });
  servers.push(server);
  return { ...await server.listen(), server, webDir, dir, logs, origins };
}
function raw(port: number, target: string, method = 'GET', headers: Record<string, string> = {}, body = '') {
  return new Promise<{ status: number; headers: import('node:http').IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path: target, method, headers: { ...(body && method === 'DELETE' ? { 'content-length': String(Buffer.byteLength(body)) } : {}), ...headers } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', chunk => text += chunk);
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: text }));
    });
    req.on('error', reject); req.end(body);
  });
}
function noCors(headers: Record<string, unknown>) { expect(Object.keys(headers).some(key => key.startsWith('access-control-'))).toBe(false); }

test('bind, health, Host and method guards precede auth', async () => {
  const f = await fixture();
  expect(f.origin).toBe(`http://127.0.0.1:${f.port}`); expect(f.origins).toEqual([f.origin]);
  for (const host of ['evil.test:' + f.port, '127.0.0.1:' + (f.port + 1)]) expect((await raw(f.port, '/healthz', 'GET', { host })).status).toBe(421);
  const health = await raw(f.port, '/healthz', 'GET', { host: 'LOCALHOST:' + f.port });
  expect(JSON.parse(health.body)).toEqual({ ok: true, version: 'test', pid: process.pid }); noCors(health.headers);
  expect((await raw(f.port, '/healthz', 'POST')).status).toBe(405);
  const preflight = await raw(f.port, '/api/x', 'OPTIONS', { origin: 'https://evil.test' });
  expect(preflight.status).toBe(405); noCors(preflight.headers);
});
test('cookie mutations and bearer precedence', async () => {
  const f = await fixture(); const headers = { cookie: `khala_local_owner=${cookie}` };
  expect((await raw(f.port, '/api/x', 'POST', headers)).status).toBe(403);
  for (const origin of ['https://evil.test', `http://localhost:${f.port}`]) expect((await raw(f.port, '/api/x', 'POST', { ...headers, 'x-khala-local': '1', origin })).status).toBe(403);
  for (const method of ['GET', 'POST']) {
    const res = await raw(f.port, '/api/x', method, method === 'GET' ? headers : { ...headers, 'x-khala-local': '1', origin: f.origin });
    expect(JSON.parse(res.body).auth).toEqual({ kind: 'owner', via: 'cookie' });
  }
  for (const [authorization, auth] of [[`Bearer ${admin}`, { kind: 'owner', via: 'admin' }], [`Bearer ${'G'.repeat(43)}`, { kind: 'agent', userId: 'agent', roomId: 'room' }], ['Bearer unknown', { kind: 'none' }], ['broken', { kind: 'none' }]] as const) {
    const res = await raw(f.port, '/api/x', 'POST', { ...headers, authorization, origin: 'https://evil.test' });
    expect(res.status).toBe(200); expect(JSON.parse(res.body).auth).toEqual(auth); noCors(res.headers);
  }
  expect(JSON.parse((await raw(f.port, '/api/x', 'POST', { cookie: 'khala_local_owner=short' })).body).auth).toEqual({ kind: 'none' });
});
test('JSON byte limits, invalid input and decoded routing', async () => {
  const f = await fixture();
  expect(JSON.parse((await raw(f.port, '/api/%21room%3Alocal?after=3', 'POST', {}, '{"a":1}')).body)).toMatchObject({ body: { a: 1 }, params: ['!room:local'], query: { after: '3' } });
  for (const method of ['POST', 'DELETE', 'GET']) expect(JSON.parse((await raw(f.port, '/api/x', method)).body)).not.toHaveProperty('body');
  expect((await raw(f.port, '/api/x', 'POST', {}, 'bad')).status).toBe(400);
  expect((await raw(f.port, '/api/x', 'DELETE', {}, 'bad')).status).toBe(200);
  for (const headers of [{}, { 'content-length': '65537' }]) expect((await raw(f.port, '/api/x', 'POST', headers, '"' + 'x'.repeat(65535) + '"')).status).toBe(413);
  expect((await raw(f.port, '/api/x', 'POST', {}, '"' + 'x'.repeat(65534) + '"')).status).toBe(200);
  expect((await raw(f.port, '/api/%E0%A4%A')).status).toBe(400);
  expect((await raw(f.port, '/api/no/match')).status).toBe(404);
  const only = await fixture([{ method: 'GET', pattern: /^\/api\/x$/g, handle: async () => ({ status: 204 }) }]);
  expect((await raw(only.port, '/api/x', 'POST')).status).toBe(405);
  for (let i = 0; i < 2; i++) expect((await raw(only.port, '/api/x')).status).toBe(204);
});
test('redirect headers, error mapping and sanitized logs', async () => {
  const f = await fixture([
    { method: 'GET', pattern: /^\/open\/x$/, handle: async () => ({ status: 302, location: '/channels', headers: { 'set-cookie': 'session', 'access-control-allow-origin': '*' } }) },
    { method: 'GET', pattern: /^\/api\/x$/, handle: async () => { throw new TypeError('secret /open/token'); } },
  ]);
  const redirect = await raw(f.port, '/open/x'); expect(redirect.status).toBe(302); expect(redirect.headers.location).toBe('/channels'); expect(redirect.headers['set-cookie']).toEqual(['session']); noCors(redirect.headers);
  const error = await raw(f.port, '/api/x'); expect(error.status).toBe(500); expect(JSON.parse(error.body)).toEqual({ error: 'internal_error' });
  expect(f.logs.map(line => JSON.parse(line))).toEqual([{ at: 'route', method: 'GET', route: 1, reason: 'TypeError' }]);
});
test('static SPA, headers, traversal, symlinks and rebuilding', async () => {
  const f = await fixture();
  for (const target of ['/', '/channels/%21abc%3Alocal', '/join/token']) {
    const res = await raw(f.port, target); expect(res.body).toBe('<title>app</title>'); expect(res.headers['content-security-policy']).toBe(LOCAL_CSP); expect(res.headers['referrer-policy']).toBe('no-referrer'); expect(res.headers['cache-control']).toBe('no-cache'); noCors(res.headers);
  }
  const asset = await raw(f.port, '/assets/app.js'); expect(asset.body).toBe('app();'); expect(asset.headers['content-type']).toBe('text/javascript; charset=utf-8');
  expect((await raw(f.port, '/assets/missing.js')).status).toBe(404);
  expect((await raw(f.port, '/channels', 'POST')).status).toBe(405);
  await symlink(path.join(f.dir, 'secret.txt'), path.join(f.webDir, 'assets/link.js'));
  expect((await raw(f.port, '/assets/link.js')).status).toBe(404);
  for (const target of ['/..%2Fsecret.txt', '/assets/..%2F..%2Fsecret.txt', '/%2e%2e/secret.txt']) expect((await raw(f.port, target)).body).not.toBe('secret');
  expect((await raw(f.port, '/%00')).status).toBe(404); expect((await raw(f.port, '/%ZZ')).status).toBe(400);
  await rm(path.join(f.webDir, 'index.html')); expect((await raw(f.port, '/conversations')).status).toBe(503);
  expect((await raw(f.port, '/healthz')).status).toBe(200); expect((await raw(f.port, '/api/x')).status).toBe(200);
  await writeFile(path.join(f.webDir, 'index.html'), 'rebuilt'); expect((await raw(f.port, '/')).body).toBe('rebuilt');
});
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
test('idle fires once per period and closes idempotently', async () => {
  let idle = 0; const f = await fixture(undefined, 30, () => idle++);
  await delay(90); expect(idle).toBe(1); await raw(f.port, '/healthz'); await delay(70); expect(idle).toBe(2);
  await Promise.all([f.server.close(), f.server.close()]); await expect(raw(f.port, '/healthz')).rejects.toThrow();
});
test('long polls hold idle, disconnect and close abort signals', async () => {
  let idle = 0; let started!: () => void; let aborted!: () => void;
  let start = new Promise<void>(resolve => started = resolve);
  let abort = new Promise<void>(resolve => aborted = resolve);
  const f = await fixture([{ method: 'GET', pattern: /^\/api\/poll$/, handle: async req => {
    started(); await new Promise<void>(resolve => req.signal.addEventListener('abort', () => { aborted(); resolve(); }, { once: true }));
    return { status: 204 };
  } }], 30, () => idle++);
  const client = request(f.origin + '/api/poll'); client.on('error', () => {}); client.end(); await start;
  await delay(90); expect(idle).toBe(0); client.destroy(); await abort; await delay(70); expect(idle).toBe(1);
  start = new Promise<void>(resolve => started = resolve); abort = new Promise<void>(resolve => aborted = resolve);
  const second = request(f.origin + '/api/poll'); second.on('error', () => {}); second.end(); await start;
  await f.server.close(); await abort; await delay(70); expect(idle).toBe(1);
});
test('close cancels pending startup and works before listen', async () => {
  const server = createHelperServer({ port: 0, webDir: '/', idleMs: 1000, onIdle() {}, routes: [],
    createContext: origin => ({ origin, version: 'test' } as HelperContext), authenticateCookie: () => false, authenticateBearer: () => ({ kind: 'none' }),
  });
  servers.push(server);
  const listening = server.listen();
  const rejected = expect(listening).rejects.toThrow('server_closed');
  await server.close(); await rejected;
});

test('idle restarts after a successful long poll', async () => {
  let idle = 0;
  let finish!: () => void; let started!: () => void;
  const start = new Promise<void>(resolve => started = resolve);
  const f = await fixture([{ method: 'GET', pattern: /^\/api\/poll$/, handle: async () => {
    started(); await new Promise<void>(resolve => finish = resolve); return { status: 204 };
  } }], 30, () => idle++);
  const response = raw(f.port, '/api/poll'); await start;
  await delay(90); expect(idle).toBe(0); finish(); expect((await response).status).toBe(204);
  await delay(70); expect(idle).toBe(1);
});
test('bind errors preserve the original Node error and closing unstarted servers is safe', async () => {
  const occupied = await fixture();
  const options = { port: occupied.port, webDir: occupied.webDir, idleMs: 1000, onIdle() {}, routes: [],
    createContext: () => { throw new Error('must not create context'); }, authenticateCookie: () => false, authenticateBearer: () => ({ kind: 'none' as const }),
  };
  const competing = createHelperServer(options); servers.push(competing);
  await expect(competing.listen()).rejects.toMatchObject({ code: 'EADDRINUSE' }); await competing.close();
  const unstarted = createHelperServer(options); servers.push(unstarted); await unstarted.close(); await unstarted.close();
  await expect(unstarted.listen()).rejects.toThrow('server_closed');
});
