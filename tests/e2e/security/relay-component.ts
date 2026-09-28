// Disposable component proof only. Direct Matrix SDK clients send and decrypt;
// this never substitutes for the protected hosted owner/browser/native path.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, preview } from '../../../apps/connector/node_modules/vite/dist/node/index.js';
import { startClosureSynapse } from '../../integration/fixtures/closure-synapse';
import type { EvidenceManifest } from '../harness/evidence';
import { type DriverHandle, type ScenarioDriver, createScenarioHarness } from '../harness/scenario';
import { controlsFor } from '../../conformance/subjects';
import { type Canary, findLeaks, mintCanary } from './fixtures';
import { ChunkScanner, PostgresTarInventory, relayProbes, scanProbes, type Probe } from './relay-scan';

const requireConnector = createRequire(fileURLToPath(new URL('../../../apps/connector/package.json', import.meta.url)));
const { chromium } = requireConnector('playwright-core') as typeof import('../../../apps/connector/node_modules/playwright-core');
const peerRoot = fileURLToPath(new URL('./relay-peer/', import.meta.url));

type Peer = Readonly<{
  open(input: { baseUrl: string; userId: string; deviceId: string; accessToken: string; storeName: string }): Promise<void>;
  peerDeviceKnown(userId: string, deviceId: string): Promise<boolean>;
  send(roomId: string, body: string): Promise<string>;
  decrypt(raw: Record<string, unknown>): Promise<{ kind: 'clear'; body: unknown } | { kind: 'missing'; reason: string }>;
  sessionKeys(roomId: string): Promise<string[]>;
  close(): void;
}>;
type Page = Awaited<ReturnType<Awaited<ReturnType<typeof chromium.launchPersistentContext>>['newPage']>>;

function docker(args: string[], code: string, maxBuffer = 64 * 1024 * 1024): Buffer {
  const result = spawnSync('docker', args, { encoding: 'buffer', timeout: 180_000, maxBuffer });
  if (result.error || result.status !== 0 || result.stdout === null) throw new Error(code);
  return Buffer.from(result.stdout);
}

/** Scan the stopped PostgreSQL data volume as a bounded byte stream, including WAL. */
async function scanPhysicalDatabase(container: string, probes: readonly Probe[]): Promise<{ bytes: number; leaks: ReturnType<typeof findLeaks> }> {
  const child = spawn('docker', ['cp', `${container}:/var/lib/postgresql/data`, '-'],
    { stdio: ['ignore', 'pipe', 'pipe'], signal: AbortSignal.timeout(180_000) });
  if (!child.stdout || !child.stderr) { child.kill(); throw new Error('relay_database_snapshot_failed'); }
  // Docker progress and errors may use stderr. Drain it without retaining or
  // printing bytes that could contain local paths or container diagnostics.
  child.stderr.resume();
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once('error', () => reject(new Error('relay_database_snapshot_failed')));
    child.once('close', code => resolve(code));
  });
  const scanner = new ChunkScanner(probes, 'postgres-data-volume');
  const inventory = new PostgresTarInventory();
  try {
    for await (const part of child.stdout) {
      const chunk = Buffer.from(part);
      scanner.write(chunk);
      if (scanner.bytes > 1024 * 1024 * 1024) throw new Error('relay_database_snapshot_too_large');
      inventory.write(chunk);
    }
  } catch (error) {
    child.kill();
    await closed.catch(() => undefined);
    throw error;
  }
  const status = await closed;
  if (status !== 0 || scanner.bytes === 0) throw new Error('relay_database_snapshot_failed');
  inventory.assertComplete();
  return { bytes: scanner.bytes, leaks: scanner.leaks };
}

async function decryptEventually(page: Page, raw: Record<string, unknown>, expected: string, role: 'sender' | 'recipient'): Promise<void> {
  let reason = 'none';
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const result = await page.evaluate(event => (window as unknown as { relayPeer: Peer }).relayPeer.decrypt(event), raw);
    if (result.kind === 'clear') {
      if (result.body !== expected) throw new Error('relay_decrypt_wrong_content');
      return;
    }
    reason = result.reason;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`relay_decrypt_missing_${role}_${reason}`.toLowerCase().replace(/[^a-z0-9_]/gu, '_'));
}

function assertScannerControl(haystack: Buffer, probes: readonly Probe[]): void {
  if (scanProbes(haystack, probes, 'clean-control').length !== 0) throw new Error('relay_scanner_control_contaminated');
  for (const probe of probes) {
    const injected = new ChunkScanner([probe], 'injected-control');
    injected.write(haystack.subarray(0, 16));
    injected.write(probe.needle.subarray(0, 3));
    injected.write(probe.needle.subarray(3));
    if (injected.leaks.length === 0) throw new Error('relay_scanner_positive_control_failed');
  }
}

export async function runRelayComponent(): Promise<EvidenceManifest> {
  const recoveryFile = process.env.KHALA_SECURITY_RELAY_RECOVERY_FILE ?? '';
  const privateRoot = path.join(os.homedir(), '.cache', 'khala-executor');
  const recoveryMatch = /^relay-recovery-([a-f0-9]{12})\.json$/u.exec(path.basename(recoveryFile));
  if (path.dirname(recoveryFile) !== privateRoot || !recoveryMatch) {
    throw new Error('relay_recovery_file_required');
  }
  const scratch = path.join(privateRoot, `s-${recoveryMatch[1]}`);
  try { await mkdir(scratch, { mode: 0o700 }); await chmod(scratch, 0o700); }
  catch { throw new Error('relay_scratch_unavailable'); }
  let synapse: Awaited<ReturnType<typeof startClosureSynapse>> | null = null;
  let server: Awaited<ReturnType<typeof preview>> | null = null;
  const contexts: Array<Awaited<ReturnType<typeof chromium.launchPersistentContext>>> = [];
  let scenario: Awaited<ReturnType<typeof createScenarioHarness>> | null = null;
  let cleanupFailed = false;
  try {
    synapse = await startClosureSynapse({ recoveryFile, limits: {
      synapse: { memoryBytes: 1024 * 1024 * 1024, cpus: 1, pids: 256 },
      postgres: { memoryBytes: 512 * 1024 * 1024, cpus: 0.5, pids: 128 },
    } });
    const canaries = [mintCanary('relay-a'), mintCanary('relay-b')];
    const alice = await synapse.provision(`@khala_relay_alice:${synapse.serverName}`, 'RELAY_ALICE');
    const bob = await synapse.provision(`@khala_relay_bob:${synapse.serverName}`, 'RELAY_BOB');
    const created = await synapse.api('/createRoom', alice.access_token, 'POST', {
      visibility: 'private', invite: [bob.user_id], initial_state: [
        { type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } },
      ],
    });
    if (typeof created.room_id !== 'string') throw new Error('relay_room_missing');
    const roomId = created.room_id;
    await synapse.api(`/join/${encodeURIComponent(roomId)}`, bob.access_token, 'POST', {});

    await build({ root: peerRoot, configFile: false, logLevel: 'error',
      build: { outDir: path.join(scratch, 'peer-bundle'), emptyOutDir: true } });
    server = await preview({ root: peerRoot, configFile: false,
      build: { outDir: path.join(scratch, 'peer-bundle') }, preview: { host: '127.0.0.1', port: 0, strictPort: false } });
    const origin = server.resolvedUrls?.local[0];
    if (!origin) throw new Error('relay_peer_server_missing');
    const pages: Page[] = [];
    for (const [index, login] of [alice, bob].entries()) {
      const context = await chromium.launchPersistentContext(path.join(scratch, `peer-${index}`), {
        executablePath: '/usr/bin/chromium', headless: true,
      });
      contexts.push(context);
      const page = await context.newPage();
      pages.push(page);
      await page.goto(origin);
      await page.waitForFunction(() => !!(window as unknown as { relayPeer?: Peer }).relayPeer);
      await page.evaluate(input => (window as unknown as { relayPeer: Peer }).relayPeer.open(input), {
        baseUrl: synapse.baseUrl, userId: login.user_id, deviceId: login.device_id,
        accessToken: login.access_token, storeName: `relay-${index}`,
      });
    }

    // Each SDK device uploads its identity on first sync. Alice may have
    // synced before Bob's keys existed; require the real device list to be
    // discoverable at both endpoints before their first outbound session.
    for (const [index, login] of [bob, alice].entries()) {
      let known = false;
      for (let attempt = 0; attempt < 40 && !known; attempt += 1) {
        known = await pages[index]!.evaluate(input =>
          (window as unknown as { relayPeer: Peer }).relayPeer.peerDeviceKnown(input.userId, input.deviceId),
        { userId: login.user_id, deviceId: login.device_id });
        if (!known) await new Promise(resolve => setTimeout(resolve, 250));
      }
      if (!known) throw new Error('relay_peer_device_unavailable');
    }

    const eventIds: string[] = [];
    for (const [index, sender] of pages.entries()) {
      const eventId = await sender.evaluate(input =>
        (window as unknown as { relayPeer: Peer }).relayPeer.send(input.roomId, input.body),
      { roomId, body: canaries[index]!.text });
      const raw = await synapse.api(`/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(eventId)}`,
        index === 0 ? alice.access_token : bob.access_token, 'GET');
      if (raw.type !== 'm.room.encrypted' || findLeaks(JSON.stringify(raw), [canaries[index]!], 'raw-event').length) {
        throw new Error('relay_plaintext_event');
      }
      await decryptEventually(pages[1 - index]!, raw, canaries[index]!.text, 'recipient');
      await decryptEventually(sender, raw, canaries[index]!.text, 'sender');
      eventIds.push(eventId);
    }

    const exported = (await Promise.all(pages.map(page => page.evaluate(target =>
      (window as unknown as { relayPeer: Peer }).relayPeer.sessionKeys(target), roomId)))).flat();
    const uniqueKeys = [...new Set(exported)];
    if (uniqueKeys.length === 0 || uniqueKeys.some(key => key.length < 32)) throw new Error('relay_session_keys_not_exported');
    const secrets: Canary[] = [...canaries, ...uniqueKeys.map((key, index) => ({
      label: `session-key-${index}`, text: key, core: key,
    }))];
    const probes = relayProbes(secrets, uniqueKeys);
    const owned = synapse.containers;
    const dump = docker(['exec', owned.postgres, 'pg_dump', '--data-only', '--no-owner', '--no-privileges',
      '-U', 'synapse', 'synapse'], 'relay_database_dump_failed');
    if (!eventIds.every(id => dump.includes(Buffer.from(id)))) throw new Error('relay_events_absent_from_database_dump');
    // The logical dump proves the event rows were present while the relay was
    // live. Stop both owned containers before taking a consistent physical copy;
    // copying a live PostgreSQL directory can race a WAL/checkpoint write.
    docker(['stop', owned.synapse, owned.postgres], 'relay_owned_containers_stop_failed');
    const physical = await scanPhysicalDatabase(owned.postgres, probes);
    const logBytes = [owned.synapse, owned.postgres].map(container => {
      const result = spawnSync('docker', ['logs', container], { encoding: 'buffer', timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
      if (result.error || result.status !== 0 || result.stdout === null || result.stderr === null) {
        throw new Error('relay_log_read_failed');
      }
      return Buffer.concat([Buffer.from(result.stdout), Buffer.from(result.stderr)]);
    });
    const observations = [
      ...scanProbes(dump, probes, 'postgres-logical-dump'), ...physical.leaks,
      ...logBytes.flatMap((bytes, index) => scanProbes(bytes, probes, index === 0 ? 'synapse-log' : 'postgres-log')),
    ];
    if (observations.length) {
      const first = observations[0]!;
      // Labels and surface names are fixed in this test; never include a byte
      // of the canary, exported key, database or log in the failure message.
      throw new Error(`relay_secret_leak_${first.canary}_${first.where}`.replace(/[^a-z0-9_]/gu, '_'));
    }
    for (const haystack of [dump, ...logBytes]) assertScannerControl(haystack, probes);

    let handle: DriverHandle | null = null;
    const driver: ScenarioDriver = { name: 'synapse-sdk', mode: 'live-sdk',
      source: { component: 'synapse', version: synapse.version }, faults: [],
      attach(issued) { handle = issued; }, async close() {} };
    scenario = await createScenarioHarness({ runId: `relay-${randomBytes(6).toString('hex')}`,
      mode: 'live-sdk', owners: [{ seed: 'relay', controls: controlsFor('relay') }],
      sources: [{ component: 'postgres', version: '16' }, { component: 'matrix-js-sdk', version: '42.4.0' }],
      drivers: [driver], stateRoot: scratch });
    const subject = { ownerId: 'owner-relay', operationId: `event-${randomBytes(6).toString('hex')}` };
    handle!.record('relay.encrypted', subject);
    handle!.record('relay.both_decrypted', subject);
    handle!.record('relay.database_scanned', subject);
    handle!.record('relay.logs_scanned', subject);
    handle!.record('relay.scanner_positive', subject);
    return scenario.manifest();
  } catch (error) {
    const message = error instanceof Error && /^relay_[a-z0-9_]+$/u.test(error.message)
      ? error.message : 'relay_component_unexpected';
    throw new Error(message);
  } finally {
    if (scenario) {
      try { const report = await scenario.close(); if (report.leftovers.length) cleanupFailed = true; }
      catch { cleanupFailed = true; }
    }
    for (const context of contexts.reverse()) {
      try { await context.close(); } catch { cleanupFailed = true; }
    }
    if (server) { try { await server.close(); } catch { cleanupFailed = true; } }
    if (synapse) { try { synapse.close(); } catch { cleanupFailed = true; } }
    try { await rm(scratch, { recursive: true, force: true }); } catch { cleanupFailed = true; }
    if (cleanupFailed) throw new Error('relay_teardown_failed');
  }
}
