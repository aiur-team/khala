import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHmac, randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { openMatrixConnectorSubstrate } from '../../apps/connector/src/substrate/matrix';
import { agentMatrixIdentity, createMatrixAgentAdmission } from '../../apps/control/src/composition/agent/matrix-admission';

const SERVER_NAME = 'khala-test.invalid';
const composeFile = path.resolve('experiments/backend/compose.yaml');
function docker(args: string[], env: NodeJS.ProcessEnv): string {
  try { return execFileSync('docker', args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 }).trim(); }
  catch { throw new Error(`docker_${args[0]}_failed`); }
}
async function startSynapse() {
  const project = `khala-revocation-${randomBytes(8).toString('hex')}`;
  const configDir = mkdtempSync(path.join(os.tmpdir(), 'khala-344-synapse-'));
  const databasePassword = randomBytes(32).toString('hex');
  const registrationSecret = randomBytes(32).toString('hex');
  const env = { ...process.env, EXPERIMENT_CONFIG_DIR: configDir, EXPERIMENT_DB_PASSWORD: databasePassword };
  const compose = (...args: string[]) => docker(['compose', '-p', project, '-f', composeFile, ...args], env);
  const close = () => {
    try { compose('down', '--volumes', '--remove-orphans'); }
    finally { rmSync(configDir, { recursive: true, force: true }); }
  };
  try {
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
    const baseUrl = `http://${compose('port', 'synapse', '8008')}`;
    const nonceResponse = await fetch(`${baseUrl}/_synapse/admin/v1/register`);
    const nonceBody = await nonceResponse.json() as { nonce?: string };
    if (!nonceResponse.ok || !nonceBody.nonce) throw new Error('admin_nonce_unavailable');
    const adminPassword = randomBytes(24).toString('hex');
    const mac = createHmac('sha1', registrationSecret).update([nonceBody.nonce, 'khala-344-provisioner', adminPassword, 'admin'].join('\0')).digest('hex');
    const registered = await fetch(`${baseUrl}/_synapse/admin/v1/register`, { method: 'POST',
      body: JSON.stringify({ nonce: nonceBody.nonce, username: 'khala-344-provisioner', password: adminPassword, admin: true, mac }) });
    const body = await registered.json() as { access_token?: string };
    if (!registered.ok || !body.access_token) throw new Error('admin_registration_failed');
    const versionResponse = await fetch(`${baseUrl}/_synapse/admin/v1/server_version`);
    const versionBody = await versionResponse.json() as { server_version?: string };
    return { baseUrl, adminToken: body.access_token, version: versionBody.server_version ?? 'unknown', close };
  } catch (error) { close(); throw error; }
}

const synapse = await startSynapse();
const directory = await mkdtemp(path.join(os.homedir(), '.cache', 'khala-344-live-'));
try {
  const ownerId = 'owner_live';
  const harness = 'claude';
  const sessionId = 'session_live';
  const identity = agentMatrixIdentity(ownerId as never, { harness, sessionId } as never, SERVER_NAME);
  const userId = identity.userId;
  const derivationSecret = '344-disposable-derivation-secret-'.repeat(2);
  const password = createHmac('sha256', derivationSecret).update('khala-matrix-agent-password-v1\0')
    .update(userId).digest('base64url');
  const created = await fetch(`${synapse.baseUrl}/_synapse/admin/v2/users/${encodeURIComponent(userId)}`, {
    method: 'PUT', headers: { authorization: `Bearer ${synapse.adminToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ password, displayname: 'Revocation live fixture', admin: false }),
  });
  if (!created.ok) throw new Error(`create_user_http_${created.status}`);
  const deviceId = 'KHALA_REVOCATION_LIVE';
  const login = await fetch(`${synapse.baseUrl}/_matrix/client/v3/login`, { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'm.login.password', identifier: { type: 'm.id.user', user: userId },
      password, device_id: deviceId }) });
  if (!login.ok) throw new Error(`login_http_${login.status}`);
  const auth = await login.json() as { access_token: string; user_id: string; device_id: string };
  const roomResponse = await fetch(`${synapse.baseUrl}/_matrix/client/v3/createRoom`, { method: 'POST',
    headers: { authorization: `Bearer ${auth.access_token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ visibility: 'private', preset: 'private_chat', initial_state: [
      { type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } },
    ] }) });
  if (!roomResponse.ok) throw new Error(`room_http_${roomResponse.status}`);
  const room = await roomResponse.json() as { room_id: string };
  const substrate = await openMatrixConnectorSubstrate({ baseUrl: synapse.baseUrl, userId, deviceId,
    accessToken: auth.access_token, roomId: room.room_id, profileDirectory: path.join(directory, 'profile'),
    participantIdFor: () => null, chromiumExecutablePath: '/usr/bin/chromium',
    browserBundleDirectory: path.resolve('apps/connector/dist/substrate-browser'),
    browserDriverDirectory: path.resolve('apps/connector/node_modules/playwright-core') });
  try {
    let curve25519: string | undefined;
    for (let attempt = 0; attempt < 30 && !curve25519; attempt++) {
      const keyResponse = await fetch(`${synapse.baseUrl}/_matrix/client/v3/keys/query`, { method: 'POST',
        headers: { authorization: `Bearer ${auth.access_token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ device_keys: { [userId]: [deviceId] } }) });
      const keys = await keyResponse.json() as { device_keys: Record<string, Record<string, { keys: Record<string, string> }>> };
      curve25519 = keys.device_keys[userId]?.[deviceId]?.keys[`curve25519:${deviceId}`];
      if (!curve25519) await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (!curve25519) throw new Error('published_key_missing');
    const discard = await substrate.discardOutboundSession();
    const removal = await substrate.removeOwnDevice(curve25519);
    const binding = { v: 1, bindingId: 'binding_live', ownerId, agentParticipantId: identity.participantId,
      deviceId, harness, sessionId, generation: 1 } as never;
    const matrixAgents = createMatrixAgentAdmission({ homeserverOrigin: 'https://matrix.invalid',
      serverName: SERVER_NAME, registrationSharedSecret: '344-disposable-registration-secret-'.repeat(2),
      passwordDerivationSecret: derivationSecret, invitationHmacSecret: '344-disposable-invitation-secret-'.repeat(2),
      store: {} as never, clock: Date.now,
      fetch: ((input: string | URL | Request, init?: RequestInit) => fetch(String(input).replace('https://matrix.invalid', synapse.baseUrl), init)) as typeof fetch });
    const before = await matrixAgents.inspectPublishedDevice(binding, curve25519);
    const uia = await matrixAgents.removePublishedDeviceWithUIA(binding, curve25519);
    const after = await matrixAgents.inspectPublishedDevice(binding, curve25519);
    if (!discard || removal !== 'reauthentication_required' || before !== 'present'
      || uia !== 'removed' || after !== 'removed') throw new Error('live_revocation_effect_not_proven');
    console.log(JSON.stringify({ synapseVersion: synapse.version, discard, removal, before, uia, after }));
  } finally { await substrate.close(); }
} finally {
  await rm(directory, { recursive: true, force: true });
  synapse.close();
}
