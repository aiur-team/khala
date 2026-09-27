/// <reference lib="dom" />
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { openMatrixConnectorSubstrate } from '../../apps/connector/src/substrate/matrix';
import { agentMatrixIdentity, createMatrixAgentAdmission } from '../../apps/control/src/composition/agent/matrix-admission';
import { build } from '../../apps/connector/node_modules/vite/dist/node/index.js';

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
  const api = async (pathSuffix: string, token: string, method: string, value?: unknown) => {
    const response = await fetch(`${synapse.baseUrl}/_matrix/client/v3${pathSuffix}`, { method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    if (!response.ok) throw new Error(`matrix_http_${response.status}`);
    return response.json() as Promise<Record<string, unknown>>;
  };
  const provision = async (userId: string, password: string, deviceId: string) => {
    const response = await fetch(`${synapse.baseUrl}/_synapse/admin/v2/users/${encodeURIComponent(userId)}`, {
      method: 'PUT', headers: { authorization: `Bearer ${synapse.adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ password, displayname: 'Revocation live fixture', admin: false }),
    });
    if (!response.ok) throw new Error(`create_user_http_${response.status}`);
    const login = await fetch(`${synapse.baseUrl}/_matrix/client/v3/login`, { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'm.login.password', identifier: { type: 'm.id.user', user: userId }, password, device_id: deviceId }) });
    if (!login.ok) throw new Error(`login_http_${login.status}`);
    return login.json() as Promise<{ access_token: string; user_id: string; device_id: string }>;
  };
  const ownerId = 'owner_live';
  const harness = 'claude';
  const sessionId = 'session_live';
  const identity = agentMatrixIdentity(ownerId as never, { harness, sessionId } as never, SERVER_NAME);
  const userId = identity.userId;
  const derivationSecret = '344-disposable-derivation-secret-'.repeat(2);
  const password = createHmac('sha256', derivationSecret).update('khala-matrix-agent-password-v1\0')
    .update(userId).digest('base64url');
  const deviceId = 'KHALA_REVOCATION_LIVE';
  const auth = await provision(userId, password, deviceId);
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

  const peerRoot = path.resolve('apps/connector/fixtures/live-revocation-peer');
  const peerBundle = path.join(directory, 'peer-bundle');
  await build({ root: peerRoot, configFile: false, logLevel: 'error', build: { outDir: peerBundle, emptyOutDir: true } });
  const staticServer = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    const filename = path.resolve(peerBundle, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!filename.startsWith(`${peerBundle}${path.sep}`)) { response.writeHead(404).end(); return; }
    try {
      const bytes = await readFile(filename);
      response.writeHead(200, { 'content-type': filename.endsWith('.js') ? 'text/javascript'
        : filename.endsWith('.wasm') ? 'application/wasm' : 'text/html' }).end(bytes);
    }
    catch { response.writeHead(404).end(); }
  });
  await new Promise<void>(resolve => staticServer.listen(0, '127.0.0.1', resolve));
  const address = staticServer.address();
  if (!address || typeof address === 'string') throw new Error('peer_server_unavailable');
  const peerOrigin = `http://127.0.0.1:${address.port}`;
  const requireDriver = createRequire(path.resolve('apps/connector/package.json'));
  const { chromium } = requireDriver('playwright-core') as typeof import('../../apps/connector/node_modules/playwright-core');
  const contexts: Array<Awaited<ReturnType<typeof chromium.launchPersistentContext>>> = [];
  try {
    const cryptoOwnerId = 'owner_crypto';
    const cryptoIdentity = agentMatrixIdentity(cryptoOwnerId as never, { harness, sessionId: 'session_crypto' } as never, SERVER_NAME);
    const cryptoPassword = createHmac('sha256', derivationSecret).update('khala-matrix-agent-password-v1\0')
      .update(cryptoIdentity.userId).digest('base64url');
    const targetDeviceId = 'KHALA_CRYPTO_TARGET';
    const target = await provision(cryptoIdentity.userId, cryptoPassword, targetDeviceId);
    const senderUserId = `@khala_344_sender:${SERVER_NAME}`;
    const senderDeviceId = 'KHALA_CRYPTO_SENDER';
    const sender = await provision(senderUserId, randomBytes(24).toString('hex'), senderDeviceId);
    const created = await api('/createRoom', sender.access_token, 'POST', { visibility: 'private',
      invite: [target.user_id], initial_state: [{ type: 'm.room.encryption', state_key: '',
        content: { algorithm: 'm.megolm.v1.aes-sha2' } }] });
    if (typeof created.room_id !== 'string') throw new Error('crypto_room_missing');
    const cryptoRoomId = created.room_id;
    await api(`/join/${encodeURIComponent(cryptoRoomId)}`, target.access_token, 'POST', {});
    async function openPeer(name: string, credentials: typeof sender, device: string) {
      const context = await chromium.launchPersistentContext(path.join(directory, name), { executablePath: '/usr/bin/chromium', headless: true });
      contexts.push(context);
      const page = await context.newPage();
      await page.goto(peerOrigin);
      await page.waitForFunction(() => !!(window as unknown as { revocationPeer?: unknown }).revocationPeer);
      const keys = await page.evaluate(async config => (window as unknown as { revocationPeer: {
        open(value: unknown): Promise<{ ed25519: string; curve25519: string }> } }).revocationPeer.open(config), {
        baseUrl: synapse.baseUrl, userId: credentials.user_id, deviceId: device,
        accessToken: credentials.access_token, storeName: name });
      return { page, keys };
    }
    const sourcePeer = await openPeer('sender', sender, senderDeviceId);
    const targetPeer = await openPeer('target', target, targetDeviceId);
    for (const entry of [{ credentials: sender, device: senderDeviceId, fingerprint: sourcePeer.keys.ed25519 },
      { credentials: target, device: targetDeviceId, fingerprint: targetPeer.keys.ed25519 }]) {
      let published = false;
      for (let attempt = 0; attempt < 30 && !published; attempt++) {
        const query = await api('/keys/query', sender.access_token, 'POST', {
          device_keys: { [entry.credentials.user_id]: [entry.device] } });
        const byUser = (query.device_keys as Record<string, Record<string, { keys?: Record<string, string> }>> | undefined)?.[entry.credentials.user_id];
        published = byUser?.[entry.device]?.keys?.[`ed25519:${entry.device}`] === entry.fingerprint;
        if (!published) await new Promise(resolve => setTimeout(resolve, 500));
      }
      if (!published) throw new Error('peer_published_fingerprint_missing');
    }
    const trust = async (page: typeof sourcePeer.page, user: string, device: string, fingerprint: string) =>
      page.evaluate(async value => (window as unknown as { revocationPeer: {
        trust(user: string, device: string, fingerprint: string): Promise<boolean> } }).revocationPeer.trust(value.user, value.device, value.fingerprint),
      { user, device, fingerprint });
    if (!await trust(sourcePeer.page, target.user_id, targetDeviceId, targetPeer.keys.ed25519)
      || !await trust(targetPeer.page, sender.user_id, senderDeviceId, sourcePeer.keys.ed25519)) throw new Error('peer_trust_failed');
    const canaryBefore = randomBytes(16).toString('hex');
    const oldEventId = await sourcePeer.page.evaluate(async value => (window as unknown as { revocationPeer: {
      send(roomId: string, body: string): Promise<string> } }).revocationPeer.send(value.roomId, value.body),
    { roomId: cryptoRoomId, body: canaryBefore });
    const wire = async (eventId: string) => api(`/rooms/${encodeURIComponent(cryptoRoomId)}/event/${encodeURIComponent(eventId)}`,
      sender.access_token, 'GET');
    const oldCiphertext = await wire(oldEventId);
    const decrypt = async (raw: Record<string, unknown>) => targetPeer.page.evaluate(async value =>
      (window as unknown as { revocationPeer: { decryptRaw(raw: Record<string, unknown>): Promise<{ kind: string; body?: unknown }> } }).revocationPeer.decryptRaw(value), raw);
    let oldResult: { kind: string; body?: unknown } = { kind: 'missing' };
    for (let attempt = 0; attempt < 30 && oldResult.kind !== 'clear'; attempt++) {
      oldResult = await decrypt(oldCiphertext);
      if (oldResult.kind !== 'clear') await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (oldResult.kind !== 'clear' || oldResult.body !== canaryBefore) throw new Error('pre_removal_decrypt_missing');
    const cryptoBinding = { v: 1, bindingId: 'binding_crypto', ownerId: cryptoOwnerId,
      agentParticipantId: cryptoIdentity.participantId, deviceId: targetDeviceId,
      harness, sessionId: 'session_crypto', generation: 1 } as never;
    const cryptoControl = createMatrixAgentAdmission({ homeserverOrigin: 'https://matrix.invalid',
      serverName: SERVER_NAME, registrationSharedSecret: '344-disposable-registration-secret-'.repeat(2),
      passwordDerivationSecret: derivationSecret, invitationHmacSecret: '344-disposable-invitation-secret-'.repeat(2),
      store: {} as never, clock: Date.now,
      fetch: ((input: string | URL | Request, init?: RequestInit) => fetch(String(input).replace('https://matrix.invalid', synapse.baseUrl), init)) as typeof fetch });
    const key = targetPeer.keys.curve25519;
    if (await cryptoControl.inspectPublishedDevice(cryptoBinding, key) !== 'present'
      || await cryptoControl.removePublishedDeviceWithUIA(cryptoBinding, key) !== 'removed') throw new Error('target_removal_failed');
    await sourcePeer.page.evaluate(async roomId => (window as unknown as { revocationPeer: { discard(roomId: string): Promise<void> } }).revocationPeer.discard(roomId), cryptoRoomId);
    const canaryAfter = randomBytes(16).toString('hex');
    const newEventId = await sourcePeer.page.evaluate(async value => (window as unknown as { revocationPeer: {
      send(roomId: string, body: string): Promise<string> } }).revocationPeer.send(value.roomId, value.body),
    { roomId: cryptoRoomId, body: canaryAfter });
    const newCiphertext = await wire(newEventId);
    const stillOld = await decrypt(oldCiphertext);
    const newResult = await decrypt(newCiphertext);
    const oldSession = (oldCiphertext.content as Record<string, unknown> | undefined)?.session_id;
    const newSession = (newCiphertext.content as Record<string, unknown> | undefined)?.session_id;
    if (stillOld.kind !== 'clear' || stillOld.body !== canaryBefore || newResult.kind !== 'missing'
      || typeof oldSession !== 'string' || typeof newSession !== 'string' || oldSession === newSession) {
      throw new Error('future_ciphertext_exclusion_not_proven');
    }
    console.log(JSON.stringify({ cryptoPeer: 'actual_matrix_js_sdk', preRemovalDecrypt: 'clear',
      retainedOldSessionAfterRemoval: 'clear', postRotationDecrypt: 'missing_key', outboundSessionChanged: true }));
  } finally {
    await Promise.all(contexts.map(context => context.close()));
    await new Promise<void>(resolve => staticServer.close(() => resolve()));
  }
} finally {
  await rm(directory, { recursive: true, force: true });
  synapse.close();
}
