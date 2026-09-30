/// <reference lib="dom" />
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { build } from '../../apps/connector/node_modules/vite/dist/node/index.js';

const SERVER_NAME = 'khala-test.invalid';
const composeFile = path.resolve('experiments/backend/compose.yaml');
function docker(args: string[], env: NodeJS.ProcessEnv): string {
  try { return execFileSync('docker', args, { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 180_000 }).trim(); }
  catch { throw new Error(`docker_${args[0]}_failed`); }
}
async function startSynapse() {
  const project = `khala-agent-names-${randomBytes(8).toString('hex')}`;
  const configDir = mkdtempSync(path.join(os.tmpdir(), 'khala-548-synapse-'));
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
    const mac = createHmac('sha1', registrationSecret).update([nonceBody.nonce, 'khala-548-provisioner', adminPassword, 'admin'].join('\0')).digest('hex');
    const registered = await fetch(`${baseUrl}/_synapse/admin/v1/register`, { method: 'POST',
      body: JSON.stringify({ nonce: nonceBody.nonce, username: 'khala-548-provisioner', password: adminPassword, admin: true, mac }) });
    const body = await registered.json() as { access_token?: string };
    if (!registered.ok || !body.access_token) throw new Error('admin_registration_failed');
    const versionResponse = await fetch(`${baseUrl}/_synapse/admin/v1/server_version`);
    const versionBody = await versionResponse.json() as { server_version?: string };
    return { baseUrl, adminToken: body.access_token, version: versionBody.server_version ?? 'unknown', close };
  } catch (error) { close(); throw error; }
}

const synapse = await startSynapse();
const directory = await mkdtemp(path.join(os.tmpdir(), 'khala-548-live-'));
const contexts: import('playwright-core').BrowserContext[] = [];
let staticServer: ReturnType<typeof createServer> | null = null;
try {
  const api = async (suffix: string, token: string, method: string, value?: unknown) => {
    const response = await fetch(`${synapse.baseUrl}${suffix}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    if (!response.ok) throw new Error(`matrix_http_${response.status}`);
    return response.json() as Promise<Record<string, unknown>>;
  };
  const provision = async (name: string) => {
    const userId = `@${name}:${SERVER_NAME}`; const password = randomBytes(24).toString('hex');
    await api(`/_synapse/admin/v2/users/${encodeURIComponent(userId)}`, synapse.adminToken, 'PUT', { password });
    const login = await api('/_matrix/client/v3/login', '', 'POST', { type: 'm.login.password', identifier: { type: 'm.id.user', user: userId }, password,
      device_id: name.toUpperCase() });
    if (typeof login.access_token !== 'string') throw new Error('login_invalid');
    return { userId, deviceId: name.toUpperCase(), token: login.access_token };
  };
  const owner = await provision('maya'); const existingAgent = await provision('codex');
  const lateHuman = await provision('theo'); const lateAgent = await provision('scout');
  const created = await api('/_matrix/client/v3/createRoom', owner.token, 'POST', { visibility: 'private', invite: [existingAgent.userId], initial_state: [
    { type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } },
    { type: 'm.room.history_visibility', state_key: '', content: { history_visibility: 'joined' } },
  ] });
  if (typeof created.room_id !== 'string') throw new Error('room_missing'); const roomId = created.room_id;
  await api(`/_matrix/client/v3/join/${encodeURIComponent(roomId)}`, existingAgent.token, 'POST', {});
  const peerRoot = path.resolve('apps/connector/fixtures/live-agent-names-peer');
  const peerBundle = path.join(directory, 'peer-bundle');
  await build({ root: peerRoot, configFile: false, logLevel: 'error', build: { outDir: peerBundle, emptyOutDir: true } });
  staticServer = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    const filename = path.resolve(peerBundle, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!filename.startsWith(`${peerBundle}${path.sep}`)) { response.writeHead(404).end(); return; }
    try { const bytes = await readFile(filename); response.writeHead(200, { 'content-type': filename.endsWith('.js') ? 'text/javascript' : filename.endsWith('.wasm') ? 'application/wasm' : 'text/html' }).end(bytes); }
    catch { response.writeHead(404).end(); }
  });
  await new Promise<void>(resolve => staticServer!.listen(0, '127.0.0.1', resolve));
  const address = staticServer.address(); if (!address || typeof address === 'string') throw new Error('peer_server_missing');
  const { chromium } = createRequire(path.resolve('apps/connector/package.json'))('playwright-core') as typeof import('playwright-core');
  const open = async (person: typeof owner) => {
    const context = await chromium.launchPersistentContext(path.join(directory, person.deviceId), { executablePath: '/usr/bin/chromium', headless: true }); contexts.push(context);
    const page = await context.newPage(); await page.goto(`http://127.0.0.1:${address.port}`);
    const keys = await page.evaluate(async configuration => (window as unknown as { namesPeer: { open(value: unknown): Promise<{ ed25519: string }> } }).namesPeer.open(configuration),
      { baseUrl: synapse.baseUrl, userId: person.userId, deviceId: person.deviceId, accessToken: person.token, storeName: person.deviceId });
    return { page, keys, person };
  };
  const maya = await open(owner); const codex = await open(existingAgent);
  const trust = async (first: typeof maya, second: typeof maya) => first.page.evaluate(async value =>
    (window as unknown as { namesPeer: { trust(user: string, device: string, fingerprint: string): Promise<boolean> } }).namesPeer.trust(value.userId, value.deviceId, value.fingerprint),
    { userId: second.person.userId, deviceId: second.person.deviceId, fingerprint: second.keys.ed25519 });
  if (!await trust(maya, codex) || !await trust(codex, maya)) throw new Error('initial_trust_failed');
  const send = (content: Record<string, unknown>) => maya.page.evaluate(async value =>
    (window as unknown as { namesPeer: { sendContent(room: string, content: Record<string, unknown>): Promise<string> } }).namesPeer.sendContent(value.roomId, value.content), { roomId, content });
  const priorText = await send({ msgtype: 'm.text', body: 'private pre-join chat' });
  const priorRename = await send({ msgtype: 'm.notice', body: 'Dolan', 'com.khala.agent_participant_id': 'agent_codex' });
  const wire = (eventId: string) => api(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(eventId)}`, owner.token, 'GET');
  const oldText = await wire(priorText); const oldRename = await wire(priorRename);
  const decrypt = (peer: typeof maya, raw: Record<string, unknown>) => peer.page.evaluate(async value =>
    (window as unknown as { namesPeer: { decryptRaw(raw: Record<string, unknown>): Promise<{ kind: string; body?: unknown; content?: Record<string, unknown> }> } }).namesPeer.decryptRaw(value), raw);
  const awaitClear = async (peer: typeof maya, raw: Record<string, unknown>) => {
    for (let attempt = 0; attempt < 30; attempt++) { const result = await decrypt(peer, raw); if (result.kind === 'clear') return result; await new Promise(resolve => setTimeout(resolve, 500)); }
    throw new Error('decryption_missing');
  };
  if ((await awaitClear(codex, oldRename)).body !== 'Dolan') throw new Error('existing_agent_name_missing');
  for (const person of [lateHuman, lateAgent]) {
    await api(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`, owner.token, 'POST', { user_id: person.userId });
    await api(`/_matrix/client/v3/join/${encodeURIComponent(roomId)}`, person.token, 'POST', {});
  }
  const theo = await open(lateHuman); const scout = await open(lateAgent);
  for (const peer of [theo, scout]) { if (!await trust(maya, peer) || !await trust(peer, maya)) throw new Error('late_trust_failed'); }
  await maya.page.evaluate(async id => (window as unknown as { namesPeer: { discard(room: string): Promise<void> } }).namesPeer.discard(id), roomId);
  const snapshot = await send({ msgtype: 'm.notice', body: 'Dolan', 'com.khala.agent_participant_id': 'agent_codex',
    'com.khala.name_snapshot': true, 'com.khala.name_source_event_id': priorRename });
  const snapshotWire = await wire(snapshot);
  if (snapshotWire.type !== 'm.room.encrypted' || JSON.stringify(snapshotWire).includes('Dolan')) throw new Error('snapshot_not_encrypted');
  for (const peer of [theo, scout]) {
    const clear = await awaitClear(peer, snapshotWire);
    if (clear.body !== 'Dolan' || clear.content?.['com.khala.name_source_event_id'] !== priorRename) throw new Error('snapshot_current_name_missing');
    if ((await decrypt(peer, oldText)).kind !== 'missing' || (await decrypt(peer, oldRename)).kind !== 'missing') throw new Error('pre_join_history_widened');
    const response = await fetch(`${synapse.baseUrl}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(priorText)}`, { headers: { authorization: `Bearer ${peer.person.token}` } });
    if (response.status !== 403 && response.status !== 404) throw new Error(`history_access_widened_${response.status}`);
  }
  console.log(JSON.stringify({ kind: 'passed', synapseVersion: synapse.version, participants: 4,
    encryptedCurrentNameSnapshot: true, lateHumanAndAgentCurrentName: true, priorTextAndRenameUnavailable: true,
    scope: 'native Matrix encryption/history primitive; production membership publisher validated separately' }));
} finally {
  await Promise.all(contexts.map(context => context.close()));
  if (staticServer) await new Promise<void>(resolve => staticServer!.close(() => resolve()));
  synapse.close(); await rm(directory, { recursive: true, force: true });
}
