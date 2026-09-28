// Disposable native Codex conformance fixture. The hook, explicit read, setup
// adapter, transaction executor, and file inbox are production code; only the
// owner binding/mode and local control connection are injected. Only the bounded,
// content-free `codex queue` child is launched here; the TUI is external. Raw
// Codex rollout and model context stay in a private home.
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, readlink, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeDeviceId, decodeEventId, decodeParticipantId, decodeRoomId,
  decodeSessionBinding, type Decoded, type SessionBinding } from '../../../packages/contracts/src/delivery/index';
import { codexIdleWakeArgv, createCodexQueueProcessPort, scrubbedQueueEnv } from '../../../packages/harnesses/src/codex/index';
import { runCli } from '../../../packages/agent-cli/src/cli/app';
import { openInbox, type BatchInbox } from '../../../packages/agent-cli/src/cli/inbox';
import type { AgentClientPort } from '../../../packages/agent-cli/src/cli/types';
import { createCodexSetupAdapter, codexPaths } from '../../../packages/agent-cli/src/setup/adapters/codex';
import { setupEnvironment } from '../../../packages/agent-cli/src/setup/environment';
import { sha256 } from '../../../packages/agent-cli/src/setup/filesystem';
import { executeSetupPlan, type ExecutablePlan } from '../../../packages/agent-cli/src/setup/transaction';
import { isolatedNativeModelCall, pinnedNativeAncestor,
  type NativeOriginScope, type NativeProcessSnapshot } from './native-sol-origin';
import { inspectNativeSolRollout } from './native-sol-rollout';

const root = (() => {
  const value = process.env.KHALA_42_SYNC_ROOT;
  if (!value || !path.isAbsolute(value) || path.normalize(value) !== value) {
    throw new Error('private_fixture_root_required');
  }
  return value;
})();
const state = path.join(root, 'state');
const bindingPath = path.join(state, 'binding.json');
const inboxPath = path.join(state, 'inbox');
const markersPath = path.join(state, 'markers.json');
const scopePath = path.join(state, 'scope.json');
const crashDescriptorPath = path.join(state, 'crash-descriptor.json');
const callsPath = path.join(state, 'calls.jsonl');
const originDiagnosticsPath = path.join(state, 'origin-diagnostics.jsonl');
const inboxDiagnosticsPath = path.join(state, 'inbox-diagnostics.jsonl');
const command = process.argv[2];
const args = process.argv.slice(3);
const utf8 = new TextEncoder();
const digest = (bytes: Uint8Array) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const decodedValue = <T>(decoded: Decoded<T>): T => {
  if (!decoded.ok) throw new Error('fixture_identifier_invalid');
  return decoded.value;
};
const inbox = (binding: SessionBinding) => openInbox({
  stateDirectory: inboxPath, bindingId: binding.bindingId, generation: binding.generation,
  maxPayloadBytes: 64 * 1024, maxSelectionEvents: 8,
});

async function recordInboxFailure(stage: string, error: unknown): Promise<void> {
  const failure = error as { name?: string; code?: string; stack?: string };
  const location = /(?:inbox|call-consumer|read)\.ts:(\d+)/u.exec(failure.stack ?? '');
  await appendFile(inboxDiagnosticsPath, JSON.stringify({ stage, name: failure.name ?? null,
    code: failure.code ?? null, sourceLine: location?.[1] ?? null }) + '\n', { mode: 0o600 })
    .catch(() => undefined);
}

async function tracedInbox(binding: SessionBinding): Promise<BatchInbox> {
  const base = await inbox(binding).catch(async error => {
    await recordInboxFailure('open', error);
    throw error;
  });
  return {
    enqueue: input => base.enqueue(input),
    readNext: () => base.readNext(),
    acknowledge: item => base.acknowledge(item),
    status: () => base.status(),
    notifyListener: reason => base.notifyListener(reason),
    async acquireCallConsumer() {
      if (!base.acquireCallConsumer) throw new Error('socketless_consumer_unavailable');
      const consumer = await base.acquireCallConsumer().catch(async error => {
        await recordInboxFailure('acquire_call', error);
        throw error;
      });
      return {
        release: () => consumer.release(),
        async readBatch(input) {
          return consumer.readBatch(input).catch(async error => {
            await recordInboxFailure('read_batch', error);
            throw error;
          });
        },
      };
    },
    async acquireListener() {
      const consumer = await base.acquireListener().catch(async error => {
        await recordInboxFailure('acquire', error);
        throw error;
      });
      return {
        nextWake: () => consumer.nextWake(),
        release: () => consumer.release(),
        async readBatch(input) {
          return consumer.readBatch(input).catch(async error => {
            await recordInboxFailure('read_batch', error);
            throw error;
          });
        },
      };
    },
  };
}

async function currentBatchAckDigest(binding: SessionBinding): Promise<string | null> {
  const directory = createHash('sha256').update(JSON.stringify([binding.bindingId, binding.generation]))
    .digest('base64url');
  const filename = path.join(inboxPath, 'bindings', directory, 'batch.json');
  let value: { v?: unknown; bindingId?: unknown; generation?: unknown;
    releaseId?: unknown; token?: unknown };
  try { value = JSON.parse(await readFile(filename, 'utf8')); } catch { return null; }
  if (value.v !== 1 || value.bindingId !== binding.bindingId || value.generation !== binding.generation
    || value.releaseId !== 'release-native-sol-1' || typeof value.token !== 'string'
    || !/^[A-Za-z0-9_-]{8,512}$/u.test(value.token)) return null;
  return createHash('sha256').update(value.token).digest('hex');
}

async function heldBinding(): Promise<SessionBinding | null> {
  let value: unknown;
  try { value = JSON.parse(await readFile(bindingPath, 'utf8')); } catch { return null; }
  const decoded = decodeSessionBinding(value);
  return decoded.ok ? decoded.value : null;
}

async function processSnapshot(pid: number): Promise<NativeProcessSnapshot | null> {
  try {
    const [executable, status, statText, cgroupText, environ] = await Promise.all([
      readlink(`/proc/${pid}/exe`), readFile(`/proc/${pid}/status`, 'utf8'),
      readFile(`/proc/${pid}/stat`, 'utf8'), readFile(`/proc/${pid}/cgroup`, 'utf8'),
      readFile(`/proc/${pid}/environ`),
    ]);
    const parentPid = Number(/^PPid:\s+(\d+)/mu.exec(status)?.[1] ?? 0);
    const statFields = statText.slice(statText.lastIndexOf(')') + 1).trim().split(/\s+/u);
    const startTime = statFields[19]; // /proc stat field 22, after pid and (comm).
    const cgroup = /^0::(.+)$/mu.exec(cgroupText)?.[1];
    if (!Number.isSafeInteger(parentPid) || !startTime || !cgroup) return null;
    return { pid, parentPid, startTime, executable, cgroup,
      environment: environ.toString('utf8').split('\0') };
  } catch { return null; }
}

type NativeReadOrigin = Readonly<{ kind: 'daemon_descendant' | 'isolated_model_call'; pid: number }>;

async function nativeOrigin(
  scope: NativeOriginScope, sessionId: string, ackDigest: string,
  modelAckDigests: ReadonlySet<string>, batchAckDigest: string,
): Promise<NativeReadOrigin | null> {
  const chain: NativeProcessSnapshot[] = [];
  let pid = process.pid;
  for (let depth = 0; depth < 16 && pid > 1; depth += 1) {
    const snapshot = await processSnapshot(pid);
    if (snapshot === null) {
      await recordOriginRefusal(scope, chain, 'unreadable_process', pid);
      return null;
    }
    chain.push(snapshot);
    if (scope.daemons.some(item => item.pid === pid)) break;
    pid = snapshot.parentPid;
  }
  const pinned = pinnedNativeAncestor(chain, scope, sessionId);
  if (ackDigest === batchAckDigest && modelAckDigests.has(ackDigest)) {
    if (pinned !== null) return { kind: 'daemon_descendant', pid: pinned };
    if (isolatedNativeModelCall(chain, scope, sessionId, ackDigest, modelAckDigests, batchAckDigest)) {
      return { kind: 'isolated_model_call', pid: chain[0]!.pid };
    }
  }
  await recordOriginRefusal(scope, chain, 'unmatched_origin', pid);
  return null;
}

async function recordOriginRefusal(
  scope: NativeOriginScope, chain: readonly NativeProcessSnapshot[], reason: string, lastPid: number,
): Promise<void> {
  await appendFile(originDiagnosticsPath, JSON.stringify({ reason, lastPid,
    sessionMatched: scope.sessionId === (await heldBinding())?.sessionId,
    chain: chain.map(item => ({ pid: item.pid, parentPid: item.parentPid, startTime: item.startTime,
      executable: path.basename(item.executable), cgroupMatched: item.cgroup === scope.cgroup,
      privateHome: item.environment.includes(`CODEX_HOME=${scope.codexHome}`),
      privateRoot: item.environment.includes(`KHALA_42_SYNC_ROOT=${scope.fixtureRoot}`),
      pinnedPid: scope.daemons.some(daemon => daemon.pid === item.pid) })) }) + '\n', { mode: 0o600 });
}

async function setup(): Promise<void> {
  if (args.length !== 0) throw new Error('setup_args_invalid');
  const env = setupEnvironment(process.env);
  const privatePath = (target: string) => target === root || target.startsWith(root + path.sep);
  if (env.codexHome !== path.join(root, 'codex-home')
    || ![env.xdgConfigHome, env.xdgDataHome, env.xdgStateHome].every(privatePath)) {
    throw new Error('private_setup_roots_required');
  }
  const paths = codexPaths(env);
  const here = fileURLToPath(import.meta.url);
  const repository = path.resolve(path.dirname(here), '../../..');
  const workdir = process.env.KHALA_42_SYNC_WORKDIR;
  if (!workdir || !path.isAbsolute(workdir) || !workdir.startsWith(root + path.sep)) {
    throw new Error('private_workdir_required');
  }
  const launcher = `#!/bin/sh\ncd '${repository}' || exit 1\n`
    + `KHALA_42_SYNC_ROOT='${root}' KHALA_42_SYNC_WORKDIR='${workdir}' `
    + `exec '${process.execPath}' --import tsx '${here}' "$@"\n`;
  await mkdir(path.dirname(paths.launcher), { recursive: true, mode: 0o700 });
  await writeFile(paths.launcher, launcher, { mode: 0o700, flag: 'wx' });
  await mkdir(workdir, { recursive: true, mode: 0o700 });
  await writeFile(path.join(workdir, 'AGENTS.md'),
    'This is a disposable Khala native sync proof. Answer the initial standby prompt with READY and end that turn. '
    + 'On a later queue notice or user turn, when a Khala hook presents a batchToken, run the installed Khala launcher '
    + `\`${paths.launcher} read --ack <batchToken>\` using a shell tool, substituting the exact token. `
    + 'Relay only the synthetic released body from that batch. Do not inspect fixture state files.\n',
    { mode: 0o600, flag: 'wx' });
  const skill = new Uint8Array(await readFile(path.join(repository, 'packages/agent-skill/SKILL.md')));
  const adapter = createCodexSetupAdapter({ skill });
  const plan = async (): Promise<ExecutablePlan> => {
    const detection = await adapter.detect(env);
    if (detection.version !== '0.157.1' || !detection.supported) throw new Error('native_version_unproven');
    const observation = await adapter.inspect(env, detection);
    const planned = adapter.executablePlan({ desired: 'present', observation });
    const operations = planned.operations;
    return {
      command: 'setup', planDigest: sha256(utf8.encode(JSON.stringify({ command: 'setup', operations }))),
      operations, contents: planned.contents, entryOwnedPaths: planned.entryOwnedPaths,
    };
  };
  const approved = await plan();
  if (!approved.operations.every(operation => privatePath(operation.path)
    && (operation.type !== 'vendor_command' || operation.writablePaths.every(privatePath)))) {
    throw new Error('setup_target_outside_private_root');
  }
  const result = await executeSetupPlan({
    roots: { home: env.home, xdgConfigHome: env.xdgConfigHome, xdgDataHome: env.xdgDataHome,
      xdgStateHome: env.xdgStateHome, codexHome: env.codexHome },
    searchPath: process.env.PATH ?? '', confirmedDigest: approved.planDigest, replan: plan,
  });
  if (result.kind !== 'committed') throw new Error(`setup_${result.kind}`);
  process.stdout.write(JSON.stringify({ setup: result.kind, version: '0.157.1',
    components: ['skill', 'hooks', 'mcp_entry'], trust: 'awaiting_native_review' }) + '\n');
}

async function bind(): Promise<void> {
  if (args.length !== 0) throw new Error('bind_args_invalid');
  const workdir = process.env.KHALA_42_SYNC_WORKDIR;
  const codexHome = process.env.CODEX_HOME;
  if (!workdir || !path.isAbsolute(workdir) || !codexHome || codexHome !== path.join(root, 'codex-home')) {
    throw new Error('private_native_scope_invalid');
  }
  const sessionFiles: string[] = [];
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > 5) return;
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const item = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(item, depth + 1);
      else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
        sessionFiles.push(item);
      }
    }
  };
  await walk(path.join(codexHome, 'sessions'), 0);
  const candidates: Array<{ sessionId: string; sessionFile: string }> = [];
  for (const sessionFile of sessionFiles) {
    if ((await stat(sessionFile)).size > 4 * 1024 * 1024) continue;
    let sessionId: string | null = null;
    let solTurn = false;
    for (const line of (await readFile(sessionFile, 'utf8')).split('\n')) {
      if (!line) continue;
      let record: { type?: string; payload?: Record<string, unknown> };
      try { record = JSON.parse(line); } catch { continue; }
      const p = record.payload;
      if (record.type === 'session_meta' && typeof p?.id === 'string'
        && /^[0-9a-f]{8}-[0-9a-f-]{27,}$/iu.test(p.id) && p.cwd === workdir
        && p.cli_version === '0.157.1') sessionId = p.id;
      if (record.type === 'turn_context' && p?.model === 'gpt-6-sol' && p.cwd === workdir) solTurn = true;
    }
    if (sessionId && solTurn) candidates.push({ sessionId, sessionFile });
  }
  if (candidates.length !== 1) throw new Error('unique_native_sol_session_unproven');
  const { sessionId, sessionFile } = candidates[0]!;
  const processIds: number[] = [];
  const snapshots: NativeProcessSnapshot[] = [];
  for (const name of await readdir('/proc')) {
    if (!/^[0-9]+$/u.test(name)) continue;
    const pid = Number(name);
    try {
      const snapshot = await processSnapshot(pid);
      if (!snapshot || !snapshot.executable.endsWith('/codex')
        || !snapshot.environment.includes(`CODEX_HOME=${codexHome}`)
        || !snapshot.environment.includes(`KHALA_42_SYNC_ROOT=${root}`)) continue;
      snapshots.push(snapshot);
      if (await readlink(`/proc/${pid}/cwd`) !== workdir) continue;
      const argv = (await readFile(`/proc/${pid}/cmdline`)).toString('utf8').split('\0');
      if (!argv.includes('gpt-6-sol')) continue;
      processIds.push(pid);
    } catch { /* Other users' processes and exiting processes are unrelated. */ }
  }
  if (processIds.length !== 1) throw new Error('native_running_process_unproven');
  const tui = snapshots.find(item => item.pid === processIds[0]);
  if (!tui) throw new Error('native_tui_snapshot_missing');
  const daemonPrefix = path.join(codexHome, 'packages', 'app-server-daemon') + path.sep;
  const daemons = snapshots.filter(item => item.cgroup === tui.cgroup
    && item.executable.startsWith(daemonPrefix)).map(({ pid, startTime, executable, cgroup }) =>
    ({ pid, startTime, executable, cgroup }));
  if (daemons.length === 0) throw new Error('native_app_server_unproven');
  const binding = {
    v: 1, bindingId: 'binding-42-sol-native', ownerId: 'owner-42-sol-native',
    agentParticipantId: 'agent-42-sol-native', deviceId: 'device-42-sol-native',
    harness: 'codex', sessionId, generation: 0,
  };
  const decoded = decodeSessionBinding(binding);
  if (!decoded.ok) throw new Error('binding_invalid');
  await mkdir(state, { recursive: true, mode: 0o700 });
  await writeFile(bindingPath, JSON.stringify(binding) + '\n', { mode: 0o600, flag: 'wx' });
  await writeFile(scopePath, JSON.stringify({ nativePid: processIds[0], nativeStartTime: tui.startTime,
    nativeExecutable: tui.executable, sessionFile,
    sessionId, cgroup: tui.cgroup, codexHome, fixtureRoot: root, daemons }) + '\n',
    { mode: 0o600, flag: 'wx' });
  // The crash runner gets a separate fresh ledger binding; this descriptor
  // attests only the still-running, normally trusted native preflight session.
  await writeFile(crashDescriptorPath, JSON.stringify({ v: 2, disposable: true, harness: 'codex',
    sessionId, workdir, codexHome, preflightRoot: root, nativePid: processIds[0],
    nativeStartTime: tui.startTime, preflightBindingId: binding.bindingId,
    preflightGeneration: binding.generation }) + '\n', { mode: 0o600, flag: 'wx' });
  process.stdout.write(JSON.stringify({ bound: true, nativePid: processIds[0], version: '0.157.1',
    model: 'gpt-6-sol', workdirMatched: true, pinnedDaemons: daemons.length,
    crashDescriptor: crashDescriptorPath }) + '\n');
}

async function enqueue(): Promise<void> {
  if (args.length !== 0) throw new Error('enqueue_args_invalid');
  const binding = await heldBinding();
  if (!binding) throw new Error('binding_missing');
  const releasedMarker = randomUUID();
  const unsubmittedMarker = randomUUID();
  const payload = utf8.encode(JSON.stringify({ body: `synthetic released ${releasedMarker}` }));
  const source = utf8.encode(`synthetic encrypted source ${releasedMarker}`);
  const result = await (await inbox(binding)).enqueue({
    v: 1, releaseId: 'release-native-sol-1', bindingId: binding.bindingId, generation: binding.generation,
    events: [{ v: 1, roomId: decodedValue(decodeRoomId('room-42')),
      eventId: decodedValue(decodeEventId('event-native-sol-1')),
      authorParticipantId: decodedValue(decodeParticipantId('peer-42')),
      authorDeviceId: decodedValue(decodeDeviceId('peer-device-42')), contentDigest: digest(source) }],
    payloadDigest: digest(payload), payload, receivedAt: new Date().toISOString(),
  });
  await writeFile(markersPath, JSON.stringify({ releasedMarker, unsubmittedMarker }) + '\n',
    { mode: 0o600, flag: 'wx' });
  process.stdout.write(JSON.stringify({ enqueue: result, releaseId: 'release-native-sol-1',
    unsubmittedNotEnqueued: true }) + '\n');
}

async function status(): Promise<void> {
  const binding = await heldBinding();
  if (!binding) throw new Error('binding_missing');
  const cursor = (await (await inbox(binding)).status()).cursor;
  process.stdout.write(JSON.stringify({ bindingId: binding.bindingId, generation: binding.generation,
    cursorReleaseId: cursor.releaseId }) + '\n');
}

async function queue(): Promise<void> {
  if (args.length !== 0) throw new Error('queue_args_invalid');
  const binding = await heldBinding();
  if (!binding) throw new Error('binding_missing');
  const commandPath = process.env.KHALA_42_CODEX_BIN;
  if (!commandPath || !path.isAbsolute(commandPath)) throw new Error('codex_binary_required');
  const markers = JSON.parse(await readFile(markersPath, 'utf8')) as {
    releasedMarker: string; unsubmittedMarker: string;
  };
  const argv = codexIdleWakeArgv(binding.sessionId);
  const environment = scrubbedQueueEnv(process.env);
  const selection = JSON.stringify({ argv, environment });
  if (selection.includes(markers.releasedMarker) || selection.includes(markers.unsubmittedMarker)) {
    throw new Error('payload_leak_into_native_queue');
  }
  const outcome = await createCodexQueueProcessPort({ command: commandPath, env: process.env,
    timeoutMs: 10_000 }).run(argv, new AbortController().signal);
  process.stdout.write(JSON.stringify({ queue: outcome.status, constantNoticeOnly: true,
    scrubbedEnvironment: true }) + '\n');
  if (outcome.status !== 'queued') process.exitCode = 1;
}

async function verify(): Promise<void> {
  if (args.length !== 0) throw new Error('verify_args_invalid');
  const binding = await heldBinding();
  if (!binding) throw new Error('binding_missing');
  const scope = JSON.parse(await readFile(scopePath, 'utf8')) as NativeOriginScope & { sessionFile: string };
  const markers = JSON.parse(await readFile(markersPath, 'utf8')) as {
    releasedMarker: string; unsubmittedMarker: string;
  };
  const rollout = await readFile(scope.sessionFile, 'utf8');
  const records: Array<{ type?: unknown; payload?: unknown }> = [];
  for (const line of rollout.split('\n')) {
    if (!line) continue;
    try { records.push(JSON.parse(line)); } catch { continue; }
  }
  const proof = inspectNativeSolRollout(records, markers.releasedMarker, markers.unsubmittedMarker,
    path.join(root, 'data', 'khala', 'bin', 'khala'));
  const calls = (await readFile(callsPath, 'utf8').catch(() => '')).split('\n').filter(Boolean)
    .map(line => JSON.parse(line) as { kind: string; origin: NativeReadOrigin | null; ackDigest: string | null;
      exitCode: number; cursorReleaseId: string | null });
  const nativeAck = calls.some(call => call.kind === 'read' && call.origin !== null
    && (call.origin.kind === 'isolated_model_call'
      || (call.origin.kind === 'daemon_descendant'
        && scope.daemons.some(daemon => daemon.pid === call.origin?.pid)))
    && call.ackDigest !== null && proof.modelAckDigests.has(call.ackDigest)
    && call.exitCode === 0 && call.cursorReleaseId === 'release-native-sol-1');
  const cursor = (await (await inbox(binding)).status()).cursor;
  const passed = proof.visibleRelease && proof.agentRelay && nativeAck
    && cursor.releaseId === 'release-native-sol-1' && proof.unsubmittedAbsent;
  process.stdout.write(JSON.stringify({ passed, visibleRelease: proof.visibleRelease,
    agentRelay: proof.agentRelay, nativeAck,
    cursorAdvanced: cursor.releaseId === 'release-native-sol-1', unsubmittedAbsent: proof.unsubmittedAbsent }) + '\n');
  if (!passed) process.exitCode = 1;
}

function client(binding: SessionBinding): AgentClientPort {
  return {
    async connect() { return { kind: 'unavailable' }; },
    async send(input) { return { kind: 'refused', code: 'transport_unavailable', clientTxnId: input.clientTxnId }; },
    async status() { return { v: 1, connected: true, binding, route: 'native_hooks', sourceCursor: null }; },
    async listChannels() { return { kind: 'unavailable' }; },
    async listAgents() { return { kind: 'unavailable' }; },
    async listeningMode() { return { v: 1, bindingId: binding.bindingId,
      generation: binding.generation, effective: 'sync' }; },
  };
}

async function serve(): Promise<void> {
  const binding = await heldBinding();
  if (!binding) return; // An unrelated/unbound Codex session never receives a channel offer.
  let origin: NativeReadOrigin | null = null;
  let ackDigest: string | null = null;
  if (command === 'read') {
    const scope = JSON.parse(await readFile(scopePath, 'utf8')) as NativeOriginScope & { sessionFile: string };
    const ackPosition = args.indexOf('--ack');
    const ack = ackPosition >= 0 ? args[ackPosition + 1] : undefined;
    ackDigest = ack ? createHash('sha256').update(ack).digest('hex') : null;
    const batchDigest = await currentBatchAckDigest(binding);
    const markers = JSON.parse(await readFile(markersPath, 'utf8')) as {
      releasedMarker: string; unsubmittedMarker: string;
    };
    const records = (await readFile(scope.sessionFile, 'utf8')).split('\n').filter(Boolean)
      .map(line => JSON.parse(line) as { type?: unknown; payload?: unknown });
    const proof = inspectNativeSolRollout(records, markers.releasedMarker, markers.unsubmittedMarker,
      path.join(root, 'data', 'khala', 'bin', 'khala'));
    if (!proof.visibleRelease || !proof.unsubmittedAbsent || ackDigest === null || batchDigest === null) {
      throw new Error('native_model_call_or_batch_unproven');
    }
    origin = await nativeOrigin(scope, binding.sessionId, ackDigest, proof.modelAckDigests, batchDigest);
    if (origin === null) throw new Error('foreign_read_refused');
  }
  const code = await runCli([command!, ...args], {
    client: client(binding), inbox: async () => tracedInbox(binding),
    stdin: process.stdin, stdout: process.stdout, stderr: process.stderr,
  });
  if (command === 'read') {
    const cursor = (await (await inbox(binding)).status()).cursor;
    await appendFile(callsPath, JSON.stringify({ kind: 'read', origin,
      ackDigest,
      exitCode: code, cursorReleaseId: cursor.releaseId }) + '\n',
    { mode: 0o600 });
  }
  process.exitCode = code;
}

switch (command) {
  case 'setup': await setup(); break;
  case 'bind': await bind(); break;
  case 'enqueue': await enqueue(); break;
  case 'status': await status(); break;
  case 'queue': await queue(); break;
  case 'verify': await verify(); break;
  case 'codex-hook':
  case 'read':
  case 'mcp-serve': await serve(); break;
  default: throw new Error('fixture_command_invalid');
}
