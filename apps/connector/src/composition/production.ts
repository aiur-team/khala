import { createHash, randomUUID } from 'node:crypto';
import { access, lstat, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import {
  createDiscovery, createHttpAdmission, createLoopbackOwnership, createPairingOwnership,
  type BootstrapPorts, type SessionClaim, type SessionInspectionPort,
} from '@khala/connector/bootstrap/index';
import type { MatrixDeviceSession } from '@khala/connector/bootstrap/ports';
import { decodeDeliveryLimits, decodeSessionBinding, sameSessionBinding, type SessionBinding } from '@khala/contracts/delivery/index';
import { createBootstrapPersistence } from '@khala/connector/storage/bootstrap';
import { openConnectorStorage } from '@khala/connector/storage/open';
import type { ProofSigner } from '@khala/connector/bootstrap/proof';
import { createMatrixBootstrapDevice } from '../substrate/bootstrap-device';
import { startProductionSubscription } from './agent/subscription';
import type { SubscriptionHandle, SubscriptionState } from '@khala/connector/subscription/index';
import { createCapabilityRenewal } from './agent/capability-renewal';
import { createProductionOwnerMailbox } from './agent/owner-mailbox';
import { createLocalClosureFence } from './closure/local-fence';
import { createConnectorDispatchStorage } from '@khala/connector/storage/dispatch';
import { createPolicyControlHandler } from './controls/control-handler';
import { openTrustStateStore } from './controls/trust-store';
import { createOwnerDeviceTrust } from './agent/owner-device-trust';
import { createHostedCodexHarness, type LocalInbox } from './agent/hosted-codex';
import { createDispatcher } from '@khala/connector/dispatch/run';
import type { Dispatcher } from '@khala/connector/dispatch/types';
import { sha256Digest } from '@khala/connector/storage/payloads';
import { createReviewControlHandler, type ReviewControlHandler } from './review/control-handler';
import { createAcknowledgementRecorder } from '@khala/connector/storage/acknowledgements';
import type { HarnessPort } from '@khala/contracts/delivery/index';
import { initialTrustState } from '@khala/policy/trust/index';
import { createHostedListeningControl } from './agent/hosted-listening';
import type { AgentListeningModeSetInput } from '@khala/connector/agent/listening-mode';

function productionLimits() {
  const limits = decodeDeliveryLimits({ maxSelectionEvents: 20, maxPayloadBytes: 64 * 1024 });
  if (!limits.ok) throw new Error('invalid_production_limits');
  return limits.value;
}

const execFileAsync = promisify(execFile);
function productionSessionDirectory(root: string, session: SessionClaim): string {
  return path.join(root, createHash('sha256').update(JSON.stringify([
    'khala.hosted.session.v1', session.harness, session.sessionId, session.workdir,
  ])).digest('hex'));
}

/** A native call may resume an admitted hosted binding without creating state for an unpaired session. */
export async function hasProductionBinding(root: string, session: SessionClaim): Promise<boolean> {
  try { return (await lstat(path.join(productionSessionDirectory(root, session), 'current-binding.json'))).isFile(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

export function supportedBrowserVersion(output: string): boolean {
  const match = /^(?:Chromium|Google Chrome(?: for Testing)?) (\d+)\./u.exec(output.trim());
  return match !== null && Number(match[1]) >= 150 && Number(match[1]) <= 153;
}

export function subscriptionDiagnostic(state: SubscriptionState) {
  if (state.kind === 'live') return null;
  if (state.kind === 'offline') return { prerequisite: 'offline' as const, errorCode: 'subscription_offline' as const };
  if (state.kind === 'blocked') return { prerequisite: state.code === 'unsupported' ? 'unsupported' as const : 'blocked' as const,
    errorCode: `subscription_${state.code}` as const };
  return { prerequisite: 'unknown' as const, errorCode: 'subscription_starting' as const };
}

/**
 * One installed native session owns one endpoint state lease. The connector is
 * opened lazily by a provider-named MCP invocation, not by a shell environment
 * variable or an agent-supplied owner identity.
 */
export async function openProductionConnector<TInbox>(input: Readonly<{
  stateDirectory: string;
  appOrigin: string;
  browserBundleDirectory: string;
  /** Versioned setup-owned browser path, when no supported system Chromium exists. */
  chromiumExecutablePath?: string;
  session: SessionClaim;
  sessionInspection: (generationFor: (claim: SessionClaim) => Promise<number | null>) => SessionInspectionPort;
  inspectHostedCodexHooks(): Promise<unknown>;
  resolveCodexExecutable(): Promise<string | null>;
  openBrowser(url: string): Promise<void>;
  openInbox: TInbox;
}>) {
  const origin = new URL(input.appOrigin);
  if (origin.protocol !== 'https:' || origin.origin !== input.appOrigin || origin.username || origin.password) {
    throw new Error('production_origin_invalid');
  }
  if (!path.isAbsolute(input.stateDirectory) || !path.isAbsolute(input.browserBundleDirectory)) {
    throw new Error('production_path_invalid');
  }
  if (input.chromiumExecutablePath && !path.isAbsolute(input.chromiumExecutablePath)) {
    throw new Error('production_path_invalid');
  }
  const systemBrowsers = process.platform === 'linux'
    ? ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable']
    : process.platform === 'darwin'
      ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
      : [];
  let chromiumExecutablePath: string | null = null;
  for (const candidate of [...systemBrowsers, ...(input.chromiumExecutablePath ? [input.chromiumExecutablePath] : [])]) {
    try {
      await access(candidate, constants.X_OK);
      if (!(await stat(candidate)).isFile()) continue;
      const version = await execFileAsync(candidate, ['--version'], { timeout: 3_000, maxBuffer: 1024 });
      if (supportedBrowserVersion(version.stdout)) { chromiumExecutablePath = candidate; break; }
    } catch { /* Try the next installed executable. */ }
  }
  if (!chromiumExecutablePath) throw new Error('chromium_unavailable_run_khala_setup');
  const sessionDirectory = productionSessionDirectory(input.stateDirectory, input.session);
  const stateDirectory = path.join(sessionDirectory, 'state');
  const markerFile = path.join(sessionDirectory, 'current-binding.json');
  await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
  let mode: 'create' | 'existing';
  try { mode = (await stat(stateDirectory)).isDirectory() ? 'existing' : 'create'; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    mode = 'create';
  }
  const storage = await openConnectorStorage({ directory: stateDirectory, mode, limits: productionLimits() });
  const trust = await openTrustStateStore({ directory: stateDirectory, mode }).catch(async error => {
    await storage.close();
    throw error;
  });
  const dispatchStorage = createConnectorDispatchStorage(storage);
  const acknowledgementRecorder = createAcknowledgementRecorder(storage);
  type Acknowledgement = Readonly<{ bindingId: string; generation: number; releaseIds: readonly string[] }>;
  type OpenInbox = (bindingId: string, generation: number, options?: Readonly<{
    recordAcknowledgement?: (acknowledgement: Acknowledgement) => Promise<void>;
  }>) => Promise<LocalInbox>;
  const rawOpenInbox = input.openInbox as unknown as OpenInbox;
  const openHostedInbox: OpenInbox = (bindingId, generation) => rawOpenInbox(bindingId, generation, {
    recordAcknowledgement: async acknowledgement => {
      if (!binding || bindingId !== binding.bindingId || generation !== binding.generation
        || acknowledgement.bindingId !== bindingId || acknowledgement.generation !== generation) {
        throw new Error('acknowledgement_binding_mismatch');
      }
      const result = await acknowledgementRecorder.recordBatchAcknowledgement({
        principal: { bindingId: binding.bindingId, generation: binding.generation },
        releaseIds: acknowledgement.releaseIds as never,
      });
      if (result.kind === 'refused') throw new Error('acknowledgement_refused');
    },
  });
  const matrix = createMatrixBootstrapDevice({
    stateDirectory: sessionDirectory,
    profileDirectory: path.join(sessionDirectory, 'matrix-profile'),
    browserBundleDirectory: input.browserBundleDirectory,
    browserDriverDirectory: path.join(path.dirname(input.browserBundleDirectory), 'playwright-core'),
    chromiumExecutablePath,
  });
  let closed = false;
  let binding: SessionBinding | null = null;
  let subscription: SubscriptionHandle | null = null;
  let signer: ProofSigner | null = null;
  let renewal: ReturnType<typeof createCapabilityRenewal> | null = null;
  let mailbox: ReturnType<typeof createProductionOwnerMailbox> | null = null;
  let ownerTrust: ReturnType<typeof createOwnerDeviceTrust> | null = null;
  let harness: HarnessPort | null = null;
  let dispatcher: Dispatcher | null = null;
  let review: ReviewControlHandler | null = null;
  let listening: ReturnType<typeof createHostedListeningControl> | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let polling: Promise<void> | null = null;
  let remoteDenied = false;
  let deliveryStopped = false;
  let activeSends = 0;
  const sendWaiters: Array<() => void> = [];

  async function quiesceDelivery(): Promise<void> {
    deliveryStopped = true;
    await subscription?.stop();
    if (activeSends > 0) await new Promise<void>(resolve => { sendWaiters.push(resolve); });
    await dispatcher?.stop();
  }

  function capabilityFor(next: SessionBinding) {
    if (!signer) throw new Error('production_signer_missing');
    if (!renewal) renewal = createCapabilityRenewal({ stateDirectory: sessionDirectory,
      appOrigin: input.appOrigin, binding: next, signer });
    return renewal;
  }

  function schedulePoll(): void {
    if (closed || remoteDenied || !mailbox || pollTimer || polling) return;
    const run = async () => {
      pollTimer = null;
      if (!mailbox || closed) return;
      try {
        if (await mailbox.pollOnce() === 'revoked') remoteDenied = true;
      } finally {
        polling = null;
        if (!closed && !remoteDenied) {
          pollTimer = setTimeout(() => { polling = run(); }, 2_000);
          pollTimer.unref?.();
        }
      }
    };
    polling = run();
  }

  async function matrixSession(): Promise<MatrixDeviceSession> {
    const raw: unknown = JSON.parse(await readFile(path.join(sessionDirectory, 'matrix-session.json'), 'utf8')) as unknown;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('matrix_session_corrupt');
    const value = raw as Record<string, unknown>;
    for (const field of ['baseUrl', 'userId', 'deviceId', 'accessToken', 'roomId', 'ownerUserId', 'ownerParticipantId']) {
      if (typeof value[field] !== 'string') throw new Error('matrix_session_corrupt');
    }
    return raw as MatrixDeviceSession;
  }

  async function startIntake(next: SessionBinding): Promise<void> {
    if (subscription) return;
    const substrate = matrix.substrate();
    if (!substrate) throw new Error('matrix_device_unavailable');
    const identity = await storage.bindDeviceIdentity({ deviceId: next.deviceId, fingerprint: substrate.fingerprint });
    if (identity.kind === 'conflict') throw new Error('production_device_identity_conflict');
    const session = await matrixSession();
    const agentParticipantId = `agent_${createHash('sha256').update(session.userId).digest('hex').slice(0, 40)}`;
    if (session.deviceId !== next.deviceId || session.ownerUserId === session.userId
      || session.ownerParticipantId === next.agentParticipantId || agentParticipantId !== next.agentParticipantId) {
      throw new Error('matrix_session_binding_conflict');
    }
    const activeSigner = signer;
    if (!activeSigner) throw new Error('production_signer_missing');
    ownerTrust = createOwnerDeviceTrust({ appOrigin: input.appOrigin, binding: next,
      roomId: session.roomId, ownerUserId: session.ownerUserId, signer: activeSigner,
      capability: () => capabilityFor(next).ensure(), matrix: substrate });
    const activeTrust = ownerTrust;
    const controls = createPolicyControlHandler({ dispatchStorage, trust,
      roomId: session.roomId as never, bindingId: next.bindingId });
    const stop = createLocalClosureFence({ storage, binding: next, roomId: session.roomId,
      stateDirectory: sessionDirectory, clock: Date.now,
      quiesce: quiesceDelivery,
    });
    mailbox = createProductionOwnerMailbox({ appOrigin: input.appOrigin, binding: next, signer: activeSigner,
      capability: () => capabilityFor(next).ensure(), controls, review: () => review,
      stop: request => stop.stop(request),
      onRevoked: async () => { remoteDenied = true; deliveryStopped = true; },
    });
    const activeMailbox = mailbox;
    await trust.update(next.bindingId, current => {
      if (current && current.generation !== next.generation) throw new Error('production_trust_generation_conflict');
      return { next: current ?? initialTrustState({ roomId: session.roomId as never,
        bindingId: next.bindingId, ownerId: next.ownerId, generation: next.generation,
        policyVersion: 0 }), result: undefined };
    });
    subscription = await startProductionSubscription({
      binding: next, roomId: session.roomId as never, ownerParticipantId: session.ownerParticipantId as never,
      storage, matrix: substrate,
      guard: async () => {
        if (closed || remoteDenied || deliveryStopped) return 'revoked';
        const authority = await activeMailbox.authorize();
        if (authority !== 'active') return authority === 'unavailable' ? 'unavailable' : 'revoked';
        return activeTrust.ensure();
      },
    });
    if (next.harness === 'codex') {
      harness = createHostedCodexHarness({ binding: next, claim: input.session,
        sessionInspection: sessionInspector,
        current: async () => {
          if (closed || remoteDenied || deliveryStopped) return false;
          const held = await readBinding().catch(() => null);
          return held !== null && sameSessionBinding(held, next)
            && await activeMailbox.authorize() === 'active' && await activeTrust.ensure() === 'active';
        },
        resolveExecutable: input.resolveCodexExecutable,
        inspectHooks: async () => (await input.inspectHostedCodexHooks()) as Awaited<ReturnType<Parameters<typeof createHostedCodexHarness>[0]['inspectHooks']>>,
        openInbox: openHostedInbox,
      });
      const activeHarness = harness;
      listening = createHostedListeningControl({ binding: next, trust, dispatch: dispatchStorage,
        current: async () => {
          if (closed || remoteDenied || deliveryStopped) return false;
          const held = await readBinding().catch(() => null);
          return held !== null && sameSessionBinding(held, next)
            && await activeMailbox.authorize() === 'active' && await activeTrust.ensure() === 'active';
        },
        capabilities: async () => {
          const inspected = await activeHarness.inspect(next);
          return inspected.support === 'tested' ? inspected : null;
        },
      });
      await listening.application.read();
      dispatcher = createDispatcher({ ledger: dispatchStorage.ledger,
        limits: { maxJobsPerCausalRoot: 1, maxConcurrentJobs: 1, busy: 'queue' },
        harness: activeHarness,
        boundary: { await: async ({ job, signal }) => {
          if (signal.aborted || !sameSessionBinding(job.binding, next)) return null;
          if (!await activeMailbox.authorize().then(value => value === 'active').catch(() => false)
            || await activeTrust.ensure() !== 'active') return null;
          const capabilities = await activeHarness.inspect(next);
          return capabilities.support === 'tested' ? { binding: next, capabilities } : null;
        } },
        approvals: dispatchStorage.approvals, payloads: dispatchStorage.payloads,
        digest: async bytes => sha256Digest(bytes), clock: { now: () => new Date() },
        newId: kind => `${kind}_${randomUUID()}`, workerId: `hosted_${randomUUID()}`,
      });
      const activeDispatcher = dispatcher;
      review = createReviewControlHandler({ storage, dispatchStorage, releases: activeDispatcher,
        bindingId: next.bindingId, limits: productionLimits(),
        room: { members: async roomId => {
          if (roomId !== session.roomId || deliveryStopped || remoteDenied
            || await activeMailbox.authorize() !== 'active'
            || await substrate.source.authorize() !== 'ok') return null;
          return [session.ownerParticipantId as never, next.agentParticipantId];
        } },
      });
      await review.resumeReleases(next.bindingId);
    }
    schedulePoll();
  }

  async function readBinding(): Promise<SessionBinding | null> {
    let value: unknown;
    try { value = JSON.parse(await readFile(markerFile, 'utf8')) as unknown; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    const decoded = decodeSessionBinding(value);
    if (!decoded.ok) throw new Error('production_binding_corrupt');
    if (decoded.value.harness !== input.session.harness || decoded.value.sessionId !== input.session.sessionId) {
      throw new Error('production_binding_session_changed');
    }
    const local = await storage.ledger.transaction(tx => tx.readBinding(decoded.value.bindingId));
    if (!local || !sameSessionBinding(local, decoded.value)) throw new Error('production_binding_ledger_mismatch');
    const snapshot = await storage.ledger.transaction(tx => tx.readApprovalSnapshot({ bindingId: local.bindingId, selection: [] }));
    if (snapshot?.kind === 'revoked') throw new Error('production_binding_revoked');
    return local;
  }
  async function persistBinding(next: SessionBinding): Promise<void> {
    const existing = await readBinding();
    if (existing && !sameSessionBinding(existing, next)) throw new Error('production_binding_replacement');
    const recorded = await storage.ledger.transaction(tx => tx.putBinding(next));
    if (recorded.kind === 'conflict') throw new Error('production_binding_conflict');
    const applied = await dispatchStorage.applyEffectivePolicy({ binding: next,
      policy: { version: 0, armedAt: 0, paused: false, expiresAt: null,
        listening: { version: 0, requested: 'sync', effective: null, evidenceRevision: null } },
    });
    if (applied.kind === 'conflict' && applied.code !== 'stale_version') throw new Error('production_policy_conflict');
    if (existing) { binding = existing; return; }
    const temporary = `${markerFile}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(next)); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, markerFile);
      const directory = await open(sessionDirectory, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await rm(temporary, { force: true }); }
    binding = next;
  }

  const sessionInspector = input.sessionInspection(async claim => {
    if (claim.harness !== input.session.harness || claim.sessionId !== input.session.sessionId
      || claim.workdir !== input.session.workdir) return null;
    if (!binding) return 0;
    return (await readBinding().catch(() => null))?.generation ?? null;
  });

  try {
    binding = await readBinding();
    const persistence = await createBootstrapPersistence(storage);
    signer = persistence.signer;
    if (binding) {
      const status = await matrix.devices.status(binding.deviceId);
      if (status !== 'ready') throw new Error('matrix_device_not_ready');
      await startIntake(binding);
    }
    const { operations } = persistence;
    const ports: BootstrapPorts = {
      discovery: createDiscovery({ trustedOrigins: [input.appOrigin], hostedOrigin: input.appOrigin }),
      ownership: createLoopbackOwnership({ signer, openBrowser: input.openBrowser }),
      pairing: createPairingOwnership({ signer }),
      admission: createHttpAdmission({ signer }),
      devices: {
        reserve: operationId => matrix.devices.reserve(operationId),
        status: deviceId => matrix.devices.status(deviceId),
        async activate(activation) {
          const result = await matrix.devices.activate(activation);
          if (result.kind !== 'ready') return result;
          try {
            await persistBinding(activation.binding);
            await capabilityFor(activation.binding).acceptInitial(activation.capability);
            await startIntake(activation.binding);
          }
          catch { return { kind: 'failed', reason: 'storage_unavailable' }; }
          return result;
        },
      },
      sessions: sessionInspector,
      operations,
    };
    return {
      ports,
      async send(command: Readonly<{ bindingId: string | null; clientTxnId: string; body: string }>) {
        if (closed || remoteDenied || deliveryStopped || !binding || !subscription || command.bindingId !== binding.bindingId) {
          return { kind: 'refused' as const, code: 'not_connected' as const, clientTxnId: command.clientTxnId };
        }
        const held = await readBinding().catch(() => null);
        if (!held || !sameSessionBinding(held, binding)) {
          return { kind: 'refused' as const, code: 'binding_not_held' as const, clientTxnId: command.clientTxnId };
        }
        if (!mailbox || !ownerTrust || await mailbox.authorize() !== 'active' || await ownerTrust.ensure() !== 'active') {
          return { kind: 'refused' as const, code: 'not_connected' as const, clientTxnId: command.clientTxnId };
        }
        const substrate = matrix.substrate();
        if (!substrate) return { kind: 'refused' as const, code: 'transport_unavailable' as const, clientTxnId: command.clientTxnId };
        if (deliveryStopped || remoteDenied || closed) {
          return { kind: 'refused' as const, code: 'not_connected' as const, clientTxnId: command.clientTxnId };
        }
        activeSends += 1;
        try {
          const sent = await substrate.send(command.clientTxnId, command.body);
          return { kind: 'accepted' as const, clientTxnId: command.clientTxnId, eventId: sent.eventId };
        } catch { return { kind: 'outcome_unknown' as const, clientTxnId: command.clientTxnId }; }
        finally {
          activeSends -= 1;
          if (activeSends === 0) for (const wake of sendWaiters.splice(0)) wake();
        }
      },
      async status() {
        const prerequisites = { storage: 'ready', device: 'blocked', bootstrap: 'blocked',
          subscription: 'blocked', controls: 'blocked', harness: 'unknown',
          dispatch: 'blocked', review: 'blocked', recovery: 'unknown' } as const;
        type State = 'ready' | 'blocked' | 'offline' | 'unsupported' | 'unknown';
        type Prerequisites = Record<keyof typeof prerequisites, State>;
        const unavailable = <T extends string>(errorCode: T, changes: Partial<Prerequisites> = {},
          phase: 'degraded' | 'stopped' = 'degraded') => ({ v: 1 as const,
          connected: false, binding: null, route: 'unavailable' as const, sourceCursor: null,
          readiness: { phase, prerequisites: { ...prerequisites, ...changes }, errorCode } });
        if (closed) return unavailable('connector_closed', { storage: 'offline' }, 'stopped');
        if (!binding) return unavailable('binding_not_established');
        if (deliveryStopped) return unavailable('channel_closing', { bootstrap: 'blocked' });
        if (remoteDenied) return unavailable('binding_revoked', { bootstrap: 'blocked' });
        const held = await readBinding().catch(() => null);
        if (!held || !sameSessionBinding(held, binding)) return unavailable('binding_revoked');
        const activeDevice = matrix.substrate();
        if (!activeDevice || !subscription) return unavailable('device_unavailable', { device: 'offline', bootstrap: 'ready' });
        const core = { device: 'ready', bootstrap: 'ready' } as const;
        const source = subscriptionDiagnostic(subscription.state());
        if (source) return unavailable(source.errorCode, { ...core, subscription: source.prerequisite });
        const receiving = { ...core, subscription: 'ready' } as const;
        if (!mailbox || !ownerTrust) return unavailable('authority_unavailable', { ...receiving, controls: 'offline' });
        const authority = await mailbox.authorize();
        if (authority === 'closing') return unavailable('channel_closing', { ...receiving, controls: 'blocked' });
        if (authority === 'revoked') return unavailable('binding_revoked', { ...receiving, controls: 'blocked' });
        if (authority !== 'active') return unavailable('authority_unavailable', { ...receiving, controls: 'offline' });
        const trusted = await ownerTrust.ensure();
        if (trusted !== 'active') return unavailable(trusted === 'revoked' ? 'binding_revoked' : 'owner_device_unverified',
          { ...receiving, controls: trusted === 'revoked' ? 'blocked' : 'unknown' });
        const controlled = { ...receiving, controls: 'ready' } as const;
        const activeHarness = harness as HarnessPort | null;
        if (!activeHarness) return unavailable('harness_unsupported', { ...controlled, harness: 'unsupported' });
        const inspected = await activeHarness.inspect(held);
        if (inspected.support !== 'tested') return unavailable(inspected.support === 'unsupported'
          ? 'harness_unsupported' : 'harness_unknown', { ...controlled,
          harness: inspected.support === 'unsupported' ? 'unsupported' : 'unknown' });
        const proved = { ...controlled, harness: 'ready' } as const;
        const activeListening = listening as ReturnType<typeof createHostedListeningControl> | null;
        if (!activeListening || (await activeListening.status()).effective === null) {
          return unavailable('listening_mode_unavailable', { ...proved });
        }
        if (!review) return unavailable('review_unavailable', { ...proved });
        if (!dispatcher) return unavailable('dispatch_unavailable', { ...proved, review: 'ready' });
        return { v: 1 as const, connected: true, binding: held,
          route: 'native_cli_queue' as const, sourceCursor: null,
          readiness: { phase: 'ready' as const, prerequisites: { storage: 'ready' as const, ...proved,
            review: 'ready' as const, dispatch: 'ready' as const, recovery: 'unknown' as const }, errorCode: null },
        };
      },
      async listChannels() { return { kind: 'unavailable' as const }; },
      async listAgents() { return { kind: 'unavailable' as const }; },
      async listeningMode() {
        const active = listening as ReturnType<typeof createHostedListeningControl> | null;
        if (!active) throw new Error('listening_mode_unavailable');
        return active.status();
      },
      listeningModeControl: {
        read: () => {
          const active = listening as ReturnType<typeof createHostedListeningControl> | null;
          return active ? active.application.read() : Promise.resolve({ ok: false as const, code: 'unavailable' as const });
        },
        set: (command: AgentListeningModeSetInput) => {
          const active = listening as ReturnType<typeof createHostedListeningControl> | null;
          if (!active) throw new Error('listening_mode_unavailable');
          return active.application.set(command);
        },
      },
      inbox: openHostedInbox as unknown as TInbox,
      async close() {
        if (closed) return;
        closed = true;
        mailbox?.close();
        if (pollTimer) clearTimeout(pollTimer);
        await polling?.catch(() => undefined);
        try {
          review?.dispose();
          await dispatcher?.stop();
          await harness?.close();
          await subscription?.stop();
          await matrix.close();
        } finally { trust.close(); await storage.close(); }
      },
    };
  } catch (error) {
    const active = subscription as SubscriptionHandle | null;
    const activeMailbox = mailbox as ReturnType<typeof createProductionOwnerMailbox> | null;
    const activePoll = polling as Promise<void> | null;
    const activeReview = review as ReviewControlHandler | null;
    const activeDispatcher = dispatcher as Dispatcher | null;
    const activeHarness = harness as HarnessPort | null;
    activeMailbox?.close();
    if (pollTimer) clearTimeout(pollTimer);
    await activePoll?.catch(() => undefined);
    try {
      activeReview?.dispose();
      await activeDispatcher?.stop();
      await activeHarness?.close();
      await active?.stop();
      await matrix.close();
    } finally { trust.close(); await storage.close(); }
    throw error;
  }
}
