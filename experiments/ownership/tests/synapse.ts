// Disposable Synapse/Postgres for the live journey. Reuses KHA-102's pinned
// compose file read-only, with this experiment's own homeserver config that
// enables JWT login for endpoint-created devices.
import { execFileSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const composeFile = join(dirname(fileURLToPath(import.meta.url)), '../../backend/compose.yaml');
export const SERVER_NAME = 'khala-test.invalid';

export type Synapse = { baseUrl: string; adminToken: string; version: string; close(): void };

function docker(args: string[], env: NodeJS.ProcessEnv): string {
  try {
    return execFileSync('docker', args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 }).trim();
  } catch {
    // Container output can carry credentials; report only the operation.
    throw new Error(`Docker operation failed: ${args.slice(0, 2).join(' ')}`);
  }
}

export async function startSynapse(jwtConfig: object): Promise<Synapse> {
  const project = `khala-ownership-spike-${randomBytes(8).toString('hex')}`;
  const configDir = mkdtempSync(join(tmpdir(), 'khala-ownership-synapse-'));
  const password = randomBytes(32).toString('hex');
  const registrationSecret = randomBytes(32).toString('hex');
  const env = { ...process.env, EXPERIMENT_CONFIG_DIR: configDir, EXPERIMENT_DB_PASSWORD: password };
  const compose = (...args: string[]) => docker(['compose', '-p', project, '-f', composeFile, ...args], env);
  const close = () => {
    try { compose('down', '--volumes', '--remove-orphans'); } finally { rmSync(configDir, { recursive: true, force: true }); }
  };
  try {
    writeFileSync(join(configDir, 'homeserver.yaml'), JSON.stringify({
      server_name: SERVER_NAME, report_stats: false, signing_key_path: '/data/server.signing.key', media_store_path: '/data/media',
      pid_file: '/data/homeserver.pid', registration_shared_secret: registrationSecret, enable_registration: false,
      suppress_key_server_warning: true, trusted_key_servers: [], jwt_config: jwtConfig,
      listeners: [{ port: 8008, type: 'http', tls: false, bind_addresses: ['0.0.0.0'], resources: [{ names: ['client'], compress: false }] }],
      database: { name: 'psycopg2', args: { user: 'synapse', password, database: 'synapse', host: 'postgres', cp_min: 1, cp_max: 5 } },
      rc_message: { per_second: 100, burst_count: 100 }, rc_login: { address: { per_second: 100, burst_count: 100 }, account: { per_second: 100, burst_count: 100 } },
    }), { mode: 0o600 });
    compose('up', '-d', '--wait', '--wait-timeout', '120');
    const baseUrl = `http://${compose('port', 'synapse', '8008')}`;
    for (let attempt = 0; ; attempt++) {
      try { if ((await fetch(`${baseUrl}/_matrix/client/versions`)).ok) break; } catch {}
      if (attempt > 90) throw new Error('Synapse readiness deadline exceeded');
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    // Server-side provisioning credential, created through the local shared-secret boundary.
    const { nonce } = await (await fetch(`${baseUrl}/_synapse/admin/v1/register`)).json();
    const adminPassword = randomBytes(24).toString('hex');
    const mac = createHmac('sha1', registrationSecret).update([nonce, 'khala-provisioner', adminPassword, 'admin'].join('\0')).digest('hex');
    const registered = await fetch(`${baseUrl}/_synapse/admin/v1/register`, { method: 'POST', body: JSON.stringify({ nonce, username: 'khala-provisioner', password: adminPassword, admin: true, mac }) });
    if (!registered.ok) throw new Error(`admin registration failed: HTTP ${registered.status}`);
    const version = (await (await fetch(`${baseUrl}/_synapse/admin/v1/server_version`)).json()).server_version;
    return { baseUrl, adminToken: (await registered.json()).access_token, version, close };
  } catch (error) {
    close();
    throw error;
  }
}
