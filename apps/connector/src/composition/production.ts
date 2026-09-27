import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  createDiscovery, createHttpAdmission, createLoopbackOwnership, createPairingOwnership,
  type BootstrapPorts, type SessionClaim, type SessionInspectionPort,
} from '@khala/connector/bootstrap/index';
import type { MatrixDeviceSession } from '@khala/connector/bootstrap/ports';
import { decodeDeliveryLimits, decodeSessionBinding, sameSessionBinding, type SessionBinding } from '@khala/contracts/delivery/index';
import { createBootstrapPersistence } from '@khala/connector/storage/bootstrap';
import { openConnectorStorage } from '@khala/connector/storage/open';
import { createMatrixBootstrapDevice } from '../substrate/bootstrap-device';
import { startProductionSubscription } from './agent/subscription';
import type { SubscriptionHandle } from '@khala/connector/subscription/index';

function productionLimits() {
  const limits = decodeDeliveryLimits({ maxSelectionEvents: 20, maxPayloadBytes: 64 * 1024 });
  if (!limits.ok) throw new Error('invalid_production_limits');
  return limits.value;
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
  session: SessionClaim;
  sessionInspection: (generationFor: (claim: SessionClaim) => Promise<number | null>) => SessionInspectionPort;
  inspectHostedCodexHooks(): Promise<unknown>;
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
  const sessionDirectory = path.join(input.stateDirectory, createHash('sha256').update(JSON.stringify([
    'khala.hosted.session.v1', input.session.harness, input.session.sessionId, input.session.workdir,
  ])).digest('hex'));
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
  const matrix = createMatrixBootstrapDevice({
    stateDirectory: sessionDirectory,
    profileDirectory: path.join(sessionDirectory, 'matrix-profile'),
    browserBundleDirectory: input.browserBundleDirectory,
    browserDriverDirectory: path.join(path.dirname(input.browserBundleDirectory), 'playwright-core'),
  });
  let closed = false;
  let binding: SessionBinding | null = null;
  let subscription: SubscriptionHandle | null = null;

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
    subscription = await startProductionSubscription({
      binding: next, roomId: session.roomId as never, ownerParticipantId: session.ownerParticipantId as never,
      storage, matrix: substrate,
    });
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

  try {
    binding = await readBinding();
    if (binding) {
      const status = await matrix.devices.status(binding.deviceId);
      if (status !== 'ready') throw new Error('matrix_device_not_ready');
      await startIntake(binding);
    }
    const { operations, signer } = await createBootstrapPersistence(storage);
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
          try { await persistBinding(activation.binding); await startIntake(activation.binding); }
          catch { return { kind: 'failed', reason: 'storage_unavailable' }; }
          return result;
        },
      },
      sessions: input.sessionInspection(async claim => {
        if (claim.harness !== input.session.harness || claim.sessionId !== input.session.sessionId
          || claim.workdir !== input.session.workdir) return null;
        if (!binding) return 0;
        return (await readBinding().catch(() => null))?.generation ?? null;
      }),
      operations,
    };
    return {
      ports,
      async send(command: Readonly<{ bindingId: string | null; clientTxnId: string; body: string }>) {
        if (closed || !binding || !subscription || command.bindingId !== binding.bindingId) {
          return { kind: 'refused' as const, code: 'not_connected' as const, clientTxnId: command.clientTxnId };
        }
        const held = await readBinding().catch(() => null);
        if (!held || !sameSessionBinding(held, binding)) {
          return { kind: 'refused' as const, code: 'binding_not_held' as const, clientTxnId: command.clientTxnId };
        }
        const substrate = matrix.substrate();
        if (!substrate) return { kind: 'refused' as const, code: 'transport_unavailable' as const, clientTxnId: command.clientTxnId };
        try {
          const sent = await substrate.send(command.clientTxnId, command.body);
          return { kind: 'accepted' as const, clientTxnId: command.clientTxnId, eventId: sent.eventId };
        } catch { return { kind: 'outcome_unknown' as const, clientTxnId: command.clientTxnId }; }
      },
      async status() {
        if (closed || !binding || !subscription) return { v: 1 as const, connected: false, binding: null, route: 'unavailable' as const, sourceCursor: null };
        const held = await readBinding().catch(() => null);
        if (!held || !sameSessionBinding(held, binding) || !matrix.substrate() || subscription.state().kind !== 'live') {
          return { v: 1 as const, connected: false, binding: null, route: 'unavailable' as const, sourceCursor: null };
        }
        return { v: 1 as const, connected: true, binding: held, route: 'native_cli_queue' as const, sourceCursor: null };
      },
      async listChannels() { return { kind: 'unavailable' as const }; },
      async listAgents() { return { kind: 'unavailable' as const }; },
      inbox: input.openInbox,
      async close() {
        if (closed) return;
        closed = true;
        try { await subscription?.stop(); await matrix.close(); } finally { await storage.close(); }
      },
    };
  } catch (error) {
    const active = subscription as SubscriptionHandle | null;
    try { await active?.stop(); await matrix.close(); } finally { await storage.close(); }
    throw error;
  }
}
