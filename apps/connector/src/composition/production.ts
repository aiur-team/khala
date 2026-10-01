import { createHash, randomUUID } from 'node:crypto';
import { access, link, lstat, mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import {
  createDiscovery, createHttpAdmission, createLoopbackOwnership, createPairingOwnership,
  type BootstrapPorts, type SessionClaim, type SessionInspectionPort,
} from '@khala/connector/bootstrap/index';
import type { MatrixDeviceSession } from '@khala/connector/bootstrap/ports';
import { decodeDeliveryLimits, decodeSessionBinding, sameSessionBinding, type SessionBinding, type UnverifiedReleasedJob } from '@khala/contracts/delivery/index';
import { createBootstrapPersistence } from '@khala/connector/storage/bootstrap';
import type { HostedOpenDiagnostic } from '@khala/connector/bootstrap/hosted-open-diagnostic';
import type { HostedSubscriptionDiagnostic } from '@khala/connector/subscription/diagnostic';
import { STORAGE_ERROR_CODES, StorageError } from '@khala/connector/storage/errors';
import { createChannelAccessActivationStore } from '@khala/connector/storage/channel-access';
import { openConnectorStorage } from '@khala/connector/storage/open';
import type { ProofSigner } from '@khala/connector/bootstrap/proof';
import { createMatrixBootstrapDevice } from '../substrate/bootstrap-device';
import type { openMatrixConnectorSubstrate } from '../substrate/matrix';
import { startProductionSubscription } from './agent/subscription';
import type { SubscriptionHandle, SubscriptionState } from '@khala/connector/subscription/index';
import { createCapabilityRenewal } from './agent/capability-renewal';
import { createProductionOwnerMailbox } from './agent/owner-mailbox';
import { createProductionRevocationCleanup } from './agent/revocation-cleanup';
import { createAgentRoomSendFence } from './agent/room-send-fence';
import { createLocalClosureFence, hasLocalRevocationStop } from './closure/local-fence';
import { createConnectorDispatchStorage } from '@khala/connector/storage/dispatch';
import { createPolicyControlHandler } from './controls/control-handler';
import { openTrustStateStore } from './controls/trust-store';
import { createOwnerDeviceTrust } from './agent/owner-device-trust';
import { createAgentDeviceAttestation } from './agent/device-attestation';
import { createHostedCodexHarness, verifyReleasePayload, type LocalInbox } from './agent/hosted-codex';
import { createDispatcher } from '@khala/connector/dispatch/run';
import type { Dispatcher } from '@khala/connector/dispatch/types';
import { sha256Digest } from '@khala/connector/storage/payloads';
import { createReviewControlHandler, type ReviewControlHandler } from './review/control-handler';
import { createAcknowledgementRecorder } from '@khala/connector/storage/acknowledgements';
import type { HarnessPort } from '@khala/contracts/delivery/index';
import { initialTrustState } from '@khala/policy/trust/index';
import { createHostedListeningControl } from './agent/hosted-listening';
import { createManualReadWitness, manualListeningCapabilities, manualReadProof } from './agent/manual-listening';
import { createAgentParticipantLookup } from './agent/participant-directory';
import { renameDelivery } from './agent/rename-delivery';
import { readOrderedPendingReferences } from '@khala/connector/storage/ordered-pending';
import { createOrderedProjection } from './agent/ordered-projection';
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

/** Owner commands cannot be starved by an unrelated outbound-session inspection. */
export async function pollOwnerMailboxBeforeRotation(
  mailbox: Pick<ReturnType<typeof createProductionOwnerMailbox>, 'pollOnce'>,
  roomSend: Pick<ReturnType<typeof createAgentRoomSendFence>, 'pollRotation'> | null,
  diagnostic: (event: HostedSubscriptionDiagnostic) => void,
): Promise<'ok' | 'unavailable' | 'revoked'> {
  let outcome: 'ok' | 'unavailable' | 'revoked';
  try { outcome = await mailbox.pollOnce(); }
  catch { diagnostic({ stage: 'mailbox_poll_fetch', result: 'unavailable' }); outcome = 'unavailable'; }
  if (outcome === 'revoked') return outcome;
  try { await roomSend?.pollRotation(); }
  catch { diagnostic({ stage: 'mailbox_rotation', result: 'unavailable' }); }
  return outcome;
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
  diagnostic?(event: HostedOpenDiagnostic): void;
  subscriptionDiagnostic?(event: HostedSubscriptionDiagnostic): void;
  /** Inject the Matrix transport in composition tests while retaining the production credential fence. */
  openMatrix?: typeof openMatrixConnectorSubstrate;
}>) {
  const reportOpen = (stage: Exclude<HostedOpenDiagnostic['stage'], 'matrix_writer_recovered'>, error?: unknown) => {
    const code = error instanceof StorageError && STORAGE_ERROR_CODES.includes(error.code) ? error.code : undefined;
    try { input.diagnostic?.({ stage, result: 'unavailable', ...(code ? { errorCode: code } : {}) }); }
    catch { /* Diagnostics cannot change startup behavior. */ }
  };
  const reportSubscription = (event: HostedSubscriptionDiagnostic) => {
    try { input.subscriptionDiagnostic?.(event); }
    catch { /* Diagnostics cannot change intake. */ }
  };
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
  // The installed launcher supplies its own verified browser. Prefer that
  // executable so a host browser cannot bypass its private trust setup.
  for (const candidate of [...(input.chromiumExecutablePath ? [input.chromiumExecutablePath] : []), ...systemBrowsers]) {
    try {
      await access(candidate, constants.X_OK);
      if (!(await stat(candidate)).isFile()) continue;
      const version = await execFileAsync(candidate, ['--version'], { timeout: 3_000, maxBuffer: 1024 });
      if (supportedBrowserVersion(version.stdout)) { chromiumExecutablePath = candidate; break; }
    } catch { /* Try the next installed executable. */ }
  }
  if (!chromiumExecutablePath) {
    reportOpen('browser_preflight');
    throw new Error('chromium_unavailable_run_khala_setup');
  }
  const sessionDirectory = productionSessionDirectory(input.stateDirectory, input.session);
  const stateDirectory = path.join(sessionDirectory, 'state');
  const markerFile = path.join(sessionDirectory, 'current-binding.json');
  const admissionFile = (operationId: string) => path.join(sessionDirectory,
    `channel-access-${createHash('sha256').update(operationId).digest('hex')}.json`);
  await mkdir(sessionDirectory, { recursive: true, mode: 0o700 })
    .catch(error => { reportOpen('state_storage', error); throw error; });
  let mode: 'create' | 'existing';
  try { mode = (await stat(stateDirectory)).isDirectory() ? 'existing' : 'create'; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      reportOpen('state_storage', error);
      throw error;
    }
    mode = 'create';
  }
  const storage = await openConnectorStorage({ directory: stateDirectory, mode, limits: productionLimits() })
    .catch(error => { reportOpen('state_storage', error); throw error; });
  const trust = await openTrustStateStore({ directory: stateDirectory, mode }).catch(async error => {
    reportOpen('trust_storage', error);
    await storage.close();
    throw error;
  });
  const dispatchStorage = createConnectorDispatchStorage(storage);
  const acknowledgementRecorder = createAcknowledgementRecorder(storage);
  const manualReadWitness = createManualReadWitness();
  type Acknowledgement = Readonly<{ bindingId: string; generation: number; token: string; releaseIds: readonly string[] }>;
  type OpenInbox = (bindingId: string, generation: number, options?: Readonly<{
    recordAcknowledgement?: (acknowledgement: Acknowledgement) => Promise<void>;
  }>) => Promise<LocalInbox>;
  const rawOpenInbox = input.openInbox as unknown as OpenInbox;
  const projections = new Map<string, ReturnType<typeof createOrderedProjection>>();
  const projectionFor = (bindingId: string, generation: number) => {
    const key = JSON.stringify([bindingId, generation]);
    let projection = projections.get(key);
    if (!projection) { projection = createOrderedProjection(path.join(sessionDirectory, `projection-${createHash('sha256').update(key).digest('hex')}.json`),
      { manualRead: manualRoute }); projections.set(key, projection); }
    return projection;
  };
  const openRawHostedInbox: OpenInbox = (bindingId, generation) => {
    if (closed || remoteDenied || deliveryStopped) throw new Error('production_binding_revoked');
    return rawOpenInbox(bindingId, generation, {
    recordAcknowledgement: async acknowledgement => {
      if (!binding || bindingId !== binding.bindingId || generation !== binding.generation
        || acknowledgement.bindingId !== bindingId || acknowledgement.generation !== generation) {
        throw new Error('acknowledgement_binding_mismatch');
      }
      const releases = await projectionFor(bindingId, generation).acknowledge(acknowledgement.releaseIds);
      if (releases.length === 0) return;
      const result = await acknowledgementRecorder.recordBatchAcknowledgement({
        principal: { bindingId: binding.bindingId, generation: binding.generation },
        releaseIds: releases as never,
      });
      if (result.kind === 'refused') throw new Error('acknowledgement_refused');
      if (manualRoute) manualReadWitness.acknowledge(bindingId, generation, acknowledgement.token, releases);
    },
    }).then(inbox => new Proxy(inbox, { get(target, property, receiver) {
      if (property === 'enqueue') return (delivery: Parameters<LocalInbox['enqueue']>[0]) => {
        if (closed || remoteDenied || deliveryStopped || !binding || binding.bindingId !== bindingId || binding.generation !== generation) {
          throw new Error('production_binding_revoked');
        }
        return target.enqueue(delivery);
      };
      const value = Reflect.get(target, property, receiver);
      if (property === 'acquireCallConsumer' && manualRoute && typeof value === 'function') {
        return async () => {
          const consumer = await value.call(target) as { readBatch(input: { explicitRead?: boolean }): Promise<{ token: string } | null> };
          return new Proxy(consumer, { get(reader, key, readerReceiver) {
            if (key === 'readBatch') return async (input: { explicitRead?: boolean }) => {
              const batch = input.explicitRead === true
                ? await manualReadWitness.withinExplicitRead(() => reader.readBatch(input))
                : await reader.readBatch(input);
              if (input.explicitRead === true && batch) manualReadWitness.offer(bindingId, generation, batch.token);
              return batch;
            };
            const method = Reflect.get(reader, key, readerReceiver);
            return typeof method === 'function' ? method.bind(reader) : method;
          } });
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    } }));
  };
  const openHostedInbox: OpenInbox = (bindingId, generation) => {
    const opened = openRawHostedInbox(bindingId, generation);
    return opened.then(async inbox => {
      const projection = projectionFor(bindingId, generation);
      await projection.flush(inbox);
      // Preserve call/wake consumers on the CLI's FileInbox prototype.
      return new Proxy(inbox, { get(target, property, receiver) {
        if (property === 'enqueue') return (delivery: Parameters<LocalInbox['enqueue']>[0]) => projection.enqueue(delivery, target);
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      } });
    });
  };
  const matrix = createMatrixBootstrapDevice({
    stateDirectory: sessionDirectory,
    profileDirectory: path.join(sessionDirectory, 'matrix-profile'),
    browserBundleDirectory: input.browserBundleDirectory,
    browserDriverDirectory: path.join(path.dirname(input.browserBundleDirectory), 'playwright-core'),
    chromiumExecutablePath,
    diagnostic: reportSubscription,
    writerLockDiagnostic: event => { try { input.diagnostic?.(event); } catch { /* Diagnostics cannot change startup behavior. */ } },
    resolveParticipants: async (userIds, targetParticipantIds) => {
      if (!binding || !signer || closed || remoteDenied || deliveryStopped) return null;
      const session = await matrixSession();
      return createAgentParticipantLookup({ appOrigin: input.appOrigin, binding, roomId: session.roomId,
        signer, capability: () => capabilityFor(binding!).ensure() })(userIds, targetParticipantIds);
    },
    onText: async event => {
      if (!binding || closed || remoteDenied || deliveryStopped) return false;
      await projectionFor(binding.bindingId, binding.generation).observe(event.roomId, event.eventId, event.authorName);
      return true;
    },
    onCurrentNames: async names => {
      if (!binding || closed || remoteDenied || deliveryStopped) return false;
      const inbox = await openRawHostedInbox(binding.bindingId, binding.generation);
      if (!inbox.setCurrentNames) return false;
      await inbox.setCurrentNames(names);
      return true;
    },
    onRename: async event => {
      if (!binding || closed || remoteDenied || deliveryStopped) return false;
      try {
        const inbox = await openRawHostedInbox(binding.bindingId, binding.generation);
        await projectionFor(binding.bindingId, binding.generation).metadata(renameDelivery(binding, event), inbox);
        return true;
      } catch { return false; }
    },
    ...(input.openMatrix ? { open: input.openMatrix } : {}),
  });
  let closed = false;
  let binding: SessionBinding | null = null;
  let subscription: SubscriptionHandle | null = null;
  let signer: ProofSigner | null = null;
  let renewal: ReturnType<typeof createCapabilityRenewal> | null = null;
  let mailbox: ReturnType<typeof createProductionOwnerMailbox> | null = null;
  let revocationCleanup: ReturnType<typeof createProductionRevocationCleanup> | null = null;
  let roomSend: ReturnType<typeof createAgentRoomSendFence> | null = null;
  let cleanupTimer: ReturnType<typeof setTimeout> | null = null;
  let ownerTrust: ReturnType<typeof createOwnerDeviceTrust> | null = null;
  let harness: HarnessPort | null = null;
  let dispatcher: Dispatcher | null = null;
  let review: ReviewControlHandler | null = null;
  let manualRoute = false;
  let listening: ReturnType<typeof createHostedListeningControl> | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let polling: Promise<void> | null = null;
  let remoteDenied = false;
  let deliveryStopped = false;
  let activeSends = 0;
  const inFlightSendTxnIds = new Set<string>();
  let activeReleases = 0;
  let openStage: Exclude<HostedOpenDiagnostic['stage'], 'matrix_writer_recovered'> = 'bootstrap_persistence';
  const sendWaiters: Array<() => void> = [];

  async function quiesceDelivery(): Promise<void> {
    deliveryStopped = true;
    await subscription?.stop();
    if (activeSends + activeReleases > 0) await new Promise<void>(resolve => { sendWaiters.push(resolve); });
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
        const outcome = await pollOwnerMailboxBeforeRotation(mailbox, roomSend, reportSubscription);
        if (outcome === 'revoked') { remoteDenied = true; scheduleCleanup(); }
      } finally {
        polling = null;
        if (!closed && !remoteDenied) {
          pollTimer = setTimeout(() => { polling = run(); }, 2_000);
          pollTimer.unref?.();
        }
      }
    };
    reportSubscription({ stage: 'mailbox_poll_scheduled', result: 'ok' });
    polling = run();
  }

  function scheduleCleanup(): void {
    if (closed || !remoteDenied || !revocationCleanup || cleanupTimer) return;
    const run = async () => {
      cleanupTimer = null;
      if (closed || !revocationCleanup) return;
      const outcome = await revocationCleanup.pollOnce().catch(() => 'unavailable' as const);
      if (outcome !== 'complete' && !closed) {
        cleanupTimer = setTimeout(() => { void run(); }, 5_000);
        cleanupTimer.unref?.();
      }
    };
    void run();
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

  async function boundMatrixSession(next: SessionBinding): Promise<MatrixDeviceSession> {
    const session = await matrixSession();
    const agentParticipantId = `agent_${createHash('sha256').update(session.userId).digest('hex').slice(0, 40)}`;
    if (session.deviceId !== next.deviceId || session.ownerUserId === session.userId
      || session.ownerParticipantId === next.agentParticipantId || agentParticipantId !== next.agentParticipantId) {
      throw new Error('matrix_session_binding_conflict');
    }
    return session;
  }

  async function startIntake(next: SessionBinding): Promise<void> {
    if (subscription) return;
    const substrate = matrix.substrate();
    if (!substrate) throw new Error('matrix_device_unavailable');
    const identity = await storage.bindDeviceIdentity({ deviceId: next.deviceId, fingerprint: substrate.fingerprint });
    if (identity.kind === 'conflict') throw new Error('production_device_identity_conflict');
    const session = await boundMatrixSession(next);
    const activeSigner = signer;
    if (!activeSigner) throw new Error('production_signer_missing');
    const attestation = createAgentDeviceAttestation({ appOrigin: input.appOrigin, binding: next,
      signer: activeSigner, capability: () => capabilityFor(next).ensure(), fingerprint: () => substrate.fingerprint });
    ownerTrust = createOwnerDeviceTrust({ appOrigin: input.appOrigin, binding: next,
      roomId: session.roomId, ownerUserId: session.ownerUserId, signer: activeSigner,
      capability: () => capabilityFor(next).ensure(), registerOwnDevice: () => attestation.ensure(),
      matrix: substrate, diagnostic: reportSubscription });
    const activeTrust = ownerTrust;
    const controls = createPolicyControlHandler({ dispatchStorage, trust,
      roomId: session.roomId as never, bindingId: next.bindingId,
      // The same bound, current-session inspection used at the dispatch boundary.
      // An absent or failed inspection remains unknown; it never grants controls.
      capabilities: async () => harness ? await harness.inspect(next).catch(() => null) : null });
    const stop = createLocalClosureFence({ storage, binding: next, roomId: session.roomId,
      stateDirectory: sessionDirectory, clock: Date.now,
      quiesce: quiesceDelivery,
    });
    revocationCleanup = createProductionRevocationCleanup({
      appOrigin: input.appOrigin, binding: next, signer: activeSigner,
      existingCapability: () => capabilityFor(next).existingForCleanup(),
      stop: operationId => stop.stop({ operationId, ownerId: next.ownerId,
        roomId: session.roomId, expectedRoomRevision: 0 }),
      removeOwnDevice: key => substrate.removeOwnDevice(key),
    });
    roomSend = createAgentRoomSendFence({ appOrigin: input.appOrigin, bindingId: next.bindingId,
      generation: next.generation, signer: activeSigner,
      capability: () => capabilityFor(next).ensure(),
      discardOutboundSession: () => substrate.discardOutboundSession() });
    mailbox = createProductionOwnerMailbox({ appOrigin: input.appOrigin, binding: next, signer: activeSigner,
      capability: () => capabilityFor(next).ensure(), controls, listening: () => listening?.owner ?? null, review: () => review,
      stop: request => stop.stop(request),
      onRevoked: async () => { remoteDenied = true; deliveryStopped = true; scheduleCleanup(); },
      diagnostic: reportSubscription,
    });
    const activeMailbox = mailbox;
    await trust.update(next.bindingId, current => {
      if (current && current.generation !== next.generation) throw new Error('production_trust_generation_conflict');
      return { next: current ?? initialTrustState({ roomId: session.roomId as never,
        bindingId: next.bindingId, ownerId: next.ownerId, generation: next.generation,
        policyVersion: 0 }), result: undefined };
    });
    if (input.session.harness === 'codex') {
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
    }
    const inspected = harness ? await harness.inspect(next).catch(() => null) : null;
    manualRoute = next.harness === 'proof-key' && (input.session.harness === 'claude'
      || input.session.harness === 'codex' && inspected?.support !== 'tested');
    await projectionFor(next.bindingId, next.generation).seedLegacy(readOrderedPendingReferences(storage, next));
    openStage = 'subscription_start';
    subscription = await startProductionSubscription({
      binding: next, roomId: session.roomId as never, ownerParticipantId: session.ownerParticipantId as never,
      storage, matrix: substrate, diagnostic: reportSubscription,
      guard: async () => {
        if (closed || remoteDenied || deliveryStopped) return { kind: 'revoked' as const, stage: 'local_guard' as const };
        const authority = await activeMailbox.authorize();
        if (authority !== 'active') return { kind: authority === 'unavailable' ? 'unavailable' as const : 'revoked' as const,
          stage: 'mailbox_guard' as const };
        const trusted = await activeTrust.ensure();
        return trusted === 'active' ? { kind: 'active' as const }
          : { kind: trusted, stage: 'owner_device_guard' as const };
      },
    });
    reportSubscription({ stage: 'intake_subscription_started', result: 'ok' });
    if (manualRoute) {
      const releases = { enqueue: async (job: UnverifiedReleasedJob) => {
        activeReleases += 1;
        try {
          if (!sameSessionBinding(job.binding, next) || closed || remoteDenied || deliveryStopped) return 'conflict' as const;
          const held = await readBinding().catch(error => {
            if (error instanceof Error && ['production_binding_revoked', 'production_binding_session_changed',
              'production_binding_ledger_mismatch'].includes(error.message)) return null;
            throw error;
          });
          if (!held || !sameSessionBinding(held, next)) return 'conflict' as const;
          const authority = await activeMailbox.authorize();
          if (authority === 'unavailable') throw new Error('manual_release_authority_unavailable');
          if (authority !== 'active') return 'conflict' as const;
          const ownerDevice = await activeTrust.ensure();
          if (ownerDevice === 'unavailable') throw new Error('manual_release_owner_device_unavailable');
          if (ownerDevice !== 'active') return 'conflict' as const;
          const committed = await storage.ledger.transaction(tx => tx.readRelease(job.releaseId));
          if (!committed || !sameSessionBinding(committed.job.binding, next)
            || committed.job.payloadRef !== job.payloadRef
            || committed.job.payloadDigest !== job.payloadDigest) return 'conflict' as const;
          const payload = await dispatchStorage.payloads.read(job.payloadRef, productionLimits().maxPayloadBytes);
          if (!payload || await verifyReleasePayload(committed.job, payload) !== 'ok') return 'conflict' as const;
          if (closed || remoteDenied || deliveryStopped) return 'conflict' as const;
          const finalAuthority = await activeMailbox.authorize();
          if (finalAuthority === 'unavailable') throw new Error('manual_release_authority_unavailable');
          if (finalAuthority !== 'active') return 'conflict' as const;
          const finalDevice = await activeTrust.ensure();
          if (finalDevice === 'unavailable') throw new Error('manual_release_owner_device_unavailable');
          if (finalDevice !== 'active') return 'conflict' as const;
          const inbox = await openRawHostedInbox(next.bindingId, next.generation);
          if (closed || remoteDenied || deliveryStopped) return 'conflict' as const;
          const result = await projectionFor(next.bindingId, next.generation).enqueue({
            v: 1, releaseId: job.releaseId, bindingId: next.bindingId, generation: next.generation,
            events: committed.job.events, payloadDigest: committed.job.payloadDigest, payload,
            receivedAt: new Date().toISOString(),
          }, inbox);
          return result === 'duplicate' ? 'duplicate' as const : 'queued' as const;
        } finally {
          activeReleases -= 1;
          if (activeSends + activeReleases === 0) for (const wake of sendWaiters.splice(0)) wake();
        }
      } };
      review = createReviewControlHandler({ storage, dispatchStorage, releases,
        bindingId: next.bindingId, limits: productionLimits(),
        room: { members: async roomId => {
          if (roomId !== session.roomId || closed || remoteDenied || deliveryStopped
            || await activeMailbox.authorize() !== 'active' || await activeTrust.ensure() !== 'active'
            || await substrate.source.authorize() !== 'ok') return null;
          return substrate.reviewMembers();
        } },
      });
      openStage = 'review_resume';
      await review.resumeReleases(next.bindingId);
      reportSubscription({ stage: 'intake_review_initialized', result: 'ok' });
      const manualListening = createHostedListeningControl({ binding: next, trust, dispatch: dispatchStorage,
        current: async () => {
          if (closed || remoteDenied || deliveryStopped) return false;
          const held = await readBinding().catch(() => null);
          return held !== null && sameSessionBinding(held, next)
            && await activeMailbox.authorize() === 'active' && await activeTrust.ensure() === 'active';
        },
        capabilities: async () => {
          const inspected = await sessionInspector.inspect(input.session).catch(() => null);
          const currentSession = inspected?.kind === 'verified'
            && inspected.session.harness === input.session.harness
            && inspected.session.sessionId === input.session.sessionId
            && inspected.session.generation === next.generation;
          const version = currentSession ? inspected.capabilities.version : 'unknown';
          const proof = currentSession ? await manualReadProof(acknowledgementRecorder, next, manualReadWitness) : null;
          return manualListeningCapabilities(next, input.session.harness as 'claude' | 'codex', version, proof);
        },
      });
      listening = { ...manualListening, application: {
        read: manualListening.application.read,
        async set(command) {
          const current = await manualListening.application.read();
          const support = current.ok ? current.view.support[command.requested] : null;
          if (support?.status === 'proven' || support?.status === 'experimental') {
            return manualListening.application.set(command);
          }
          return { v: 1 as const, commandId: command.commandId, bindingId: next.bindingId,
            generation: next.generation, outcome: 'refused' as const,
            version: command.expectedVersion, requested: command.requested, effective: null,
            reason: support?.reason ?? (current.ok ? 'capabilities_unavailable' : current.code) };
        },
      } };
      await listening.application.read();
      reportSubscription({ stage: 'intake_listening_initialized', result: 'ok' });
    } else if (harness) {
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
      reportSubscription({ stage: 'intake_listening_initialized', result: 'ok' });
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
          return substrate.reviewMembers();
        } },
      });
      openStage = 'review_resume';
      await review.resumeReleases(next.bindingId);
      reportSubscription({ stage: 'intake_review_initialized', result: 'ok' });
    }
    schedulePoll();
  }

  async function readBinding(allowStopped = false): Promise<SessionBinding | null> {
    let value: unknown;
    try { value = JSON.parse(await readFile(markerFile, 'utf8')) as unknown; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    const decoded = decodeSessionBinding(value);
    if (!decoded.ok) throw new Error('production_binding_corrupt');
    const providerSession = decoded.value.harness === input.session.harness
      && decoded.value.sessionId === input.session.sessionId;
    const approvedProofKey = decoded.value.harness === 'proof-key'
      && signer !== null && decoded.value.sessionId === `agent_${signer.jkt}`;
    if (!providerSession && !approvedProofKey) {
      throw new Error('production_binding_session_changed');
    }
    const local = await storage.ledger.transaction(tx => tx.readBinding(decoded.value.bindingId));
    if (!local || !sameSessionBinding(local, decoded.value)) throw new Error('production_binding_ledger_mismatch');
    const snapshot = await storage.ledger.transaction(tx => tx.readApprovalSnapshot({ bindingId: local.bindingId, selection: [] }));
    if (snapshot?.kind === 'revoked' && !allowStopped) throw new Error('production_binding_revoked');
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
    openStage = 'bootstrap_persistence';
    const persistence = await createBootstrapPersistence(storage);
    signer = persistence.signer;
    // A hosted binding records the approved proof-key principal. Recover the
    // persisted signer before checking that principal against the marker.
    openStage = 'binding_recovery';
    binding = await readBinding(true);
    if (binding) {
      const heldBinding = binding;
      const snapshot = await storage.ledger.transaction(tx => tx.readApprovalSnapshot({ bindingId: heldBinding.bindingId, selection: [] }));
      if (!snapshot) throw new Error('production_binding_ledger_mismatch');
      if (snapshot?.kind === 'revoked') {
        const stoppedBinding = heldBinding;
        const session = await boundMatrixSession(stoppedBinding);
        if (!await hasLocalRevocationStop({ stateDirectory: sessionDirectory, binding: stoppedBinding, roomId: session.roomId })) {
          throw new Error('production_binding_revoked');
        }
        const activeSigner = signer;
        const stop = createLocalClosureFence({ storage, binding: stoppedBinding, roomId: session.roomId,
          stateDirectory: sessionDirectory, clock: Date.now, quiesce: quiesceDelivery });
        remoteDenied = true;
        deliveryStopped = true;
        revocationCleanup = createProductionRevocationCleanup({ appOrigin: input.appOrigin,
          binding: stoppedBinding, signer: activeSigner,
          existingCapability: () => capabilityFor(stoppedBinding).existingForCleanup(),
          stop: async operationId => await hasLocalRevocationStop({ stateDirectory: sessionDirectory,
            binding: stoppedBinding, roomId: session.roomId, operationId })
            ? stop.stop({ operationId, ownerId: stoppedBinding.ownerId, roomId: session.roomId, expectedRoomRevision: 0 })
            : { kind: 'unavailable' },
          async removeOwnDevice(key) {
            if (await matrix.devices.status(stoppedBinding.deviceId) !== 'ready') return 'unavailable';
            return matrix.substrate()?.removeOwnDevice(key) ?? 'unavailable';
          },
        });
        scheduleCleanup();
      } else {
        openStage = 'device_resume';
        const status = await matrix.devices.status(heldBinding.deviceId);
        if (status !== 'ready') throw new Error('matrix_device_not_ready');
        openStage = 'intake_start';
        await startIntake(heldBinding);
      }
    }
    openStage = 'connector_bootstrap';
    const { operations } = persistence;
    const ports: BootstrapPorts = {
      discovery: createDiscovery({ trustedOrigins: [input.appOrigin], hostedOrigin: input.appOrigin }),
      ownership: createLoopbackOwnership({ signer, openBrowser: input.openBrowser }),
      pairing: createPairingOwnership({ signer }),
      admission: createHttpAdmission({ signer }),
      devices: {
        reserve: operationId => remoteDenied ? Promise.resolve({ kind: 'unavailable' }) : matrix.devices.reserve(operationId),
        status: deviceId => remoteDenied ? Promise.resolve('unavailable') : matrix.devices.status(deviceId),
        async activate(activation) {
          if (remoteDenied) return { kind: 'failed', reason: 'storage_unavailable' };
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
      proofSigner: signer,
      channelAccess: {
        journal: createChannelAccessActivationStore(storage),
        devices: ports.devices,
        async admitted(operationId: string, value: Readonly<{ binding: SessionBinding; matrixSession: MatrixDeviceSession }>) {
          if (!/^[A-Za-z0-9_-]{8,64}$/.test(operationId) || closed || remoteDenied
            || !signer || value.binding.harness !== 'proof-key'
            || value.binding.sessionId !== `agent_${signer.jkt}`
            || value.binding.deviceId !== value.matrixSession.deviceId) throw new Error('channel_access_admission_invalid');
          const file = admissionFile(operationId);
          const temporary = `${file}.${randomUUID()}.tmp`;
          try {
            const handle = await open(temporary, 'wx', 0o600);
            try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
            try { await link(temporary, file); } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
              const previous: unknown = JSON.parse(await readFile(file, 'utf8'));
              if (JSON.stringify(previous) !== JSON.stringify(value)) throw new Error('channel_access_admission_conflict');
            }
            const directory = await open(sessionDirectory, 'r');
            try { await directory.sync(); } finally { await directory.close(); }
          } finally { await rm(temporary, { force: true }); }
        },
        async recovered(operationId: string) {
          if (!/^[A-Za-z0-9_-]{8,64}$/.test(operationId) || closed || remoteDenied) return null;
          let value: unknown;
          try { value = JSON.parse(await readFile(admissionFile(operationId), 'utf8')); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
          if (!value || typeof value !== 'object' || !('binding' in value) || !('matrixSession' in value)) return null;
          const record = value as { binding: unknown; matrixSession: MatrixDeviceSession };
          const decoded = decodeSessionBinding(record.binding);
          if (!decoded.ok || !signer || decoded.value.harness !== 'proof-key'
            || decoded.value.sessionId !== `agent_${signer.jkt}`
            || decoded.value.deviceId !== record.matrixSession?.deviceId) return null;
          return { binding: decoded.value, matrixSession: record.matrixSession };
        },
        trust: { async initialize(next: SessionBinding) {
          if (closed || remoteDenied || !binding || !sameSessionBinding(binding, next)) return { kind: 'failed' as const };
          const state = await trust.read(next.bindingId);
          if (!state || state.generation !== next.generation || !state.effective) return { kind: 'unavailable' as const };
          return { kind: 'initialized' as const, mode: state.effective.mode, paused: state.effective.paused };
        } },
      },
      async send(command: Readonly<{ bindingId: string | null; clientTxnId: string; body: string }>) {
        if (inFlightSendTxnIds.has(command.clientTxnId)) {
          return { kind: 'refused' as const, code: 'transport_unavailable' as const, clientTxnId: command.clientTxnId };
        }
        inFlightSendTxnIds.add(command.clientTxnId);
        try {
          if (closed || remoteDenied || deliveryStopped || !binding || !subscription
            || subscription.state().kind !== 'live' || command.bindingId !== binding.bindingId) {
            return { kind: 'refused' as const, code: 'not_connected' as const, clientTxnId: command.clientTxnId };
          }
          const held = await readBinding().catch(() => null);
          if (!held || !sameSessionBinding(held, binding)) {
            return { kind: 'refused' as const, code: 'binding_not_held' as const, clientTxnId: command.clientTxnId };
          }
          const sendAuthority = async (): Promise<'active' | 'refused' | 'unavailable'> => {
            if (!mailbox || !ownerTrust) return 'refused';
            try {
              const owner = await mailbox.authorize();
              if (owner === 'unavailable') return 'unavailable';
              if (owner !== 'active') return 'refused';
              const device = await ownerTrust.ensure();
              return device === 'active' ? 'active' : device === 'unavailable' ? 'unavailable' : 'refused';
            } catch { return 'unavailable'; }
          };
          const initialAuthority = await sendAuthority();
          if (initialAuthority !== 'active') {
            return { kind: 'refused' as const,
              code: initialAuthority === 'unavailable' ? 'transport_unavailable' as const : 'not_connected' as const,
              clientTxnId: command.clientTxnId };
          }
          const substrate = matrix.substrate();
          if (!substrate) return { kind: 'refused' as const, code: 'transport_unavailable' as const, clientTxnId: command.clientTxnId };
          if (deliveryStopped || remoteDenied || closed) {
            return { kind: 'refused' as const, code: 'not_connected' as const, clientTxnId: command.clientTxnId };
          }
          const fence = roomSend;
          if (!fence) return { kind: 'refused' as const, code: 'transport_unavailable' as const, clientTxnId: command.clientTxnId };
          const permit = await fence.acquire(command.clientTxnId).catch(() => null);
          if (permit?.kind === 'refused') return { kind: 'refused' as const,
            code: permit.code, clientTxnId: command.clientTxnId };
          if (permit?.kind === 'held') {
            if (permit.operationId !== 'rotation_required') await fence.rotate(permit.operationId, permit.epoch);
            return { kind: 'refused' as const, code: 'transport_unavailable' as const, clientTxnId: command.clientTxnId };
          }
          if (permit?.kind !== 'granted') return { kind: 'refused' as const, code: 'transport_unavailable' as const, clientTxnId: command.clientTxnId };
          if (deliveryStopped || remoteDenied || closed) {
            await fence.finish(permit.permitId, permit.attempt, { kind: 'cancelled' });
            return { kind: 'refused' as const, code: 'not_connected' as const, clientTxnId: command.clientTxnId };
          }
          const current = await readBinding().catch(() => null);
          const currentAuthority = await sendAuthority();
          if (currentAuthority === 'unavailable') {
            const cancelled = await fence.finish(permit.permitId, permit.attempt, { kind: 'cancelled' }).catch(() => false);
            return cancelled
              ? { kind: 'refused' as const, code: 'transport_unavailable' as const, clientTxnId: command.clientTxnId }
              : { kind: 'outcome_unknown' as const, clientTxnId: command.clientTxnId };
          }
          if (!current || !sameSessionBinding(current, binding)
            || currentAuthority !== 'active' || subscription.state().kind !== 'live'
            || deliveryStopped || remoteDenied || closed) {
            await fence.finish(permit.permitId, permit.attempt, { kind: 'cancelled' });
            return { kind: 'refused' as const, code: 'not_connected' as const, clientTxnId: command.clientTxnId };
          }
          activeSends += 1;
          try {
            const sent = await substrate.send(command.clientTxnId, command.body);
            if (!await fence.finish(permit.permitId, permit.attempt, { kind: 'complete', eventId: sent.eventId })) {
              return { kind: 'outcome_unknown' as const, clientTxnId: command.clientTxnId };
            }
            return { kind: 'accepted' as const, clientTxnId: command.clientTxnId, eventId: sent.eventId };
          } catch {
            await fence.finish(permit.permitId, permit.attempt, { kind: 'unknown' });
            return { kind: 'outcome_unknown' as const, clientTxnId: command.clientTxnId };
          }
          finally {
            activeSends -= 1;
            if (activeSends + activeReleases === 0) for (const wake of sendWaiters.splice(0)) wake();
          }
        } finally {
          inFlightSendTxnIds.delete(command.clientTxnId);
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
        if (remoteDenied) return unavailable('binding_revoked', { bootstrap: 'blocked' });
        if (deliveryStopped) return unavailable('channel_closing', { bootstrap: 'blocked' });
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
        if (manualRoute && held.harness === 'proof-key' && review) {
          // Hosted MCP tools are explicitly invoked by this session. The owner
          // review handler releases to the inbox without starting a model queue.
          return { v: 1 as const, connected: true, binding: held,
            route: 'manual_mcp' as const, sourceCursor: null,
            readiness: { phase: 'ready' as const, prerequisites: { storage: 'ready' as const,
              ...controlled, harness: 'unknown' as const, dispatch: 'blocked' as const,
              review: 'ready' as const, recovery: 'unknown' as const }, errorCode: null },
          };
        }
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
        if (cleanupTimer) clearTimeout(cleanupTimer);
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
    reportOpen(openStage, error);
    const active = subscription as SubscriptionHandle | null;
    const activeMailbox = mailbox as ReturnType<typeof createProductionOwnerMailbox> | null;
    const activePoll = polling as Promise<void> | null;
    const activeReview = review as ReviewControlHandler | null;
    const activeDispatcher = dispatcher as Dispatcher | null;
    const activeHarness = harness as HarnessPort | null;
    activeMailbox?.close();
    if (pollTimer) clearTimeout(pollTimer);
    if (cleanupTimer) clearTimeout(cleanupTimer);
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
