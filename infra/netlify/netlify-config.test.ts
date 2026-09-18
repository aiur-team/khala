import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..');
const configPath = resolve(repoRoot, 'netlify.toml');
const schemaPath = resolve(repoRoot, 'infra/netlify/env.schema.json');

async function readConfig(): Promise<string> {
  return readFile(configPath, 'utf8');
}

test('the /api/* redirect is declared before the SPA fallback, so API paths never reach index.html', async () => {
  const config = await readConfig();
  const apiRedirect = config.indexOf('from = "/api/*"');
  const fallbackRedirect = config.indexOf('from = "/*"');
  assert.notEqual(apiRedirect, -1);
  assert.notEqual(fallbackRedirect, -1);
  assert.ok(apiRedirect < fallbackRedirect, 'the /api/* redirect must appear before the SPA fallback redirect');
});

test('the API redirect targets the generated control function, not a static asset', async () => {
  const config = await readConfig();
  assert.match(config, /from = "\/api\/\*"\s*\n\s*to = "\/\.netlify\/functions\/khala-control\/:splat"/);
});

test('the SPA fallback serves index.html so a deep-link reload does not 404', async () => {
  const config = await readConfig();
  assert.match(config, /from = "\/\*"\s*\n\s*to = "\/index\.html"/);
});

test('index.html and API responses are never cached', async () => {
  const config = await readConfig();
  const indexBlock = config.slice(config.indexOf('for = "/index.html"'), config.indexOf('for = "/index.html"') + 200);
  assert.match(indexBlock, /Cache-Control = "no-store"/);
  const apiBlock = config.slice(config.indexOf('for = "/api/*"'), config.indexOf('for = "/api/*"') + 200);
  assert.match(apiBlock, /Cache-Control = "no-store"/);
});

test('the build environment block never inlines a server secret literal', async () => {
  const config = await readConfig();
  const buildEnvBlock = config.slice(config.indexOf('[build.environment]'), config.indexOf('[functions]'));
  for (const secretKey of ['OIDC_CLIENT_SECRET', 'CONTROL_STATE_NAMESPACE']) {
    assert.ok(!new RegExp(`^\\s*${secretKey}\\s*=`, 'm').test(buildEnvBlock), `${secretKey} must not have a literal value in netlify.toml`);
  }
});

test('the functions directory points at the generated (gitignored) input directory', async () => {
  const config = await readConfig();
  assert.match(config, /directory = "infra\/netlify\/functions-generated"/);
});

test('env.schema.json keeps public and server variables in disjoint, non-overlapping groups', async () => {
  const schema = JSON.parse(await readFile(schemaPath, 'utf8')) as {
    properties: { public: { properties: Record<string, unknown> }; server: { properties: Record<string, unknown> } };
  };
  const publicKeys = new Set(Object.keys(schema.properties.public.properties));
  const serverKeys = new Set(Object.keys(schema.properties.server.properties));
  for (const key of publicKeys) assert.ok(!serverKeys.has(key), `${key} must not appear in both public and server`);
});
