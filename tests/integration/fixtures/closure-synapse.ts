import { execFileSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SERVER_NAME = 'khala-closure.invalid';
export type ServiceLimit = Readonly<{ memoryBytes: number; cpus: number; pids: number }>;
export type ClosureSynapseLimits = Readonly<{ synapse: ServiceLimit; postgres: ServiceLimit }>;

function checkedLimit(value: ServiceLimit): ServiceLimit {
  if (!Number.isSafeInteger(value.memoryBytes) || value.memoryBytes <= 0
    || !Number.isFinite(value.cpus) || value.cpus <= 0
    || !Number.isSafeInteger(value.pids) || value.pids <= 0) throw new Error('closure_container_limits_invalid');
  return value;
}

/** Compose's per-container hard limits; memory swap equals memory (no swap). */
export function closureSynapseLimitOverride(limits: ClosureSynapseLimits) {
  const service = (input: ServiceLimit) => {
    const limit = checkedLimit(input);
    return { mem_limit: String(limit.memoryBytes), memswap_limit: String(limit.memoryBytes),
      cpus: limit.cpus, pids_limit: limit.pids };
  };
  return { services: { synapse: service(limits.synapse), postgres: service(limits.postgres) } };
}

function docker(args: string[], env: NodeJS.ProcessEnv): string {
  try { return execFileSync('docker', args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 }).trim(); }
  catch { throw new Error(`docker_${args[0]}_failed`); }
}

/** A unique, disposable Synapse/Postgres project, including its own registration secret. */
export async function startClosureSynapse(options: Readonly<{ limits?: ClosureSynapseLimits; recoveryFile?: string }> = {}) {
  const override = options.limits ? closureSynapseLimitOverride(options.limits) : null;
  const project = `khala-closure-${randomBytes(8).toString('hex')}`;
  const configDir = mkdtempSync(path.join(os.homedir(), '.cache', 'khala-345-synapse-'));
  const databasePassword = randomBytes(32).toString('hex');
  const registrationSecret = randomBytes(32).toString('hex');
  const env = { ...process.env, EXPERIMENT_CONFIG_DIR: configDir, EXPERIMENT_DB_PASSWORD: databasePassword };
  const composeFile = path.resolve('experiments/backend/compose.yaml');
  const overrideFile = path.join(configDir, 'limits.yaml');
  const compose = (...args: string[]) => docker(['compose', '-p', project, '-f', composeFile,
    ...(override ? ['-f', overrideFile] : []), ...args], env);
  let recoveryWritten = false;
  const verifyLimits = (containers: Readonly<{ synapse: string; postgres: string }>) => {
    if (!options.limits) return;
    for (const service of ['synapse', 'postgres'] as const) {
      const host = JSON.parse(docker(['inspect', '--format', '{{json .HostConfig}}', containers[service]], env)) as {
        Memory?: number; MemorySwap?: number; NanoCpus?: number; CpuQuota?: number; CpuPeriod?: number; PidsLimit?: number;
      };
      const expected = options.limits[service];
      const cpus = host.NanoCpus ? host.NanoCpus / 1e9
        : host.CpuQuota && host.CpuPeriod ? host.CpuQuota / host.CpuPeriod : 0;
      if (host.Memory !== expected.memoryBytes || host.MemorySwap !== expected.memoryBytes
        || cpus <= 0 || cpus > expected.cpus || host.PidsLimit !== expected.pids) {
        throw new Error('closure_container_limits_not_effective');
      }
    }
  };
  const close = () => {
    compose('down', '--volumes', '--remove-orphans');
    const label = `label=com.docker.compose.project=${project}`;
    if (docker(['ps', '-aq', '--filter', label], env)
      || docker(['volume', 'ls', '-q', '--filter', label], env)
      || docker(['network', 'ls', '-q', '--filter', label], env)) throw new Error('closure_docker_resources_remain');
    rmSync(configDir, { recursive: true, force: true });
    if (recoveryWritten && options.recoveryFile) rmSync(options.recoveryFile, { force: true });
  };
  try {
    if (override) writeFileSync(overrideFile, JSON.stringify(override), { mode: 0o600 });
    if (options.recoveryFile) {
      writeFileSync(options.recoveryFile, JSON.stringify({
        v: 1, project, configDir, composeFile, overrideFile: override ? overrideFile : null,
      }), { flag: 'wx', mode: 0o600 });
      recoveryWritten = true;
    }
    writeFileSync(path.join(configDir, 'homeserver.yaml'), JSON.stringify({
      server_name: SERVER_NAME, report_stats: false, signing_key_path: '/data/server.signing.key',
      media_store_path: '/data/media', pid_file: '/data/homeserver.pid',
      registration_shared_secret: registrationSecret, enable_registration: false,
      suppress_key_server_warning: true, trusted_key_servers: [],
      listeners: [{ port: 8008, type: 'http', tls: false, bind_addresses: ['0.0.0.0'],
        resources: [{ names: ['client'], compress: false }] }],
      database: { name: 'psycopg2', args: { user: 'synapse', password: databasePassword,
        database: 'synapse', host: 'postgres', cp_min: 1, cp_max: 5 } },
      rc_message: { per_second: 100, burst_count: 100 },
      rc_login: { address: { per_second: 100, burst_count: 100 }, account: { per_second: 100, burst_count: 100 } },
    }), { mode: 0o600 });
    compose('up', '-d', '--wait', '--wait-timeout', '120');
    const containers = { synapse: compose('ps', '-q', 'synapse'), postgres: compose('ps', '-q', 'postgres') };
    if (!containers.synapse || !containers.postgres) throw new Error('closure_owned_containers_missing');
    for (const service of ['synapse', 'postgres'] as const) {
      const labels = JSON.parse(docker(['inspect', '--format', '{{json .Config.Labels}}', containers[service]], env)) as Record<string, string>;
      if (labels['com.docker.compose.project'] !== project || labels['com.docker.compose.service'] !== service) {
        throw new Error('closure_owned_container_mismatch');
      }
    }
    verifyLimits(containers);
    const baseUrl = `http://${compose('port', 'synapse', '8008')}`;
    const versionResponse = await fetch(`${baseUrl}/_synapse/admin/v1/server_version`);
    const versionBody = await versionResponse.json() as { server_version?: string };
    async function probeSharedSecretRegistration(username: string) {
      const challenge = await fetch(`${baseUrl}/_synapse/admin/v1/register`);
      const { nonce } = await challenge.json() as { nonce?: string };
      if (!challenge.ok || !nonce) throw new Error('registration_probe_nonce_unavailable');
      const password = randomBytes(24).toString('hex');
      const mac = createHmac('sha1', registrationSecret).update([nonce, username, password, 'notadmin'].join('\0')).digest('hex');
      const response = await fetch(`${baseUrl}/_synapse/admin/v1/register`, { method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nonce, username, password, admin: false, mac }) });
      const result = await response.json() as { errcode?: string; user_id?: string };
      if (!response.ok) return { status: response.status, errcode: result.errcode ?? null,
        exactUserId: false, lowercaseUserId: false, loginStatus: null, loginUserIdExact: false,
        loginUserIdLowercase: false };
      const expectedUserId = `@${username}:${SERVER_NAME}`;
      const login = await fetch(`${baseUrl}/_matrix/client/v3/login`, { method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'm.login.password', identifier: { type: 'm.id.user', user: expectedUserId },
          password, device_id: 'PROBE_DEVICE' }) });
      const loginResult = await login.json() as { user_id?: string };
      return { status: response.status, errcode: null,
        exactUserId: result.user_id === expectedUserId, lowercaseUserId: result.user_id === expectedUserId.toLowerCase(),
        loginStatus: login.status, loginUserIdExact: loginResult.user_id === expectedUserId,
        loginUserIdLowercase: loginResult.user_id === expectedUserId.toLowerCase() };
    }
    async function provision(userId: string, deviceId: string, suppliedPassword?: string) {
      const username = userId.slice(1, userId.indexOf(':'));
      const password = suppliedPassword ?? randomBytes(24).toString('hex');
      const nonceResponse = await fetch(`${baseUrl}/_synapse/admin/v1/register`);
      const { nonce } = await nonceResponse.json() as { nonce?: string };
      if (!nonceResponse.ok || !nonce) throw new Error('provision_nonce_unavailable');
      const mac = createHmac('sha1', registrationSecret).update([nonce, username, password, 'notadmin'].join('\0')).digest('hex');
      const created = await fetch(`${baseUrl}/_synapse/admin/v1/register`, { method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nonce, username, password, admin: false, mac }) });
      const createdBody = await created.json() as { user_id?: string; errcode?: string };
      if (!created.ok || createdBody.user_id !== userId) throw new Error(`create_user_http_${created.status}_${createdBody.errcode ?? 'identity_mismatch'}`);
      const login = await fetch(`${baseUrl}/_matrix/client/v3/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'm.login.password', identifier: { type: 'm.id.user', user: userId }, password, device_id: deviceId }) });
      if (!login.ok) throw new Error(`login_http_${login.status}`);
      const session = await login.json() as { access_token: string; user_id: string; device_id: string };
      return { ...session, password };
    }
    async function loginDevice(userId: string, password: string, deviceId: string) {
      const login = await fetch(`${baseUrl}/_matrix/client/v3/login`, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'm.login.password', identifier: { type: 'm.id.user', user: userId }, password, device_id: deviceId }) });
      if (!login.ok) throw new Error(`login_http_${login.status}`);
      return login.json() as Promise<{ access_token: string; user_id: string; device_id: string }>;
    }
    async function api(suffix: string, token: string, method: string, value?: unknown) {
      const response = await fetch(`${baseUrl}/_matrix/client/v3${suffix}`, { method,
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
      if (!response.ok) throw new Error(`matrix_http_${response.status}`);
      return response.json() as Promise<Record<string, unknown>>;
    }
    return { baseUrl, serverName: SERVER_NAME, version: versionBody.server_version ?? 'unknown', project, containers,
      // Only fixture composition may consume this ephemeral registration authority; never emit it in receipts.
      registrationSharedSecret: registrationSecret,
      probeSharedSecretRegistration, provision, loginDevice, api, close };
  } catch (error) { close(); throw error; }
}
