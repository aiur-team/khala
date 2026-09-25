import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { request as httpRequest } from 'node:http';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type AssetManifest, AssetManifestError, loadAssets } from './assets';
import { startChannelServer } from './channel-server';
import { createChannelFixture } from './fixtures/channel-fixture';

const roots: string[] = [];
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function bundle(): Readonly<{ root: string; outside: string }> {
  const base = fs.realpathSync(fs.mkdtempSync('/tmp/khala-assets-'));
  roots.push(base);
  const root = path.join(base, 'bundle');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><script src="/assets/app.js"></script>');
  fs.writeFileSync(path.join(root, 'assets', 'app.js'), 'window.appLoaded = true;');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside-secret');
  return { root, outside };
}

const html = 'text/html; charset=utf-8' as const;
const js = 'text/javascript; charset=utf-8' as const;

function manifest(root: string, entries: AssetManifest['entries'] = [
  { route: '/', file: 'index.html', contentType: html },
  { route: '/assets/app.js', file: 'assets/app.js', contentType: js },
]): AssetManifest {
  return { root, entries, channelDocument: '/' };
}

function expectCode(run: () => unknown, code: AssetManifestError['code']): void {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(AssetManifestError);
    expect((error as AssetManifestError).code).toBe(code);
    expect((error as Error).message).not.toMatch(/\/tmp|khala-assets/);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe('asset manifest loading', () => {
  it('preloads exact bytes for declared routes only', () => {
    const { root } = bundle();
    const table = loadAssets(manifest(root));
    expect(table.get('/assets/app.js')?.body.toString()).toBe('window.appLoaded = true;');
    expect(table.get('/index.html')).toBeNull();
    expect(table.channelDocument?.contentType).toBe(html);
    // Later filesystem changes cannot alter what is served.
    fs.writeFileSync(path.join(root, 'assets', 'app.js'), 'tampered');
    expect(table.get('/assets/app.js')?.body.toString()).toBe('window.appLoaded = true;');
  });

  it('rejects relative, noncanonical and symlinked roots', () => {
    const { root } = bundle();
    expectCode(() => loadAssets(manifest('bundle')), 'invalid_root');
    expectCode(() => loadAssets(manifest(`${root}/../bundle`)), 'invalid_root');
    expectCode(() => loadAssets(manifest(`${root}/`)), 'invalid_root');
    const link = `${root}-link`;
    fs.symlinkSync(root, link);
    expectCode(() => loadAssets(manifest(link)), 'invalid_root');
    expectCode(() => loadAssets(manifest(path.join(root, 'missing'))), 'invalid_root');
  });

  it.each([
    '/etc/passwd', '../outside/secret.txt', 'assets/../index.html', './index.html', 'assets\\app.js',
    'assets//app.js', '%2e%2e/outside/secret.txt', 'assets/app.js\0', '',
  ])('rejects the file entry %j', file => {
    const { root } = bundle();
    expectCode(() => loadAssets(manifest(root, [{ route: '/x', file, contentType: js }])), 'invalid_file');
  });

  it('rejects symlinked files and directories even when they point inside the bundle', () => {
    const { root, outside } = bundle();
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'escape.txt'));
    expectCode(() => loadAssets(manifest(root, [{ route: '/escape.txt', file: 'escape.txt', contentType: js }])), 'unsafe_file');
    fs.symlinkSync(path.join(root, 'index.html'), path.join(root, 'inside.html'));
    expectCode(() => loadAssets(manifest(root, [{ route: '/inside', file: 'inside.html', contentType: html }])), 'unsafe_file');
    fs.symlinkSync(outside, path.join(root, 'linked'));
    expectCode(() => loadAssets(manifest(root, [{ route: '/s', file: 'linked/secret.txt', contentType: js }])), 'unsafe_file');
  });

  it('rejects hard-linked files, which could alias content outside the bundle', () => {
    const { root, outside } = bundle();
    fs.linkSync(path.join(outside, 'secret.txt'), path.join(root, 'alias.txt'));
    expectCode(() => loadAssets(manifest(root, [{ route: '/alias.txt', file: 'alias.txt', contentType: js }])), 'unsafe_file');
  });

  it('rejects non-regular, missing, oversized and excess files', () => {
    const { root } = bundle();
    execFileSync('mkfifo', [path.join(root, 'pipe')]);
    expectCode(() => loadAssets(manifest(root, [{ route: '/pipe', file: 'pipe', contentType: js }])), 'invalid_file');
    expectCode(() => loadAssets(manifest(root, [{ route: '/dir', file: 'assets', contentType: js }])), 'invalid_file');
    expectCode(() => loadAssets(manifest(root, [{ route: '/gone', file: 'gone.js', contentType: js }])), 'invalid_file');
    const limits = { maxAssetBytes: 10, maxTotalBytes: 100, maxEntries: 1 };
    expectCode(() => loadAssets(manifest(root, [{ route: '/a', file: 'assets/app.js', contentType: js }]), limits), 'too_large');
    expectCode(() => loadAssets(manifest(root), limits), 'too_many_entries');
    expectCode(() => loadAssets(manifest(root), { maxAssetBytes: 1_000, maxTotalBytes: 60, maxEntries: 10 }), 'too_large');
  });

  it('rejects reserved, duplicate, malformed routes and undeclared media types', () => {
    const { root } = bundle();
    for (const route of ['/api/v1/x', '/__khala/bootstrap', '/__khala/bootstrap.js', '/channels/x', '/api']) {
      expectCode(() => loadAssets(manifest(root, [{ route, file: 'index.html', contentType: html }])), 'reserved_route');
    }
    for (const route of ['relative', '/a/../b', '/%2e%2e', '/a\\b', '/a?b', '/:param', '//x']) {
      expectCode(() => loadAssets(manifest(root, [{ route, file: 'index.html', contentType: html }])), 'invalid_route');
    }
    expectCode(() => loadAssets(manifest(root, [
      { route: '/', file: 'index.html', contentType: html },
      { route: '/', file: 'assets/app.js', contentType: js },
    ])), 'duplicate_route');
    expectCode(() => loadAssets(manifest(root, [
      { route: '/', file: 'index.html', contentType: 'application/octet-stream' as typeof html },
    ])), 'invalid_content_type');
    expectCode(() => loadAssets({ root, entries: [{ route: '/app.js', file: 'assets/app.js', contentType: js }], channelDocument: '/app.js' }), 'missing_document');
  });
});

describe('asset serving', () => {
  async function serve(root: string) {
    const fixture = createChannelFixture({ root: fs.mkdtempSync('/tmp/khala-server-'), now: Date.now() });
    cleanups.push(() => fixture.dispose());
    const server = await startChannelServer({
      store: fixture.store, bootstrap: [], bindings: [], newId: () => 'x', clock: Date.now, startPort: 0, assets: manifest(root),
    });
    cleanups.push(() => server.close());
    return server;
  }

  function get(port: number, target: string): Promise<Readonly<{ status: number; type: string | undefined; body: string }>> {
    return new Promise((resolve, reject) => {
      const request = httpRequest({ host: '127.0.0.1', port, path: target, headers: { host: `127.0.0.1:${port}` } });
      request.once('error', reject);
      request.once('response', response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { body += chunk; });
        response.once('end', () => resolve({ status: response.statusCode ?? 0, type: response.headers['content-type'], body }));
      });
      request.end();
    });
  }

  it('serves declared assets and the channel document and nothing else', async () => {
    const { root, outside } = bundle();
    const server = await serve(root);
    expect(await get(server.port, '/assets/app.js')).toEqual({ status: 200, type: js, body: 'window.appLoaded = true;' });
    expect((await get(server.port, '/channels/channel-one')).body).toContain('/assets/app.js');
    expect((await get(server.port, '/')).status).toBe(200);
    for (const target of [
      '/index.html', '/assets/app.js?x=1', '/assets%2fapp.js', '/assets/%61pp.js', '/assets/../index.html',
      '/%2e%2e/outside/secret.txt', '/..%5coutside%5csecret.txt', '/%252e%252e/outside/secret.txt',
      `${outside}/secret.txt`, '/assets/app.js%00', '/assets/', '/channels/..', '/channels/a/b',
    ]) {
      const reply = await get(server.port, target);
      expect([400, 404], target).toContain(reply.status);
      expect(reply.body, target).not.toMatch(/outside-secret|appLoaded|\/tmp/);
    }
  });

  it('refuses to start when a manifest entry targets a symlink outside the bundle', async () => {
    const { root, outside } = bundle();
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'assets', 'leak.js'));
    const fixture = createChannelFixture({ root: fs.mkdtempSync('/tmp/khala-server-'), now: Date.now() });
    cleanups.push(() => fixture.dispose());
    await expect(startChannelServer({
      store: fixture.store, bootstrap: [], bindings: [], newId: () => 'x', clock: Date.now, startPort: 0,
      assets: manifest(root, [...manifest(root).entries, { route: '/assets/leak.js', file: 'assets/leak.js', contentType: js }]),
    })).rejects.toMatchObject({ code: 'unsafe_file' });
  });
});
