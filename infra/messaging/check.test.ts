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

test('rejects origins with userinfo, path, query, hash or placeholder hostnames', () => {
  const cases: Array<[string, string]> = [
    ['https://user:pass@matrix.preview.test/', 'invalid-origin'],
    ['https://matrix.preview.test/path', 'invalid-origin'],
    ['https://matrix.preview.test/?query=1', 'invalid-origin'],
    ['https://matrix.preview.test/#hash', 'invalid-origin'],
    ['https://matrix.example.invalid/', 'placeholder-origin'],
  ];
  for (const [origin, code] of cases) {
    assert.throws(
      () => validateInputs(validEnvironment({ KHALA_MATRIX_PUBLIC_ORIGIN: origin }), 'preview'),
      (error: unknown) => error instanceof CheckError && error.code === code,
    );
  }
});

test('rejects insecure http for a non-loopback host even when loopback checks are allowed', () => {
  assert.throws(() => validateInputs(validEnvironment({
    KHALA_MATRIX_CHECK_ORIGIN: 'http://matrix.preview.test',
    KHALA_ALLOW_INSECURE_LOOPBACK: 'true',
  }), 'preview'), (error: unknown) => error instanceof CheckError && error.code === 'insecure-origin');
});

test('rejects insecure loopback checks in production even when the loopback flag is set', () => {
  const production = validEnvironment({
    KHALA_ENVIRONMENT: 'production',
    KHALA_STATE_NAMESPACE: 'khala-production',
    KHALA_MATRIX_SERVER_NAME: 'matrix.production.test',
    KHALA_MATRIX_PUBLIC_ORIGIN: 'https://matrix.production.test',
    KHALA_MATRIX_CHECK_ORIGIN: 'http://127.0.0.1:49152',
    KHALA_ALLOW_INSECURE_LOOPBACK: 'true',
  });
  assert.throws(() => validateInputs(production, 'production'), (error: unknown) => error instanceof CheckError && error.code === 'insecure-origin');
});

test('rejects malformed database, config directory and environment inputs', () => {
  const cases: Array<[Record<string, string>, string]> = [
    [validEnvironment({ KHALA_DB_HOST: 'bad host!' }), 'invalid-database-host'],
    [validEnvironment({ KHALA_DB_PORT: '0' }), 'invalid-database-port'],
    [validEnvironment({ KHALA_DB_PORT: '70000' }), 'invalid-database-port'],
    [validEnvironment({ KHALA_DB_PORT: 'not-a-number' }), 'invalid-database-port'],
    [validEnvironment({ KHALA_DB_NAME: 'bad name!' }), 'invalid-database-identity'],
    [validEnvironment({ KHALA_DB_USER: 'bad user!' }), 'invalid-database-identity'],
    [validEnvironment({ KHALA_CONFIG_DIR: 'relative/path' }), 'invalid-config-directory'],
    [validEnvironment({ KHALA_ENVIRONMENT: 'staging' }), 'invalid-environment'],
    [validEnvironment({ KHALA_DB_PASSWORD: 'short-password-value1' }), 'weak-database-secret'],
    [validEnvironment({ KHALA_DB_PASSWORD: 'this-value-is-not-short-but-has-a-placeholder' }), 'weak-database-secret'],
  ];
  for (const [environment, code] of cases) {
    assert.throws(() => validateInputs(environment, 'preview'), (error: unknown) => error instanceof CheckError && error.code === code);
  }
});

test('rejects an environment argument mismatch', () => {
  assert.throws(() => validateInputs(validEnvironment(), 'production'), (error: unknown) => error instanceof CheckError && error.code === 'environment-mismatch');
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

test('rejects a template with an unresolved unknown token', () => {
  const inputs = validateInputs(validEnvironment(), 'preview');
  const templateWithUnknownToken = [
    '__KHALA_MATRIX_SERVER_NAME__',
    '__KHALA_MATRIX_PUBLIC_ORIGIN__',
    '__KHALA_DB_HOST__',
    '__KHALA_DB_PORT__',
    '__KHALA_DB_USER__',
    '__KHALA_DB_PASSWORD__',
    '__KHALA_DB_NAME__',
    '__KHALA_UNKNOWN_TOKEN__',
  ].join('\n');
  assert.throws(
    () => renderTemplate(templateWithUnknownToken, inputs),
    (error: unknown) => error instanceof CheckError && error.code === 'unresolved-template-token',
  );
});

test('renders the shipped template with registration, federation and URL previews disabled', async (context) => {
  const configDir = await mkdtemp(join(tmpdir(), 'khala-messaging-test-'));
  context.after(() => rm(configDir, { recursive: true, force: true }));
  const inputs = validateInputs(validEnvironment({ KHALA_CONFIG_DIR: configDir }), 'preview');
  const target = await renderConfig(inputs);
  const rendered = await readFile(target, 'utf8');
  assert.match(rendered, /^enable_registration: false$/m);
  assert.match(rendered, /^enable_registration_without_verification: false$/m);
  assert.match(rendered, /^url_preview_enabled: false$/m);
  assert.match(rendered, /^federation_domain_whitelist: \[\]$/m);
  assert.match(rendered, /names: \[client\]/);
  assert.doesNotMatch(rendered, /names:\s*\[federation\]/);
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
  await assert.rejects(scenario(400, 401), (error: unknown) => error instanceof CheckError && error.code === 'registration-not-rejected');
  await assert.rejects(scenario(500, 401), (error: unknown) => error instanceof CheckError && error.code === 'database-unavailable');
  await assert.rejects(scenario(403, 200), (error: unknown) => error instanceof CheckError && error.code === 'admin-not-rejected');
  await assert.rejects(scenario(403, 500), (error: unknown) => error instanceof CheckError && error.code === 'admin-not-rejected');
  await assert.rejects(scenario(403, 401, 503), (error: unknown) => error instanceof CheckError && error.code === 'database-unavailable');
});

test('rejects a non-200 health response and pins every request to non-redirecting fetch', async () => {
  const redirectModes: Array<RequestInit['redirect']> = [];
  const fetchImpl = async (_url: URL, init?: RequestInit) => {
    redirectModes.push(init?.redirect);
    return new Response('unhealthy', { status: 503 });
  };
  await assert.rejects(probeBoundary('https://matrix.preview.test/', fetchImpl), (error: unknown) => error instanceof CheckError && error.code === 'service-unavailable');
  assert.deepEqual(redirectModes, ['error']);
});

test('treats a broken client versions response as a boundary failure', async () => {
  const scenario = (versionsResponse: Response) => probeBoundary('https://matrix.preview.test/', async (url: URL) => {
    if (url.pathname === '/health') return new Response('OK', { status: 200 });
    if (url.pathname === '/_matrix/client/versions') return versionsResponse;
    throw new Error(`unexpected request: ${url.pathname}`);
  });
  await assert.rejects(scenario(response(500)), (error: unknown) => error instanceof CheckError && error.code === 'database-unavailable');
  await assert.rejects(scenario(new Response('not-json', { status: 200 })), (error: unknown) => error instanceof CheckError && error.code === 'invalid-client-response');
  await assert.rejects(scenario(response(200, { versions: 'not-an-array' })), (error: unknown) => error instanceof CheckError && error.code === 'invalid-client-response');
});

test('rejects a profile probe that resolves instead of returning not-found', async () => {
  await assert.rejects(probeBoundary('https://matrix.preview.test/', async (url: URL) => {
    if (url.pathname === '/health') return new Response('OK', { status: 200 });
    if (url.pathname === '/_matrix/client/versions') return response(200, { versions: ['v1.11'] });
    if (url.pathname.startsWith('/_matrix/client/v3/profile/')) return response(200, { user_id: 'boundary' });
    throw new Error(`unexpected request: ${url.pathname}`);
  }), (error: unknown) => error instanceof CheckError && error.code === 'database-boundary-unexpected');
});
