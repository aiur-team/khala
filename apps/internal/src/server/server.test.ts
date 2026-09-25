import { request as httpRequest } from 'node:http';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { CONTENT_SECURITY_POLICY, sendNoContent } from './http';
import {
  type LogEvent, type LoopbackServer, type LoopbackServerOptions, LoopbackServerError, startLoopbackServer,
} from './server';

const VALID_CREDENTIAL = 'a'.repeat(43);

const servers: LoopbackServer[] = [];
const blockers: net.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()));
  await Promise.all(blockers.splice(0).map(blocker => new Promise(resolve => blocker.close(resolve))));
});

describe('loopback request admission', () => {
  it('rejects a valid credential with localhost Host before body or store access', async () => {
    const observed = { bodyReads: 0, storeReads: 0 };
    const server = await startHarness(observed);

    const response = await sendIncompleteMutation(server.port, {
      host: `localhost:${server.port}`,
      origin: `http://127.0.0.1:${server.port}`,
    });

    expect(observed).toEqual({ bodyReads: 0, storeReads: 0 });
    expect(response.status).toBe(400);
  });

  it('rejects a valid credential with hostile mutation Origin before body or store access', async () => {
    const observed = { bodyReads: 0, storeReads: 0 };
    const server = await startHarness(observed);

    const response = await sendIncompleteMutation(server.port, {
      host: `127.0.0.1:${server.port}`,
      origin: 'https://hostile.example',
    });

    expect(observed).toEqual({ bodyReads: 0, storeReads: 0 });
    expect(response.status).toBe(403);
  });

  it('admits the exact authority and origin and only then reads the body', async () => {
    const observed = { bodyReads: 0, storeReads: 0 };
    const server = await startHarness(observed);
    const response = await raw(server.port, [
      'POST /api/v1/messages HTTP/1.1',
      `Host: 127.0.0.1:${server.port}`,
      `Origin: http://127.0.0.1:${server.port}`,
      `Authorization: Bearer ${VALID_CREDENTIAL}`,
      'Content-Length: 2',
      'Connection: close',
      '',
      '{}',
    ]);
    expect(response.status).toBe(204);
    expect(observed).toEqual({ bodyReads: 1, storeReads: 1 });
  });

  it.each([
    ['localhost', port => [`Host: localhost:${port}`]],
    ['short IPv4', port => [`Host: 127.1:${port}`]],
    ['decimal IPv4', port => [`Host: 2130706433:${port}`]],
    ['missing port', () => ['Host: 127.0.0.1']],
    ['wrong port', port => [`Host: 127.0.0.1:${port + 1}`]],
    ['trailing dot', port => [`Host: 127.0.0.1.:${port}`]],
    ['duplicate hosts', port => [`Host: 127.0.0.1:${port}`, `Host: 127.0.0.1:${port}`]],
    ['IPv6 loopback', port => [`Host: [::1]:${port}`]],
  ] satisfies ReadonlyArray<readonly [string, (port: number) => string[]]>)('rejects Host %s before authentication', async (_name, hosts) => {
    const observed = { bodyReads: 0, storeReads: 0 };
    const server = await startHarness(observed);
    const response = await raw(server.port, [
      'POST /api/v1/messages HTTP/1.1',
      ...hosts(server.port),
      `Authorization: Bearer ${VALID_CREDENTIAL}`,
      'Content-Length: 2',
      '',
      '{}',
    ]);
    expect(response.status).toBe(400);
    expect(observed).toEqual({ bodyReads: 0, storeReads: 0 });
  });

  it('rejects absolute-form and malformed request targets', async () => {
    const observed = { bodyReads: 0, storeReads: 0 };
    const server = await startHarness(observed);
    for (const target of [
      `http://127.0.0.1:${server.port}/api/v1/messages`,
      `http://localhost:${server.port}/api/v1/messages`,
      '//api/v1/messages',
      '/api/v1/messages\\..',
    ]) {
      const response = await raw(server.port, [
        `POST ${target} HTTP/1.1`,
        `Host: 127.0.0.1:${server.port}`,
        `Authorization: Bearer ${VALID_CREDENTIAL}`,
        'Content-Length: 2',
        '',
        '{}',
      ]);
      expect(response.status, target).toBe(400);
    }
    expect(observed).toEqual({ bodyReads: 0, storeReads: 0 });
  });

  it.each([
    ['null origin', ['Origin: null']],
    ['wrong port', ['Origin: http://127.0.0.1:1']],
    ['localhost origin', ['Origin: http://localhost:PORT']],
    ['https scheme', ['Origin: https://127.0.0.1:PORT']],
    ['duplicate origin', ['Origin: http://127.0.0.1:PORT', 'Origin: http://127.0.0.1:PORT']],
    ['cross-site fetch metadata', ['Origin: http://127.0.0.1:PORT', 'Sec-Fetch-Site: same-site']],
    ['cookie mutation without origin', ['Cookie: khala_session=x']],
  ] as const)('rejects %s on a mutation before authentication', async (_name, headers) => {
    const observed = { bodyReads: 0, storeReads: 0 };
    const server = await startHarness(observed);
    const response = await raw(server.port, [
      'POST /api/v1/messages HTTP/1.1',
      `Host: 127.0.0.1:${server.port}`,
      ...headers.map(header => header.replace('PORT', String(server.port))),
      'Content-Length: 2',
      '',
      '{}',
    ]);
    expect(response.status).toBe(403);
    expect(observed).toEqual({ bodyReads: 0, storeReads: 0 });
  });

  it('requires the exact Origin on bootstrap even without other credentials', async () => {
    const observed = { bodyReads: 0, storeReads: 0 };
    const server = await startHarness(observed);
    const response = await raw(server.port, [
      'POST /bootstrap HTTP/1.1',
      `Host: 127.0.0.1:${server.port}`,
      'Content-Length: 2',
      '',
      '{}',
    ]);
    expect(response.status).toBe(403);
    expect(observed.bodyReads).toBe(0);
  });

  it('returns content-free 404 and 405 envelopes with the strict header set', async () => {
    const server = await startHarness({ bodyReads: 0, storeReads: 0 });
    const missing = await raw(server.port, ['GET /nope HTTP/1.1', `Host: 127.0.0.1:${server.port}`, '', '']);
    expect(missing.status).toBe(404);
    expect(missing.body).toBe('{"error":{"code":"not_found"}}');
    const wrongMethod = await raw(server.port, ['GET /api/v1/messages HTTP/1.1', `Host: 127.0.0.1:${server.port}`, '', '']);
    expect(wrongMethod.status).toBe(405);
    for (const response of [missing, wrongMethod]) {
      expect(response.headers['content-security-policy']).toBe(CONTENT_SECURITY_POLICY);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['cross-origin-resource-policy']).toBe('same-origin');
      expect(Object.keys(response.headers).some(name => name.startsWith('access-control-'))).toBe(false);
    }
  });
});

describe('loopback listener', () => {
  it('binds 127.0.0.1 and advances past an occupied port', async () => {
    const occupied = await occupy(0);
    const port = (occupied.address() as net.AddressInfo).port;
    const server = await startHarness({ bodyReads: 0, storeReads: 0 }, { startPort: port });
    expect(server.port).toBe(port + 1);
    expect(server.origin).toBe(`http://127.0.0.1:${port + 1}`);
  });

  it('defaults to port 4870 and falls back to 4871 when it is occupied', async () => {
    // If another process already owns 4870 the fallback still has to skip it.
    const blocker = await occupy(4870).catch(() => null);
    const server = await startHarness({ bodyReads: 0, storeReads: 0 }, { startPort: undefined });
    expect(server.port).toBeGreaterThan(4870);
    if (blocker) expect(server.port).toBe(4871);
  });

  it('refuses once the bounded port search is exhausted', async () => {
    const occupied = await occupy(0);
    const port = (occupied.address() as net.AddressInfo).port;
    await expect(startHarness({ bodyReads: 0, storeReads: 0 }, { startPort: port, limits: { maxPortAttempts: 1 } }))
      .rejects.toMatchObject({ code: 'ports_exhausted' });
    expect(new LoopbackServerError('ports_exhausted')).toBeInstanceOf(Error);
  });

  it('bounds concurrent requests and refuses the excess with 503', async () => {
    let releaseAll!: () => void;
    const gate = new Promise<void>(resolve => { releaseAll = resolve; });
    const server = await startHarness({ bodyReads: 0, storeReads: 0 }, {
      limits: { maxConcurrentRequests: 1 },
      async handle({ response }) {
        await gate;
        sendNoContent(response);
      },
    });
    const first = raw(server.port, ['GET /slow HTTP/1.1', `Host: 127.0.0.1:${server.port}`, 'Connection: close', '', '']);
    await new Promise(resolve => setTimeout(resolve, 50));
    const second = await raw(server.port, ['GET /slow HTTP/1.1', `Host: 127.0.0.1:${server.port}`, 'Connection: close', '', '']);
    expect(second.status).toBe(503);
    releaseAll();
    expect((await first).status).toBe(204);
  });

  it('closes a keep-alive socket after the per-socket request limit', async () => {
    const server = await startHarness({ bodyReads: 0, storeReads: 0 }, { limits: { maxRequestsPerSocket: 1 } });
    const response = await raw(server.port, ['GET /nope HTTP/1.1', `Host: 127.0.0.1:${server.port}`, 'Connection: keep-alive', '', '']);
    expect(response.status).toBe(404);
    expect(response.headers.connection).toBe('close');
  });

  it('drops connections beyond the connection limit without serving them', async () => {
    const server = await startHarness({ bodyReads: 0, storeReads: 0 }, { limits: { maxConnections: 1 } });
    const held = net.connect({ host: '127.0.0.1', port: server.port });
    await new Promise(resolve => held.once('connect', resolve));
    await new Promise(resolve => setTimeout(resolve, 50));
    const excess = await raw(server.port, ['GET /nope HTTP/1.1', `Host: 127.0.0.1:${server.port}`, '', '']);
    expect(excess.status).toBe(0);
    held.destroy();
  });

  it('refuses oversized bodies and times out incomplete headers', async () => {
    const events: LogEvent[] = [];
    const server = await startHarness({ bodyReads: 0, storeReads: 0 }, {
      limits: { maxBodyBytes: 8, headersTimeoutMs: 200, requestTimeoutMs: 300, timeoutCheckIntervalMs: 50 },
      log: event => events.push(event),
    });
    const tooLarge = await raw(server.port, [
      'POST /api/v1/messages HTTP/1.1',
      `Host: 127.0.0.1:${server.port}`,
      `Authorization: Bearer ${VALID_CREDENTIAL}`,
      'Content-Length: 9',
      '',
      '123456789',
    ]);
    expect(tooLarge.status).toBe(413);

    const started = Date.now();
    const incomplete = await rawUnterminated(server.port, `GET /slow HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\n`);
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(incomplete === '' || incomplete.startsWith('HTTP/1.1 408')).toBe(true);
    expect(events.some(event => event.type === 'client_error' && event.code === 'timeout')).toBe(true);
  });

  it('rejects oversized headers without invoking any route', async () => {
    const observed = { bodyReads: 0, storeReads: 0 };
    const server = await startHarness(observed, { limits: { maxHeaderBytes: 1024 } });
    const response = await raw(server.port, [
      'GET /slow HTTP/1.1',
      `Host: 127.0.0.1:${server.port}`,
      `X-Filler: ${'x'.repeat(2048)}`,
      '',
      '',
    ]);
    expect(response.status).toBe(431);
    expect(observed).toEqual({ bodyReads: 0, storeReads: 0 });
  });

  it('keeps raw exception text, targets and credentials out of responses and logs', async () => {
    const events: LogEvent[] = [];
    const server = await startHarness({ bodyReads: 0, storeReads: 0 }, {
      log: event => events.push(event),
      handle() {
        throw new Error(`secret-canary ${VALID_CREDENTIAL}`);
      },
    });
    const response = await raw(server.port, [
      'GET /slow HTTP/1.1',
      `Host: 127.0.0.1:${server.port}`,
      'X-Trace: header-canary',
      'Connection: close',
      '',
      '',
    ]);
    expect(response.status).toBe(500);
    expect(response.body).toBe('{"error":{"code":"internal_error"}}');
    await new Promise(resolve => setTimeout(resolve, 20));
    const logged = JSON.stringify(events);
    expect(logged).not.toMatch(/canary|aaaa/);
    expect(events).toContainEqual(expect.objectContaining({ type: 'request', route: '/slow', status: 500, code: 'internal_error' }));
  });
});

type Harness = Partial<Pick<LoopbackServerOptions<{ kind: 'test' }>, 'handle' | 'log' | 'limits'>> & { startPort?: number | undefined };

async function startHarness(observed: { bodyReads: number; storeReads: number }, overrides: Harness = {}): Promise<LoopbackServer> {
  const server = await startLoopbackServer<{ kind: 'test' }>({
    ...('startPort' in overrides ? (overrides.startPort === undefined ? {} : { startPort: overrides.startPort }) : { startPort: 0 }),
    ...(overrides.limits ? { limits: overrides.limits } : {}),
    ...(overrides.log ? { log: overrides.log } : {}),
    routes: [
      { method: 'POST', path: '/api/v1/messages', template: '/api/v1/messages', admission: 'authenticated' },
      { method: 'POST', path: '/bootstrap', admission: 'bootstrap' },
      { method: 'GET', path: '/slow', admission: 'public' },
    ],
    async authenticate({ request }) {
      observed.storeReads += 1;
      return request.headers.authorization === `Bearer ${VALID_CREDENTIAL}`
        ? { ok: true, principal: { kind: 'test' } }
        : { ok: false, status: 401, code: 'unauthenticated' };
    },
    handle: overrides.handle ?? (async ({ readBody, response }) => {
      observed.bodyReads += 1;
      await readBody();
      sendNoContent(response, 204);
    }),
  });
  servers.push(server);
  return server;
}

function occupy(port: number): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const blocker = net.createServer();
    blocker.once('error', reject);
    blocker.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      blockers.push(blocker);
      resolve(blocker);
    });
  });
}

type RawResponse = Readonly<{ status: number; headers: Record<string, string>; body: string }>;

/** Writes exact request bytes so duplicate and malformed headers reach the server unchanged. */
function raw(port: number, lines: readonly string[]): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(parse(Buffer.concat(chunks).toString('utf8')));
    };
    socket.on('data', chunk => {
      chunks.push(chunk);
      const text = Buffer.concat(chunks).toString('utf8');
      const parsed = parse(text);
      const length = Number(parsed.headers['content-length'] ?? Number.NaN);
      if (text.includes('\r\n\r\n') && Buffer.byteLength(parsed.body) >= (Number.isNaN(length) ? Infinity : length)) finish();
    });
    socket.once('end', finish);
    socket.once('close', finish);
    socket.once('error', error => settled ? undefined : reject(error));
    socket.write(lines.join('\r\n'));
  });
}

function rawUnterminated(port: number, text: string): Promise<string> {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const chunks: Buffer[] = [];
    socket.on('data', chunk => chunks.push(chunk));
    socket.once('close', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.once('error', () => undefined);
    socket.write(text);
  });
}

function parse(text: string): RawResponse {
  const split = text.indexOf('\r\n\r\n');
  const head = split === -1 ? text : text.slice(0, split);
  const [statusLine = '', ...headerLines] = head.split('\r\n');
  const headers: Record<string, string> = {};
  for (const line of headerLines) {
    const colon = line.indexOf(':');
    if (colon > 0) headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
  }
  return { status: Number(statusLine.split(' ')[1] ?? 0), headers, body: split === -1 ? '' : text.slice(split + 4) };
}

async function sendIncompleteMutation(
  port: number,
  headers: Readonly<{ host: string; origin: string }>,
): Promise<Readonly<{ status: number; body: string }>> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path: '/api/v1/messages',
      headers: {
        ...headers,
        authorization: `Bearer ${VALID_CREDENTIAL}`,
        'content-type': 'application/json',
        'content-length': '1000',
        'sec-fetch-site': 'same-origin',
      },
    });
    request.once('error', reject);
    // A server that waits on the never-completed body gives no answer; report that as status 0.
    const timer = setTimeout(() => {
      request.destroy();
      resolve({ status: 0, body: '' });
    }, 1_000);
    request.once('response', response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.once('end', () => {
        clearTimeout(timer);
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') });
      });
    });
    request.flushHeaders();
    // The body is deliberately never completed: admission must answer first.
    request.write('{"message":"body-canary"');
  });
}
