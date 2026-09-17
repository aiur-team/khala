import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, cpus, totalmem, platform, arch } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const composeFile = join(directory, 'compose.yaml');
class HttpFailure extends Error {
  status: number;
  constructor(status: number) {
    super(`HTTP ${status}`);
    this.status = status;
  }
}
function docker(args: string[], env = process.env): string {
  try {
    return execFileSync('docker', args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 }).trim();
  } catch {
    // Do not dump container logs, credentials or token-bearing HTTP bodies.
    throw new Error(`Docker operation failed: ${args.slice(0, 2).join(' ')}`);
  }
}
export function validate(): void {
  const config = JSON.parse(docker(['compose', '-p', 'khala-backend-spike', '-f', composeFile, 'config', '--format', 'json']));
  assert.deepEqual(Object.keys(config.services).sort(), ['postgres', 'synapse']);
  for (const service of Object.values(config.services) as any[]) {
    assert.match(service.image, /@sha256:[a-f0-9]{64}$/);
    assert.equal(service.privileged, undefined);
  }
  assert.equal(config.services.synapse.ports[0].host_ip, '127.0.0.1');
  assert.equal(config.networks.experiment.internal, true);
  assert.equal(config.services.postgres.ports, undefined);
}

export type BackendFixture = {
  baseUrl: string;
  alice: { user_id: string; access_token: string; device_id: string };
  bob: { user_id: string; access_token: string; device_id: string };
};

export async function proof(exercise?: (fixture: BackendFixture) => Promise<void>) {
  validate();
  const started = Date.now();
  const project = `khala-backend-spike-${randomBytes(8).toString('hex')}`;
  // Refuse to attach to any existing resources, including orphaned storage.
  for (const kind of ['container', 'volume', 'network']) {
    assert.equal(docker([kind, 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`]), '', 'Existing experiment resources refused');
  }
  const configDir = mkdtempSync(join(tmpdir(), 'khala-backend-'));
  const password = randomBytes(32).toString('hex');
  const registrationSecret = randomBytes(32).toString('hex');
  const env = { ...process.env, EXPERIMENT_CONFIG_DIR: configDir, EXPERIMENT_DB_PASSWORD: password };
  const compose = (...args: string[]) => docker(['compose', '-p', project, '-f', composeFile, ...args], env);
  try { writeFileSync(join(configDir, 'homeserver.yaml'), JSON.stringify({
    server_name: 'khala-test.invalid', report_stats: false,
    signing_key_path: '/data/server.signing.key', media_store_path: '/data/media',
    pid_file: '/data/homeserver.pid', registration_shared_secret: registrationSecret,
    enable_registration: false, suppress_key_server_warning: true, trusted_key_servers: [],
    listeners: [{ port: 8008, type: 'http', tls: false, bind_addresses: ['0.0.0.0'], resources: [{ names: ['client'], compress: false }] }],
    database: { name: 'psycopg2', args: { user: 'synapse', password, database: 'synapse', host: 'postgres', cp_min: 1, cp_max: 5 } },
    rc_message: { per_second: 100, burst_count: 100 },
  }), { mode: 0o600 }); }
  catch (error) { rmSync(configDir, { recursive: true, force: true }); throw error; }
  let base = '';
  const api = async (path: string, token?: string, body?: unknown, method = 'GET') => {
    const response = await fetch(base + path, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new HttpFailure(response.status);
    return response.json() as Promise<any>;
  };
  const ready = async (token?: string, probe?: () => Promise<unknown>) => {
    for (let attempt = 0; attempt < 90; attempt++) {
      try { await (probe ? probe() : api(token ? '/_matrix/client/v3/account/whoami' : '/_matrix/client/versions', token)); return; } catch {}
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error('Readiness deadline exceeded');
  };
  try {
    compose('up', '-d', '--wait', '--wait-timeout', '90');
    base = `http://${compose('port', 'synapse', '8008')}`;
    await ready();
    const version = await api('/_matrix/client/versions');
    const register = async (username: string) => {
      const { nonce } = await api('/_synapse/admin/v1/register');
      const mac = createHmac('sha1', registrationSecret).update([nonce, username, password, 'notadmin'].join('\0')).digest('hex');
      return api('/_synapse/admin/v1/register', undefined, { nonce, username, password, admin: false, mac }, 'POST');
    };
    const alice = await register('alice');
    const bob = await register('bob');
    if (exercise) await exercise({ baseUrl: base, alice, bob });
    const room = await api('/_matrix/client/v3/createRoom', alice.access_token, { visibility: 'private', invite: [bob.user_id] }, 'POST');
    await api(`/_matrix/client/v3/join/${encodeURIComponent(room.room_id)}`, bob.access_token, {}, 'POST');
    const eventPath = `/_matrix/client/v3/rooms/${encodeURIComponent(room.room_id)}`;
    const marker = 'synthetic-plaintext-persistence-marker';
    const event = await api(`${eventPath}/send/m.room.message/proof1`, alice.access_token, { msgtype: 'm.text', body: marker }, 'PUT');
    const readEvent = () => api(`${eventPath}/event/${encodeURIComponent(event.event_id)}`, bob.access_token);
    assert.equal((await readEvent()).content.body, marker);
    const keyFingerprint = () => createHash('sha256').update(compose('exec', '-T', 'synapse', 'cat', '/data/server.signing.key')).digest('hex');
    const beforeKey = keyFingerprint();
    const restartStarted = Date.now();
    compose('stop', 'synapse');
    compose('restart', 'postgres');
    compose('up', '-d', '--wait', '--wait-timeout', '90');
    base = `http://${compose('port', 'synapse', '8008')}`;
    await ready(alice.access_token);
    assert.equal(keyFingerprint(), beforeKey);
    assert.equal((await api('/_matrix/client/v3/account/whoami', alice.access_token)).user_id, alice.user_id);
    assert.equal((await api('/_matrix/client/v3/account/whoami', bob.access_token)).user_id, bob.user_id);
    assert.equal((await readEvent()).content.body, marker);
    const replay = await api(`${eventPath}/messages?dir=b&limit=20`, bob.access_token);
    assert.ok(replay.chunk.some((entry: any) => entry.event_id === event.event_id));
    const restartMs = Date.now() - restartStarted;
    compose('stop', 'postgres');
    // A transport timeout does not establish whether a write was committed.
    let outageOutcome = 'unexpected-success';
    try {
      await api(`${eventPath}/send/m.room.message/outage`, alice.access_token, { msgtype: 'm.text', body: marker }, 'PUT');
    } catch (error) {
      if (error instanceof HttpFailure && error.status >= 500) outageOutcome = `http-${error.status}-rejected`;
      else if (error instanceof Error && error.name === 'TimeoutError') outageOutcome = 'timeout-unknown';
      else throw error;
    }
    assert.notEqual(outageOutcome, 'unexpected-success', 'Database outage unexpectedly accepted a write');
    compose('start', 'postgres');
    // Fresh transaction cannot succeed from the cached pre-outage event.
    const recoveryTransaction = `recovery-${randomBytes(16).toString('hex')}`;
    let recoveryEvent: { event_id: string } | undefined;
    await ready(undefined, async () => {
      recoveryEvent = await api(`${eventPath}/send/m.room.message/${recoveryTransaction}`, alice.access_token, { msgtype: 'm.text', body: 'synthetic-recovery-marker' }, 'PUT');
    });
    assert.ok(recoveryEvent?.event_id);
    assert.notEqual(recoveryEvent.event_id, event.event_id);
    assert.equal((await api(`${eventPath}/event/${encodeURIComponent(recoveryEvent.event_id)}`, bob.access_token)).content.body, 'synthetic-recovery-marker');
    const containerIds = compose('ps', '-q').split(/\s+/);
    const statistics = docker(['stats', '--no-stream', '--format', '{{.Name}}: {{.CPUPerc}} CPU; {{.MemUsage}} memory; {{.BlockIO}} block IO', ...containerIds]).split('\n');
    const disk = compose('exec', '-T', 'postgres', 'du', '-sk', '/var/lib/postgresql/data').split(/\s+/)[0];
    const result = {
      experiment: 'backend', recorded_at: new Date().toISOString(), server_name: 'khala-test.invalid',
      images: Object.fromEntries(Object.entries(JSON.parse(compose('config', '--format', 'json')).services).map(([name, service]) => [name, (service as { image: string }).image])),
      host: { platform: platform(), arch: arch(), cpu: cpus()[0]?.model, logical_cpus: cpus().length, ram_bytes: totalmem(), node: process.version, docker: docker(['version', '--format', '{{.Server.Version}}']) },
      synapse_version: compose('exec', '-T', 'synapse', 'python', '-c', 'import synapse; print(synapse.__version__)'),
      postgres_version: compose('exec', '-T', 'postgres', 'postgres', '--version'),
      protocol_versions: version.versions,
      restart_identity: 'pass', restart_history: 'pass', two_identities: 'pass', unavailable_database_write: outageOutcome, database_recovery: 'fresh-write-and-readback-pass',
      restart_ms: restartMs, duration_ms: Date.now() - started, container_samples: statistics, postgres_disk_kib: Number(disk),
      crypto_proof: 'not-run: owned by KHA-141/142', backup_restore: 'not-run', railway: 'not-run', cost: 'unmeasured',
    };
    return result;
  } finally {
    // Only this random project's resources; never global prune or old workspaces.
    try { compose('down', '--volumes', '--remove-orphans'); }
    finally { rmSync(configDir, { recursive: true, force: true }); }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--proof')) console.log(JSON.stringify(await proof(), null, 2));
  else { validate(); console.log('Compose isolation and immutable images: pass'); }
}
