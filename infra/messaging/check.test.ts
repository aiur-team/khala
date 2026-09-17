import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { CheckError, probeBoundary, renderConfig, renderTemplate, validateInputs } from './check.ts';

const validEnvironment = (overrides: Record<string, string> = {}): Record<string, string> => ({
  KHALA_ENVIRONMENT: 'preview',
  KHALA_STATE_NAMESPACE: 'khala-preview',
  KHALA_MATRIX_SERVER_NAME: 'matrix.preview.test',
  KHALA_MATRIX_PUBLIC_ORIGIN: 'https://matrix.preview.test',
  KHALA_MATRIX_CHECK_ORIGIN: 'https://matrix.preview.test',
  KHALA_ALLOW_INSECURE_LOOPBACK: 'false',
  KHALA_DB_HOST: 'postgres',
  KHALA_DB_PORT: '5432',
  KHALA_DB_NAME: 'synapse',
  KHALA_DB_USER: 'synapse',
  KHALA_DB_PASSWORD: 'correct-horse-battery-staple',
  KHALA_CONFIG_DIR: '/private/khala-preview',
  ...overrides,
});

test('validates isolated preview inputs', () => {
  const inputs = validateInputs(validEnvironment(), 'preview');
  assert.equal(inputs.publicOrigin, 'https://matrix.preview.test/');
  assert.equal(inputs.dbPort, 5432);
});

test('rejects missing secrets, placeholders and mixed environment identity', () => {
  const cases: Array<[Record<string, string>, string]> = [
    [validEnvironment({ KHALA_DB_PASSWORD: '' }), 'missing-input'],
    [validEnvironment({ KHALA_DB_PASSWORD: 'replace-with-secret' }), 'weak-database-secret'],
    [validEnvironment({ KHALA_MATRIX_SERVER_NAME: 'matrix.example.invalid' }), 'invalid-server-name'],
    [validEnvironment({ KHALA_STATE_NAMESPACE: 'khala-production' }), 'invalid-state-namespace'],
    [validEnvironment({ KHALA_MATRIX_PUBLIC_ORIGIN: 'http://matrix.preview.test' }), 'insecure-origin'],
  ];
  for (const [environment, code] of cases) {
    assert.throws(() => validateInputs(environment, 'preview'), (error: unknown) => error instanceof CheckError && error.code === code);
  }
});

test('allows insecure HTTP only for an explicit disposable loopback preview', () => {
  const inputs = validateInputs(validEnvironment({
    KHALA_MATRIX_CHECK_ORIGIN: 'http://127.0.0.1:49152',
    KHALA_ALLOW_INSECURE_LOOPBACK: 'true',
  }), 'preview');
  assert.equal(inputs.checkOrigin, 'http://127.0.0.1:49152/');
});

test('requires HTTPS for the public origin even when loopback checks are enabled', () => {
  assert.throws(() => validateInputs(validEnvironment({
    KHALA_MATRIX_PUBLIC_ORIGIN: 'http://127.0.0.1:49152',
    KHALA_ALLOW_INSECURE_LOOPBACK: 'true',
  }), 'preview'), (error: unknown) => error instanceof CheckError && error.code === 'insecure-origin');
});

test('requires the production check origin to match the normalized public origin', () => {
  const production = validEnvironment({
    KHALA_ENVIRONMENT: 'production',
    KHALA_STATE_NAMESPACE: 'khala-production',
    KHALA_MATRIX_SERVER_NAME: 'matrix.production.test',
    KHALA_MATRIX_PUBLIC_ORIGIN: 'https://matrix.production.test',
    KHALA_MATRIX_CHECK_ORIGIN: 'https://unrelated.production.test',
  });
  assert.throws(() => validateInputs(production, 'production'), (error: unknown) => error instanceof CheckError && error.code === 'check-origin-mismatch');

  production.KHALA_MATRIX_CHECK_ORIGIN = 'https://matrix.production.test/';
  assert.equal(validateInputs(production, 'production').checkOrigin, 'https://matrix.production.test/');
});

test('renders every token once with YAML-safe scalar quoting', async (context) => {
  const configDir = await mkdtemp(join(tmpdir(), 'khala-messaging-test-'));
  context.after(() => rm(configDir, { recursive: true, force: true }));
  const inputs = validateInputs(validEnvironment({
    KHALA_CONFIG_DIR: configDir,
    KHALA_DB_PASSWORD: 'long: secret # with {yaml} chars',
  }), 'preview');
  const target = await renderConfig(inputs);
  const rendered = await readFile(target, 'utf8');
  assert.match(rendered, /password: "long: secret # with \{yaml\} chars"/);
  assert.match(rendered, /^federation_domain_whitelist: \[\]$/m);
  assert.doesNotMatch(rendered, /__KHALA_/);
  assert.equal((await stat(target)).mode & 0o777, 0o644);
  assert.equal((await stat(configDir)).mode & 0o777, 0o700);
});

test('rejects missing, duplicated and unknown template tokens', () => {
  const inputs = validateInputs(validEnvironment(), 'preview');
  assert.throws(() => renderTemplate('', inputs), (error: unknown) => error instanceof CheckError && error.code === 'invalid-template-token-count');
  const duplicate = '__KHALA_MATRIX_SERVER_NAME__\n__KHALA_MATRIX_SERVER_NAME__';
  assert.throws(() => renderTemplate(duplicate, inputs), (error: unknown) => error instanceof CheckError && error.code === 'invalid-template-token-count');
});

const response = (status: number, body: unknown = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json' },
});

test('accepts healthy client and closed registration/admin boundaries', async () => {
  const seen: string[] = [];
  const fetchImpl = async (url: URL) => {
    seen.push(url.pathname);
    if (url.pathname === '/health') return new Response('OK', { status: 200 });
    if (url.pathname === '/_matrix/client/versions') return response(200, { versions: ['v1.11'] });
    if (url.pathname.startsWith('/_matrix/client/v3/profile/')) return response(404, { errcode: 'M_NOT_FOUND' });
    if (url.pathname === '/_matrix/client/v3/register') return response(403, { errcode: 'M_FORBIDDEN' });
    if (url.pathname === '/_synapse/admin/v2/users') return response(401, { errcode: 'M_MISSING_TOKEN' });
    return response(404);
  };
  assert.deepEqual(await probeBoundary('https://matrix.preview.test/', fetchImpl), { ready: true, reason: 'boundary-checks-pass' });
  assert.equal(seen[0], '/health');
  assert.equal(seen[1], '/_matrix/client/versions');
  assert.match(seen[2]!, /^\/_matrix\/client\/v3\/profile\/%40__khala_boundary_/);
  assert.deepEqual(seen.slice(3), ['/_matrix/client/v3/register', '/_synapse/admin/v2/users']);
});

test('fails closed when registration, admin or database boundaries are wrong', async () => {
  const scenario = async (registrationStatus: number, adminStatus: number, profileStatus = 404) => probeBoundary('https://matrix.preview.test/', async (url: URL) => {
    if (url.pathname === '/health') return new Response('OK', { status: 200 });
    if (url.pathname === '/_matrix/client/versions') return response(200, { versions: ['v1.11'] });
    if (url.pathname.startsWith('/_matrix/client/v3/profile/')) return response(profileStatus);
    if (url.pathname === '/_matrix/client/v3/register') return response(registrationStatus);
    return response(adminStatus);
  });
  await assert.rejects(scenario(200, 401), (error: unknown) => error instanceof CheckError && error.code === 'registration-not-rejected');
  await assert.rejects(scenario(403, 200), (error: unknown) => error instanceof CheckError && error.code === 'admin-not-rejected');
  await assert.rejects(scenario(403, 401, 503), (error: unknown) => error instanceof CheckError && error.code === 'database-unavailable');
});
