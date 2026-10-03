import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { build, preview, type PreviewServer } from 'vite';
import { chromium, type Browser } from '@playwright/test';

const CONFIG = resolve(import.meta.dirname, '../../../vite.local.config.mjs');
const forbiddenStrings = ['matrix-js-sdk', 'initRustCrypto', '.wasm', '/api/human/', 'khala.aiur.team', 'fonts.googleapis.com'];

test('real local entry builds an offline bundle and mounts the helper-down screen', { timeout: 180_000 }, async () => {
  const scratch = await mkdtemp(join(process.env.TMPDIR ?? '/tmp', 'khala-local-bundle-'));
  // Chromium's Unix socket path must fit under 108 bytes; workspace TMPDIR can be longer.
  const browserProfile = await mkdtemp('/tmp/khala-1010-browser-');
  let server: PreviewServer | null = null;
  let browser: Browser | null = null;
  try {
    const outDir = join(scratch, 'dist');
    const result = await build({ configFile: CONFIG, build: { outDir, emptyOutDir: true }, logLevel: 'error' });
    // The config is outside the typechecked src tree, like vite.landing.config.mjs.
    const { FORBIDDEN_LOCAL_MODULE } = await import(/* @vite-ignore */ CONFIG);
    const outputs = (Array.isArray(result) ? result : [result]).flatMap(out => 'output' in out ? out.output : []);
    const moduleIds = outputs.flatMap(out => out.type === 'chunk' ? out.moduleIds : []);
    assert.ok(moduleIds.some(id => id.endsWith('/src/local-main.tsx')));
    assert.ok(moduleIds.some(id => id.endsWith('/src/composition/local/ports.ts')));
    assert.deepEqual(moduleIds.filter(id => FORBIDDEN_LOCAL_MODULE.test(id)), []);
    const files = await readdir(outDir);
    assert.ok(files.includes('index.html')); assert.ok(!files.includes('local.html')); assert.ok(!files.includes('_redirects'));
    const html = await readFile(join(outDir, 'index.html'), 'utf8');
    assert.match(html, /src="\/assets\//); assert.doesNotMatch(html, /fonts\.googleapis\.com/);
    const assets = await readdir(join(outDir, 'assets'));
    assert.equal(assets.filter(name => name.endsWith('.woff2')).length, 3);
    assert.ok(assets.some(name => name.endsWith('.css')));
    assert.ok(!assets.some(name => name.endsWith('.wasm')));
    const hits: string[] = [];
    for (const name of assets.filter(name => name.endsWith('.js'))) {
      const content = await readFile(join(outDir, 'assets', name), 'utf8');
      for (const forbidden of forbiddenStrings) if (content.includes(forbidden)) hits.push(`${name}: ${forbidden}`);
    }
    assert.ok(assets.some(name => name.endsWith('.js')));
    assert.deepEqual(hits, [], `forbidden bundle strings: ${hits.join(', ')}`);

    server = await preview({ configFile: CONFIG, build: { outDir }, preview: { host: '127.0.0.1', port: 0 } });
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true,
      args: ['--no-sandbox'], env: { ...process.env, TMPDIR: browserProfile } });
    const page = await browser.newPage();
    const origin = new URL(server.resolvedUrls!.local[0]!).origin;
    const outside: string[] = [];
    const errors: string[] = [];
    page.on('request', request => { if (new URL(request.url()).origin !== origin) outside.push(request.url()); });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/`);
    await page.getByRole('alert').filter({ hasText: 'Not connected' }).waitFor();
    assert.equal(new URL(page.url()).pathname, '/conversations');
    assert.equal(await page.getByRole('button', { name: /sign in/i }).count(), 0);
    assert.equal(await page.getByRole('menuitem', { name: 'Log out' }).count(), 0);
    await page.evaluate(() => document.fonts.ready);
    assert.deepEqual(outside, []); assert.deepEqual(errors, []);
  } finally {
    await browser?.close();
    if (server) await new Promise<void>(resolve => server!.httpServer.close(() => resolve()));
    await rm(scratch, { recursive: true, force: true });
    await rm(browserProfile, { recursive: true, force: true });
  }
});

test('local build guard rejects a hosted module', { timeout: 180_000 }, async () => {
  const scratch = await mkdtemp(join(process.env.TMPDIR ?? '/tmp', 'khala-local-guard-'));
  try {
    const hosted = resolve(import.meta.dirname, '../human/hosted-config.ts');
    await writeFile(join(scratch, 'local.html'), '<div id="app"></div><script type="module" src="./entry.ts"></script>');
    await writeFile(join(scratch, 'entry.ts'), `import { contentSecurityPolicy } from ${JSON.stringify(hosted)}; console.log(contentSecurityPolicy(null));`);
    await assert.rejects(build({ configFile: CONFIG, root: scratch, build: { outDir: join(scratch, 'out'),
      rollupOptions: { input: join(scratch, 'local.html') } }, logLevel: 'silent' }), /forbidden module in the local bundle/);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});

for (const forbidden of forbiddenStrings) {
  test(`local build guard rejects emitted string ${forbidden}`, { timeout: 180_000 }, async () => {
    const scratch = await mkdtemp(join(process.env.TMPDIR ?? '/tmp', 'khala-local-string-'));
    try {
      await writeFile(join(scratch, 'local.html'), '<script type="module" src="./entry.ts"></script>');
      await writeFile(join(scratch, 'entry.ts'), `console.log(${JSON.stringify(forbidden)});`);
      await assert.rejects(build({ configFile: CONFIG, root: scratch, build: { outDir: join(scratch, 'out'),
        rollupOptions: { input: join(scratch, 'local.html') } }, logLevel: 'silent' }), /forbidden string in the local bundle/);
    } finally { await rm(scratch, { recursive: true, force: true }); }
  });
}

test('local build guard rejects emitted WebAssembly assets', { timeout: 180_000 }, async () => {
  const scratch = await mkdtemp(join(process.env.TMPDIR ?? '/tmp', 'khala-local-wasm-'));
  try {
    await writeFile(join(scratch, 'local.html'), '<script type="module" src="./entry.ts"></script>');
    await writeFile(join(scratch, 'entry.ts'), 'import url from "./fixture.wasm?url"; console.log(url);');
    await writeFile(join(scratch, 'fixture.wasm'), new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    await assert.rejects(build({ configFile: CONFIG, root: scratch, build: { outDir: join(scratch, 'out'), assetsInlineLimit: 0,
      rollupOptions: { input: join(scratch, 'local.html') } }, logLevel: 'silent' }), /WebAssembly in the local bundle/);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
