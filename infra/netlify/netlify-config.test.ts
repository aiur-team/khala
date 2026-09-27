import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parse } from 'smol-toml';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const configPath = resolve(repoRoot, 'netlify.toml');
const schemaPath = resolve(repoRoot, 'infra/netlify/env.schema.json');

const SERVER_SECRET_KEYS = ['OIDC_CLIENT_SECRET', 'CONTROL_STATE_NAMESPACE'];

type NetlifyConfig = {
  build?: { base?: string; publish?: string; command?: string; environment?: Record<string, unknown> };
  functions?: { directory?: string; node_bundler?: string };
  redirects?: { from?: string; to?: string; status?: number; force?: boolean }[];
  headers?: { for?: string; values?: Record<string, unknown> }[];
  context?: Record<string, { environment?: Record<string, unknown> }>;
};

async function readConfig(): Promise<NetlifyConfig> {
  const raw = await readFile(configPath, 'utf8');
  return parse(raw) as NetlifyConfig;
}

function headersFor(config: NetlifyConfig, pattern: string): Record<string, unknown> {
  const block = (config.headers ?? []).find(entry => entry.for === pattern);
  assert.ok(block, `expected a [[headers]] block for = "${pattern}"`);
  return block.values ?? {};
}

test('the /api/* redirect is declared before the SPA fallback, so API paths never reach index.html', async () => {
  const config = await readConfig();
  const redirects = config.redirects ?? [];
  const apiIndex = redirects.findIndex(entry => entry.from === '/api/*');
  const fallbackIndex = redirects.findIndex(entry => entry.from === '/*');
  assert.notEqual(apiIndex, -1);
  assert.notEqual(fallbackIndex, -1);
  assert.ok(apiIndex < fallbackIndex, 'the /api/* redirect must appear before the SPA fallback redirect');
});

test('the API redirect targets the generated control function with force enabled, not a static asset', async () => {
  const config = await readConfig();
  const apiRedirect = (config.redirects ?? []).find(entry => entry.from === '/api/*');
  assert.deepEqual(apiRedirect, { from: '/api/*', to: '/.netlify/functions/khala-control/:splat', status: 200, force: true });
});

test('the SPA fallback serves index.html so a deep-link reload does not 404', async () => {
  const config = await readConfig();
  const fallback = (config.redirects ?? []).find(entry => entry.from === '/*');
  assert.deepEqual(fallback, { from: '/*', to: '/index.html', status: 200 });
});

test('the site root alone is forced to the splash page, after /api/* and before the SPA fallback', async () => {
  const config = await readConfig();
  const redirects = config.redirects ?? [];
  const rootIndex = redirects.findIndex(entry => entry.from === '/');
  assert.notEqual(rootIndex, -1);
  assert.deepEqual(redirects[rootIndex], { from: '/', to: '/landing/index.html', status: 200, force: true });
  assert.ok(redirects.findIndex(entry => entry.from === '/api/*') < rootIndex, 'the /api/* redirect must stay first');
  assert.ok(rootIndex < redirects.findIndex(entry => entry.from === '/*'), 'the splash rule must precede the SPA fallback');
});

test('agent-readable root files map to landing build assets before the SPA fallback', async () => {
  const config = await readConfig();
  const redirects = config.redirects ?? [];
  const fallbackIndex = redirects.findIndex(entry => entry.from === '/*');
  const expected = [
    { from: '/llms.txt', to: '/landing/llms.txt', status: 200, force: true },
    { from: '/AGENTS.md', to: '/landing/AGENTS.md', status: 200, force: true },
  ];

  for (const redirect of expected) {
    const index = redirects.findIndex(entry => entry.from === redirect.from);
    assert.notEqual(index, -1, `${redirect.from} needs an explicit redirect`);
    assert.deepEqual(redirects[index], redirect);
    assert.ok(index < fallbackIndex, `${redirect.from} must not reach the SPA fallback`);
  }
});

test('the splash page build writes to the path the root redirect serves', async () => {
  const viteConfig = await readFile(resolve(repoRoot, 'apps/web/vite.landing.config.mjs'), 'utf8');
  assert.match(viteConfig, /base: '\/landing\/'/);
  assert.match(viteConfig, /publicDir: `\$\{here\}\/src\/landing\/public`/);
  assert.match(viteConfig, /outDir: `\$\{here\}\/dist\/landing`/);
  await Promise.all([
    readFile(resolve(repoRoot, 'apps/web/src/landing/public/llms.txt'), 'utf8'),
    readFile(resolve(repoRoot, 'apps/web/src/landing/public/AGENTS.md'), 'utf8'),
  ]);
  const webPackage = JSON.parse(await readFile(resolve(repoRoot, 'apps/web/package.json'), 'utf8')) as { scripts: Record<string, string> };
  assert.match(webPackage.scripts.build ?? '', /vite build --config vite\.landing\.config\.mjs$/, 'the splash build runs last, so no earlier step can empty it');
});

test('index.html and API responses are never cached', async () => {
  const config = await readConfig();
  assert.equal(headersFor(config, '/index.html')['Cache-Control'], 'no-store');
  const apiHeaders = headersFor(config, '/api/*');
  assert.equal(apiHeaders['Cache-Control'], 'no-store');
  assert.equal(apiHeaders['X-Content-Type-Options'], 'nosniff');
});

test('the build environment block never inlines a server secret literal', async () => {
  const config = await readConfig();
  const buildEnv = config.build?.environment ?? {};
  for (const secretKey of SERVER_SECRET_KEYS) {
    assert.ok(!(secretKey in buildEnv), `${secretKey} must not have a literal value in [build.environment]`);
  }
});

test('no [context.*.environment] block ever inlines a server secret literal', async () => {
  const config = await readConfig();
  for (const [contextName, contextConfig] of Object.entries(config.context ?? {})) {
    const contextEnv = contextConfig.environment ?? {};
    for (const secretKey of SERVER_SECRET_KEYS) {
      assert.ok(!(secretKey in contextEnv), `${secretKey} must not have a literal value in [context.${contextName}.environment]`);
    }
  }
});

test('the functions directory points at the generated (gitignored) input directory, built with the pinned esbuild bundler', async () => {
  const config = await readConfig();
  assert.deepEqual(config.functions, { directory: 'infra/netlify/functions-generated', node_bundler: 'esbuild' });
});

test('the build command installs with a frozen lockfile', async () => {
  const config = await readConfig();
  assert.match(config.build?.command ?? '', /pnpm install --frozen-lockfile/);
});

test('the publish directory is the web app\'s build output', async () => {
  const config = await readConfig();
  assert.equal(config.build?.publish, 'apps/web/dist');
});

test('static content-hashed assets are cached immutably', async () => {
  const config = await readConfig();
  assert.equal(headersFor(config, '/assets/*')['Cache-Control'], 'public, max-age=31536000, immutable');
});

test('every response carries a baseline security header set, including frame-ancestors and nosniff-adjacent frame protections', async () => {
  const config = await readConfig();
  const catchAll = headersFor(config, '/*');
  assert.equal(catchAll['X-Frame-Options'], 'DENY');
  assert.equal(catchAll['Referrer-Policy'], 'same-origin');
});

test('the CSP comes from the web build\'s _headers, never a static netlify.toml policy that cannot name the homeserver', async () => {
  const config = await readConfig();
  for (const block of config.headers ?? []) {
    assert.ok(!('Content-Security-Policy' in (block.values ?? {})), `[[headers]] for = "${block.for}" must not declare a static CSP`);
  }
  const viteConfig = await readFile(resolve(repoRoot, 'apps/web/vite.config.ts'), 'utf8');
  assert.match(viteConfig, /fileName: '_headers', source: renderNetlifyHeaders\(homeserverOrigin\)/);
  assert.match(viteConfig, /plugins: \[netlifyHeaders\(env\.PUBLIC_HOMESERVER_ORIGIN\)\]/);
});

test('env.schema.json keeps public and server variables in disjoint, non-overlapping groups', async () => {
  const schema = JSON.parse(await readFile(schemaPath, 'utf8')) as {
    properties: { public: { properties: Record<string, unknown> }; server: { properties: Record<string, unknown> } };
  };
  const publicKeys = new Set(Object.keys(schema.properties.public.properties));
  const serverKeys = new Set(Object.keys(schema.properties.server.properties));
  for (const key of publicKeys) assert.ok(!serverKeys.has(key), `${key} must not appear in both public and server`);
});

test('every server-only key in netlify.toml\'s context environment blocks also appears in env.schema.json\'s server group', async () => {
  const config = await readConfig();
  const schema = JSON.parse(await readFile(schemaPath, 'utf8')) as {
    properties: { server: { properties: Record<string, unknown> } };
  };
  const serverKeys = new Set(Object.keys(schema.properties.server.properties));
  for (const [contextName, contextConfig] of Object.entries(config.context ?? {})) {
    for (const key of Object.keys(contextConfig.environment ?? {})) {
      if (key.startsWith('PUBLIC_')) continue;
      assert.ok(serverKeys.has(key), `[context.${contextName}.environment] declares ${key}, which env.schema.json's server group does not know about`);
    }
  }
});
