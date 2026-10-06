import { fork } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHmac, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createClient, ClientEvent, SyncState, Preset } from 'matrix-js-sdk';
import { logger } from 'matrix-js-sdk/lib/logger';
import { LISTENING_MODE_COMMAND_TYPE } from '@khala/contracts/m1/listening-mode';
logger.disableAll();
const root = path.join(process.argv[3]!, 'crypto-' + randomBytes(4).toString('hex'));
await mkdir(root, { recursive: true, mode: 0o700 });
const homeserver = process.argv[2]!;
const secret = process.env.KHALA_CRYPTO_TEST_SECRET!;
async function request(endpoint: string, body?: unknown) {
  const res = await fetch(homeserver + endpoint, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`request_${res.status}_${endpoint}`);
  return res.json();
}
async function register(label: string, deviceId: string) {
  const username = label + randomBytes(4).toString('hex'), password = randomBytes(24).toString('hex');
  const { nonce } = await request('/_synapse/admin/v1/register');
  const mac = createHmac('sha1', secret).update(`${nonce}\0${username}\0${password}\0notadmin`).digest('hex');
  const { user_id: userId } = await request('/_synapse/admin/v1/register', { nonce, username, password, admin: false, mac });
  const creds = await request('/_matrix/client/v3/login', { type: 'm.login.password', identifier: { type: 'm.id.user', user: userId }, password, device_id: deviceId });
  return { homeserver, userId, deviceId, accessToken: creds.access_token, roomId: '', password };
}
async function eventually(read: () => boolean, label: string, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (!read()) { if (Date.now() > deadline) throw new Error('timeout_' + label); await delay(100); }
}
const children: ChildProcess[] = [];
const owner = await register('owner', 'OWNER');
const agent = await register('agent', 'AGENT');
const human = createClient({ baseUrl: homeserver, userId: owner.userId, deviceId: owner.deviceId, accessToken: owner.accessToken });
async function boot(restore = false) {
  type Event = { kind: string; message?: { body?: string }; command?: { content: { mode: string } }; page?: { messages: { body: string }[] } };
  const events: Event[] = [];
  const child = fork('fixtures/crypto-store/live-agent.ts', [], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  children.push(child);
  let error: string | undefined;
  child.stdout!.resume();
  child.on('message', (event: Event) => { events.push(event); if (event.kind === 'error') error = String(event.message); console.log('agent_event', event.kind, event.command?.content.mode); });
  let stderr = ''; child.stderr!.on('data', chunk => { stderr += String(chunk); });
  child.send({ credentials: agent, root, restore });
  await eventually(() => !!error || events.some(e => e.kind === 'started') || child.exitCode !== null, 'agent_start');
  if (error || child.exitCode !== null) throw new Error(error ?? stderr);
  return { child, events, ready: () => eventually(() => events.some(e => e.kind === 'ready'), 'agent_join') };
}
try {
  await human.initRustCrypto({ useIndexedDB: false });
  const prepared = new Promise<void>(resolve => human.on(ClientEvent.Sync, state => { if (state === SyncState.Prepared || state === SyncState.Syncing) resolve(); }));
  await human.startClient({ initialSyncLimit: 30 }); await prepared;
  const { room_id: roomId } = await human.createRoom({ preset: Preset.PrivateChat, initial_state: [
    { type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } },
    { type: 'm.room.history_visibility', state_key: '', content: { history_visibility: 'shared' } },
  ] });
  agent.roomId = roomId;
  await eventually(() => !!human.getRoom(roomId)?.currentState.getStateEvents('m.room.encryption', ''), 'owner_room');
  const first = await boot(); await human.invite(roomId, agent.userId); await first.ready();
  await human.sendTextMessage(roomId, 'before-restart');
  await eventually(() => first.events.some(e => e.message?.body === 'before-restart'), 'initial_decryption');
  console.log('initial decrypted');
  first.child.kill('SIGKILL'); await new Promise(resolve => first.child.once('exit', resolve));
  await human.sendTextMessage(roomId, 'offline-one'); await human.sendTextMessage(roomId, 'offline-two');
  await human.sendEvent(roomId, LISTENING_MODE_COMMAND_TYPE as never, { v: 1, agent: agent.userId, mode: 'async' } as never);
  for (let i = 0; i < 40; i++) await human.sendTextMessage(roomId, `backlog-${i}`);
  // Control still issues fresh credentials; automatic resume must retain the
  // saved device/token instead of discarding the existing keys for that device.
  const relogin = await request('/_matrix/client/v3/login', { type: 'm.login.password', identifier: { type: 'm.id.user', user: agent.userId }, password: agent.password, device_id: 'FRESH_CONTROL_DEVICE' });
  agent.accessToken = relogin.access_token; agent.deviceId = relogin.device_id;
  console.log('offline sends done');
  const second = await boot(true); await second.ready(); second.child.send('mode');
  await eventually(() => ['offline-one', 'offline-two'].every(body => second.events.some(e => e.message?.body === body)) && second.events.some(e => e.kind === 'mode' && e.command?.content.mode === 'async'), 'offline_decryption', 60_000);
  console.log('offline decrypted');
  second.child.send('history');
  await eventually(() => second.events.some(e => e.kind === 'history'), 'history');
  const history = second.events.find(e => e.kind === 'history')!.page!.messages;
  if (!['offline-one', 'offline-two'].every(body => history.some((e: { body: string }) => e.body === body))) throw new Error('history_decryption_failed');
  second.child.send('close'); await new Promise(resolve => second.child.once('exit', resolve));
  await human.sendTextMessage(roomId, 'after-exit');
  console.log('exit done');
  const third = await boot(true); await third.ready();
  await eventually(() => third.events.some(e => e.message?.body === 'after-exit'), 'exit_resume');
  third.child.send('close'); await new Promise(resolve => third.child.once('exit', resolve));
  console.log(JSON.stringify({ initialDecrypted: true, abruptRestartMessages: 2, offlineModeApplied: true, historyDecrypted: true, savedDeviceCredentials: true, exitResumeDecrypted: true }));
} finally {
  human.stopClient();
  for (const child of children) if (child.exitCode === null) child.kill('SIGKILL');
  await rm(root, { recursive: true, force: true });
}

process.exit(0);
