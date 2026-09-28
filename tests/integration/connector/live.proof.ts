// Opt-in KHA-133 base-runtime proof. A passing result requires a real disposable
// Synapse/Chromium peer, an actual existing Codex session, SIGKILL after its
// native queue accepted the release, and a same-disk restart.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { chromium } from '@playwright/test';
import { openMatrixConnectorSubstrate } from '../../../apps/connector/src/substrate/matrix';
import { startClosureSynapse } from '../fixtures/closure-synapse';
import { inspectNativeGate } from './native-gate';
import { killAtNativeAcceptance } from './supervisor';

type Peer = {
  open(input: { baseUrl: string; userId: string; deviceId: string; accessToken: string }): Promise<{ ed25519: string }>;
  send(roomId: string, body: string): Promise<{ event_id: string }>;
  trust(userId: string, deviceId: string, fingerprint: string): Promise<boolean>;
  rotate(roomId: string): Promise<void>;
};

const worker = fileURLToPath(new URL('./live-worker.ts', import.meta.url));
const peerRoot = fileURLToPath(new URL('../../../experiments/browser-crypto/dist/', import.meta.url));
const connectorBundle = fileURLToPath(new URL('../../../apps/connector/dist/substrate-browser/', import.meta.url));
const pending = 'pending-' + randomUUID();
const withheld = 'withheld-' + randomUUID();
const recoveryNamePattern = /^relay-recovery-([a-f0-9]{12})\.json$/u;
const browserScratchPrefix = 'k-';

function nativeScratchRoot(recoveryFile: string): string {
  const privateRoot = path.join(os.homedir(), '.cache', 'khala-executor');
  const match = recoveryNamePattern.exec(path.basename(recoveryFile));
  if (path.dirname(recoveryFile) !== privateRoot || !match) {
    throw new Error('native_crash_recovery_file_required');
  }
  return path.join(privateRoot, `s-${match[1]}`);
}

test('KHA-133 private Chromium socket path stays within the Linux Unix socket limit', {
  skip: process.platform !== 'linux' ? 'Linux Chromium socket budget' : undefined,
}, () => {
  const privateRoot = path.join(os.homedir(), '.cache', 'khala-executor');
  const recoveryFile = path.join(privateRoot, 'relay-recovery-000000000000.json');
  const scratchRoot = nativeScratchRoot(recoveryFile);
  assert.throws(() => nativeScratchRoot(path.join(privateRoot, 'r-000000000000.json')),
    /native_crash_recovery_file_required/u);
  assert.throws(() => nativeScratchRoot(path.join(privateRoot, 'other', path.basename(recoveryFile))),
    /native_crash_recovery_file_required/u);
  const runtimeSocket = path.join(scratchRoot, 'org.chromium.Chromium.XXXXXX', 'SingletonSocket');
  assert.ok(Buffer.byteLength(runtimeSocket) < 108, 'Chromium runtime socket fits the Linux limit');
  const profileSocket = path.join(scratchRoot, `${browserScratchPrefix}XXXXXX`,
    'peer', '.org.chromium.XXXXXX', 'SingletonSocket');
  assert.ok(Buffer.byteLength(profileSocket) < 108, 'browser profile socket has room for its terminator');
});

test('KHA-133 live base runtime: native accepted, SIGKILL, same binding, outcome unknown, no duplicate', {
  timeout: 360_000,
  skip: process.env.KHALA_42_LIVE !== '1' ? 'not_run: set KHALA_42_LIVE=1 for disposable native acceptance' : undefined,
}, async () => {
  const gate = await inspectNativeGate(process.env.KHALA_42_NATIVE_SESSION);
  if (gate.kind === 'blocked') {
    throw new Error('not_observed_native_gate: ' + gate.code);
  }
  const recoveryFile = process.env.KHALA_42_RECOVERY_FILE;
  if (!recoveryFile) throw new Error('native_crash_recovery_file_required');
  const scratchRoot = nativeScratchRoot(recoveryFile);
  if (process.env.TMPDIR !== scratchRoot) throw new Error('native_crash_scratch_scope_invalid');
  await mkdir(scratchRoot, { recursive: true, mode: 0o700 });
  const scratchStat = await lstat(scratchRoot);
  if (!scratchStat.isDirectory() || scratchStat.isSymbolicLink()
    || scratchStat.uid !== process.getuid?.() || (scratchStat.mode & 0o077) !== 0) {
    throw new Error('native_crash_scratch_scope_unsafe');
  }
  const scratch = await mkdtemp(path.join(scratchRoot, browserScratchPrefix));
  let peerServer: Awaited<ReturnType<typeof servePeer>> | null = null;
  let synapse: Awaited<ReturnType<typeof startClosureSynapse>> | null = null;
  try {
    peerServer = await servePeer();
    const peerOrigin = peerServer.origin;
    synapse = await startClosureSynapse({ recoveryFile, limits: {
      synapse: { memoryBytes: 1024 * 1024 * 1024, cpus: 1, pids: 256 },
      postgres: { memoryBytes: 512 * 1024 * 1024, cpus: 0.5, pids: 128 },
    } });
    const { baseUrl } = synapse;
    const aliceProvisioned = await synapse.provision(`@khala_crash_alice:${synapse.serverName}`, 'CRASH_ALICE');
    const bobProvisioned = await synapse.provision(`@khala_crash_bob:${synapse.serverName}`, 'CRASH_BOB');
    // The worker needs Matrix sessions, never the disposable account passwords.
    const alice = { user_id: aliceProvisioned.user_id, device_id: aliceProvisioned.device_id,
      access_token: aliceProvisioned.access_token };
    const bob = { user_id: bobProvisioned.user_id, device_id: bobProvisioned.device_id,
      access_token: bobProvisioned.access_token };
    const created = await synapse.api('/createRoom', alice.access_token, 'POST', {
      visibility: 'private', invite: [bob.user_id],
      initial_state: [{ type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } }],
    });
    assert.equal(typeof created.room_id, 'string', 'disposable encrypted room created');
    const roomId = created.room_id as string;
    await synapse.api('/join/' + encodeURIComponent(roomId), bob.access_token, 'POST', {});
    const browser = await chromium.launchPersistentContext(path.join(scratch, 'peer'), {
      executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'],
    });
    try {
      const page = await browser.newPage();
      await page.goto(peerOrigin);
      await page.waitForFunction(() => !!(globalThis as unknown as { peer?: Peer }).peer);
      const peerKey = await page.evaluate(input => (globalThis as unknown as { peer: Peer }).peer.open(input), {
        baseUrl, userId: alice.user_id, deviceId: alice.device_id, accessToken: alice.access_token,
      });
      const matrixInput = {
        baseUrl, userId: bob.user_id, deviceId: bob.device_id, accessToken: bob.access_token,
        roomId, profileDirectory: path.join(scratch, 'matrix'),
        browserBundleDirectory: connectorBundle,
        participantIdFor: (userId: string) => userId === alice.user_id ? 'owner-sender' as never : null,
      };
      const substrate = await openMatrixConnectorSubstrate(matrixInput);
      let eventRef: unknown;
      let withheldRef: unknown;
      try {
        assert.equal(await page.evaluate(({ userId, deviceId, fingerprint }) =>
          (globalThis as unknown as { peer: Peer }).peer.trust(userId, deviceId, fingerprint),
        { userId: bob.user_id, deviceId: bob.device_id, fingerprint: substrate.fingerprint }), true);
        await substrate.trustPeer(alice.user_id, alice.device_id, peerKey.ed25519);
        await page.evaluate(room => (globalThis as unknown as { peer: Peer }).peer.rotate(room), roomId);
        const sent = await page.evaluate(({ room, body }) =>
          (globalThis as unknown as { peer: Peer }).peer.send(room, body), { room: roomId, body: pending });
        const withheldSent = await page.evaluate(({ room, body }) =>
          (globalThis as unknown as { peer: Peer }).peer.send(room, body), { room: roomId, body: withheld });
        for (let attempt = 0; attempt < 30 && (!eventRef || !withheldRef); attempt++) {
          const read = await substrate.source.read({ cursor: null, limit: 100 });
          if (read.kind === 'page') {
            const found = read.events.find(event => event.ref.eventId === sent.event_id);
            if (found?.kind === 'decrypted') eventRef = found.ref;
            const withheldEvent = read.events.find(event => event.ref.eventId === withheldSent.event_id);
            if (withheldEvent?.kind === 'decrypted') withheldRef = withheldEvent.ref;
          }
          if (!eventRef || !withheldRef) await new Promise(resolve => setTimeout(resolve, 250));
        }
        assert.ok(eventRef, 'verified encrypted pending event');
        assert.ok(withheldRef, 'verified encrypted withheld event');
      } finally { await substrate.close(); }
      const packetFile = path.join(scratch, 'packet.json');
      const packet = {
        v: 1, baseUrl, roomId, alice, bob, eventRef, withheldRef,
        stateDirectory: path.join(scratch, 'ledger'),
        matrixProfile: path.join(scratch, 'matrix'),
        browserBundleDirectory: connectorBundle,
        inboxDirectory: path.join(scratch, 'inbox'),
        native: gate.fixture,
        pending, withheld,
        binding: {
          v: 1, bindingId: 'binding-' + randomUUID(), ownerId: 'owner-' + randomUUID(),
          agentParticipantId: 'agent-' + randomUUID(), deviceId: bob.device_id,
          harness: 'codex', sessionId: gate.fixture.sessionId, generation: 0,
        },
      };
      assert.notEqual(packet.binding.bindingId, gate.preflightBindingId,
        'crash ledger binding must be distinct from the native preflight binding');
      await writeFile(packetFile, JSON.stringify(packet), { mode: 0o600 });
      const env = { ...process.env, CODEX_HOME: gate.fixture.codexHome, KHALA_42_PACKET: packetFile };
      const crashed = await killAtNativeAcceptance({
        command: process.execPath, args: ['--import', 'tsx', worker, 'first'],
        cwd: process.cwd(), env, expectedReleaseId: 'release-live-1',
        expectedSessionId: gate.fixture.sessionId, timeoutMs: 90_000,
      });
      assert.equal(crashed.signal, 'SIGKILL');
      assert.equal(crashed.accepted.bindingId, packet.binding.bindingId);
      assert.ok(crashed.accepted.deviceFingerprint);
      assert.ok(crashed.accepted.signerThumbprint);
      // A dead process cannot still own the profile. Remove only this exact
      // scratch lock, then let the SDK verify its persisted identity.
      await rm(path.join(packet.matrixProfile, 'writer.lock'));
      const result = await recover(env);
      assert.equal(result.bindingId, packet.binding.bindingId);
      assert.equal(result.deviceId, packet.binding.deviceId);
      assert.equal(result.sessionId, packet.binding.sessionId);
      assert.equal(result.deviceFingerprint, crashed.accepted.deviceFingerprint);
      assert.equal(result.signerThumbprint, crashed.accepted.signerThumbprint);
      assert.equal(result.bootstrapOperationSame, true);
      assert.equal(result.recordState, 'outcome_unknown');
      assert.equal(result.restartSubmissions, 0);
      assert.equal(result.inboxReleaseCount, 1);
      assert.equal(result.releasedInInbox, true);
      assert.equal(result.withheldInInbox, false);
      assert.equal(result.pendingStillReviewable, true);
    } finally { await browser.close(); }
  } finally {
    try {
      const activePeer = peerServer;
      if (activePeer) await new Promise<void>(resolve => activePeer.server.close(() => resolve()));
    } finally {
      try { synapse?.close(); }
      finally { await rm(scratchRoot, { recursive: true, force: true }); }
    }
  }
});

type Recovery = Readonly<{
  kind: 'recovered'; bindingId: string; deviceId: string; sessionId: string;
  deviceFingerprint: string; signerThumbprint: string;
  bootstrapOperationSame: boolean;
  recordState: string; restartSubmissions: number; inboxReleaseCount: number;
  releasedInInbox: boolean; withheldInInbox: boolean; pendingStillReviewable: boolean;
}>;

async function recover(env: NodeJS.ProcessEnv): Promise<Recovery> {
  const child = spawn(process.execPath, ['--import', 'tsx', worker, 'recovery'], {
    cwd: process.cwd(), env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], shell: false,
  });
  child.stderr?.resume();
  const result = await new Promise<Recovery>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('recovery_timeout')); }, 90_000);
    let summary: Recovery | null = null;
    child.on('message', value => {
      if (typeof value === 'object' && value !== null && (value as Recovery).kind === 'recovered') summary = value as Recovery;
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && signal === null && summary) resolve(summary);
      else reject(new Error('recovery_child_failed'));
    });
    child.once('error', () => { clearTimeout(timer); reject(new Error('recovery_child_start_failed')); });
  });
  return result;
}

async function servePeer(): Promise<{ server: Server; origin: string }> {
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const target = path.resolve(peerRoot, '.' + (pathname === '/' ? '/index.html' : pathname));
    if (target !== path.join(peerRoot, 'index.html') && !target.startsWith(peerRoot + path.sep)) {
      response.writeHead(404).end();
      return;
    }
    try {
      const bytes = await readFile(target);
      const contentType = target.endsWith('.html') ? 'text/html'
        : target.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
      response.writeHead(200, { 'content-type': contentType }).end(bytes);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return { server, origin: 'http://127.0.0.1:' + address.port };
}
