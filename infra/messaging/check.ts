#!/usr/bin/env node

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = resolve(fileURLToPath(new URL('.', import.meta.url)));
const templatePath = resolve(directory, 'homeserver.template.yaml');

type EnvironmentName = 'preview' | 'production';
type Environment = Record<string, string | undefined>;
type FetchLike = (input: URL, init?: RequestInit) => Promise<Response>;

interface DeploymentInputs {
  environment: EnvironmentName;
  stateNamespace: string;
  serverName: string;
  publicOrigin: string;
  registrationSharedSecret: string;
  dbHost: string;
  dbPort: number;
  dbName: string;
  dbUser: string;
  dbPassword: string;
  configDir: string;
  checkOrigin: string | undefined;
}

export class CheckError extends Error {
  readonly code: string;

  constructor(code: string, message = code) {
    super(message);
    this.name = 'CheckError';
    this.code = code;
  }
}

const requiredKeys = [
  'KHALA_ENVIRONMENT',
  'KHALA_STATE_NAMESPACE',
  'KHALA_MATRIX_SERVER_NAME',
  'KHALA_MATRIX_PUBLIC_ORIGIN',
  'KHALA_MATRIX_REGISTRATION_SHARED_SECRET',
  'KHALA_DB_HOST',
  'KHALA_DB_PORT',
  'KHALA_DB_NAME',
  'KHALA_DB_USER',
  'KHALA_DB_PASSWORD',
  'KHALA_CONFIG_DIR',
];

const placeholders = /replace|placeholder|changeme|example\.invalid/i;
const dnsName = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const dbIdentifier = /^[A-Za-z_][A-Za-z0-9_-]{0,62}$/;

function required(env: Environment, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new CheckError('missing-input', `Missing ${key}`);
  return value;
}

function parseOrigin(value: string, allowInsecureLoopback = false): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CheckError('invalid-origin');
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1';
  if (url.protocol !== 'https:' && !(allowInsecureLoopback && loopback && url.protocol === 'http:')) {
    throw new CheckError('insecure-origin');
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new CheckError('invalid-origin');
  }
  if (placeholders.test(url.hostname)) throw new CheckError('placeholder-origin');
  url.pathname = '/';
  return url.toString();
}

export function validateInputs(env: Environment, expectedEnvironment?: string): DeploymentInputs {
  for (const key of requiredKeys) required(env, key);
  const environment = required(env, 'KHALA_ENVIRONMENT');
  if (!['preview', 'production'].includes(environment)) throw new CheckError('invalid-environment');
  if (expectedEnvironment && environment !== expectedEnvironment) throw new CheckError('environment-mismatch');
  const validatedEnvironment = environment as EnvironmentName;

  const stateNamespace = required(env, 'KHALA_STATE_NAMESPACE');
  if (!/^[a-z][a-z0-9-]{2,47}$/.test(stateNamespace) || !stateNamespace.endsWith(`-${validatedEnvironment}`)) {
    throw new CheckError('invalid-state-namespace');
  }

  const serverName = required(env, 'KHALA_MATRIX_SERVER_NAME').toLowerCase();
  if (!dnsName.test(serverName) || placeholders.test(serverName)) throw new CheckError('invalid-server-name');

  const allowLoopback = env.KHALA_ALLOW_INSECURE_LOOPBACK === 'true';
  const publicOrigin = parseOrigin(required(env, 'KHALA_MATRIX_PUBLIC_ORIGIN'));
  const registrationSharedSecret = required(env, 'KHALA_MATRIX_REGISTRATION_SHARED_SECRET');
  if (registrationSharedSecret.length < 32 || placeholders.test(registrationSharedSecret)) {
    throw new CheckError('weak-registration-secret');
  }
  const dbHost = required(env, 'KHALA_DB_HOST');
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(dbHost) || placeholders.test(dbHost)) throw new CheckError('invalid-database-host');
  const dbPortText = required(env, 'KHALA_DB_PORT');
  const dbPort = Number(dbPortText);
  if (!Number.isInteger(dbPort) || dbPort < 1 || dbPort > 65535) throw new CheckError('invalid-database-port');
  const dbName = required(env, 'KHALA_DB_NAME');
  const dbUser = required(env, 'KHALA_DB_USER');
  if (!dbIdentifier.test(dbName) || !dbIdentifier.test(dbUser)) throw new CheckError('invalid-database-identity');
  const dbPassword = required(env, 'KHALA_DB_PASSWORD');
  if (dbPassword.length < 24 || placeholders.test(dbPassword)) throw new CheckError('weak-database-secret');
  const configDir = required(env, 'KHALA_CONFIG_DIR');
  if (!isAbsolute(configDir) || placeholders.test(configDir)) throw new CheckError('invalid-config-directory');

  const checkOriginValue = env.KHALA_MATRIX_CHECK_ORIGIN?.trim();
  const checkOrigin = checkOriginValue ? parseOrigin(checkOriginValue, validatedEnvironment === 'preview' && allowLoopback) : undefined;
  if (validatedEnvironment === 'production' && checkOrigin && checkOrigin !== publicOrigin) {
    throw new CheckError('check-origin-mismatch');
  }
  return { environment: validatedEnvironment, stateNamespace, serverName, publicOrigin, registrationSharedSecret, dbHost, dbPort, dbName, dbUser, dbPassword, configDir, checkOrigin };
}

const substitutions: Record<string, keyof DeploymentInputs> = {
  '__KHALA_MATRIX_SERVER_NAME__': 'serverName',
  '__KHALA_MATRIX_PUBLIC_ORIGIN__': 'publicOrigin',
  '__KHALA_MATRIX_REGISTRATION_SHARED_SECRET__': 'registrationSharedSecret',
  '__KHALA_DB_HOST__': 'dbHost',
  '__KHALA_DB_PORT__': 'dbPort',
  '__KHALA_DB_USER__': 'dbUser',
  '__KHALA_DB_PASSWORD__': 'dbPassword',
  '__KHALA_DB_NAME__': 'dbName',
};

export function renderTemplate(template: string, inputs: DeploymentInputs): string {
  let rendered = template;
  for (const [token, key] of Object.entries(substitutions)) {
    const count = rendered.split(token).length - 1;
    if (count !== 1) throw new CheckError('invalid-template-token-count');
    const value = key === 'dbPort' ? String(inputs[key]) : JSON.stringify(inputs[key]);
    rendered = rendered.replace(token, value);
  }
  if (/__KHALA_[A-Z_]+__/.test(rendered)) throw new CheckError('unresolved-template-token');
  return rendered;
}

export async function renderConfig(inputs: DeploymentInputs): Promise<string> {
  const template = await readFile(templatePath, 'utf8');
  const rendered = renderTemplate(template, inputs);
  await mkdir(inputs.configDir, { recursive: true, mode: 0o700 });
  await chmod(inputs.configDir, 0o700);
  const target = resolve(inputs.configDir, 'homeserver.yaml');
  const temporary = resolve(inputs.configDir, `.homeserver.yaml.${process.pid}.tmp`);
  // Docker bind-mounts this file directly for Synapse's non-root image user.
  // The 0700 parent protects the secret-bearing file from other host users.
  await writeFile(temporary, rendered, { encoding: 'utf8', mode: 0o644, flag: 'wx' });
  await rename(temporary, target);
  await chmod(target, 0o644);
  return target;
}

async function request(fetchImpl: FetchLike, origin: string, path: string, init: RequestInit = {}): Promise<Response> {
  try {
    return await fetchImpl(new URL(path, origin), { ...init, signal: AbortSignal.timeout(5_000), redirect: 'error' });
  } catch {
    throw new CheckError('service-unavailable');
  }
}

async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Probe results come from status codes; cleanup failure must not replace
    // the boundary diagnosis.
  }
}

export async function probeBoundary(origin: string, fetchImpl: FetchLike = fetch, serverName = 'matrix.invalid'): Promise<{ ready: true; reason: string }> {
  const health = await request(fetchImpl, origin, '/health');
  await discardBody(health);
  if (health.status !== 200) throw new CheckError('service-unavailable');

  const versions = await request(fetchImpl, origin, '/_matrix/client/versions');
  if (versions.status !== 200) {
    await discardBody(versions);
    throw new CheckError(versions.status >= 500 ? 'database-unavailable' : 'client-boundary-unavailable');
  }
  let versionsBody;
  try {
    versionsBody = await versions.json();
  } catch {
    throw new CheckError('invalid-client-response');
  }
  if (!Array.isArray(versionsBody.versions)) throw new CheckError('invalid-client-response');

  const syntheticUser = `@__khala_boundary_${randomUUID().replaceAll('-', '')}:${serverName}`;
  const profile = await request(fetchImpl, origin, `/_matrix/client/v3/profile/${encodeURIComponent(syntheticUser)}`);
  await discardBody(profile);
  if (profile.status >= 500) throw new CheckError('database-unavailable');
  if (profile.status !== 404) throw new CheckError('database-boundary-unexpected');

  const registration = await request(fetchImpl, origin, '/_matrix/client/v3/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'boundary_probe', password: 'synthetic-not-a-secret', auth: { type: 'm.login.dummy' } }),
  });
  await discardBody(registration);
  if (registration.status >= 500) throw new CheckError('database-unavailable');
  if (registration.status !== 403) throw new CheckError('registration-not-rejected');

  const admin = await request(fetchImpl, origin, '/_synapse/admin/v2/users');
  await discardBody(admin);
  if (![401, 403].includes(admin.status)) throw new CheckError('admin-not-rejected');
  return { ready: true, reason: 'boundary-checks-pass' };
}

function parseArguments(argv: string[]): { environment: string; renderOnly: boolean } {
  let environment: string | undefined;
  let renderOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--environment') environment = argv[++index];
    else if (argument === '--render-only') renderOnly = true;
    else throw new CheckError('invalid-argument');
  }
  if (!environment) throw new CheckError('missing-environment-argument');
  return { environment, renderOnly };
}

async function run(argv = process.argv.slice(2), env: Environment = process.env) {
  const args = parseArguments(argv);
  const inputs = validateInputs(env, args.environment);
  await renderConfig(inputs);
  let health = { ready: false, reason: 'not-probed' };
  if (!args.renderOnly) {
    if (!inputs.checkOrigin) throw new CheckError('missing-check-origin');
    health = await probeBoundary(inputs.checkOrigin, fetch, inputs.serverName);
  }
  return {
    environment: inputs.environment,
    server_name: inputs.serverName,
    public_origin: inputs.publicOrigin,
    database: 'private-service-reference',
    secrets: ['signing-key', 'database-password'],
    health,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  run()
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      const reason = error instanceof CheckError ? error.code : 'unexpected-error';
      console.error(JSON.stringify({ health: { ready: false, reason } }));
      process.exitCode = 1;
    });
}
