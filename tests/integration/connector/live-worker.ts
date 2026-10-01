// Child of live.proof.ts. The only release input is a test-only authenticated
// fixture; it is never presented as human browser approval.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { EventRef, HarnessPort, OwnerAuthority, SessionBinding } from '../../../packages/contracts/src/delivery/index';
import { decodeDeliveryLimits } from '../../../packages/contracts/src/delivery/index';
import { createDispatcher } from '../../../packages/connector/src/dispatch/run';
import { createConnectorDispatchStorage } from '../../../packages/connector/src/storage/dispatch';
import { openConnectorStorage } from '../../../packages/connector/src/storage/open';
import { createBootstrapOperationStore, loadOrCreateBootstrapSigner } from '../../../packages/connector/src/storage/bootstrap';
import { sha256Digest } from '../../../packages/connector/src/storage/payloads';
import { openMatrixConnectorSubstrate } from '../../../apps/connector/src/substrate/matrix';
import { startProductionSubscription } from '../../../apps/connector/src/composition/agent/subscription';
import { createHostedCodexHarness } from '../../../apps/connector/src/composition/agent/hosted-codex';
import { createReviewControlHandler } from '../../../apps/connector/src/composition/review/control-handler';
import { openInbox } from '../../../packages/agent-cli/src/cli/inbox';
import { codexMcpSessionInspection, readInstalledCodexVersion } from '../../../packages/agent-cli/src/composition/hosted-session-inspection';
import { inspectHostedCodexHooks } from '../../../packages/agent-cli/src/composition/local-harness-capabilities';
import { setupEnvironment } from '../../../packages/agent-cli/src/setup/environment';
import { stopAfterNativeAcceptance } from './crash-boundary';

type Packet = Readonly<{
  v: 1;
  baseUrl: string;
  roomId: string;
  alice: Readonly<{ user_id: string; device_id: string; access_token: string }>;
  bob: Readonly<{ user_id: string; device_id: string; access_token: string }>;
  eventRef: EventRef;
  withheldRef: EventRef;
  stateDirectory: string;
  matrixProfile: string;
  browserBundleDirectory: string;
  inboxDirectory: string;
  native: Readonly<{ sessionId: string; workdir: string; codexHome: string }>;
  pending: string;
  withheld: string;
  binding: SessionBinding;
}>;

const packetPath = process.env.KHALA_42_PACKET;
if (!packetPath || !path.isAbsolute(packetPath)) throw new Error('packet_missing');
const packet = JSON.parse(await readFile(packetPath, 'utf8')) as Packet;
if (packet.v !== 1 || packet.binding.harness !== 'codex'
  || packet.binding.sessionId !== packet.native.sessionId || packet.binding.deviceId !== packet.bob.device_id
  || process.env.CODEX_HOME !== packet.native.codexHome) throw new Error('packet_invalid');
const mode = process.argv.at(-1);
if (mode !== 'first' && mode !== 'recovery') throw new Error('mode_invalid');
const decoded = decodeDeliveryLimits({ maxSelectionEvents: 20, maxPayloadBytes: 64 * 1024 });
if (!decoded.ok) throw new Error('limits_invalid');
const limits = decoded.value;
const storage = await openConnectorStorage({
  directory: packet.stateDirectory, mode: mode === 'first' ? 'create' : 'existing', limits,
});
let substrate: Awaited<ReturnType<typeof openMatrixConnectorSubstrate>> | null = null;
let subscription: Awaited<ReturnType<typeof startProductionSubscription>> | null = null;
let harness: HarnessPort | null = null;
let dispatcher: ReturnType<typeof createDispatcher> | null = null;
try {
  substrate = await openMatrixConnectorSubstrate({
    baseUrl: packet.baseUrl, userId: packet.bob.user_id, deviceId: packet.bob.device_id,
    accessToken: packet.bob.access_token, roomId: packet.roomId,
    profileDirectory: packet.matrixProfile, browserBundleDirectory: packet.browserBundleDirectory,
    participantIdFor: userId => userId === packet.alice.user_id ? packet.eventRef.authorParticipantId : null,
  });
  assert.equal(substrate.writerLock.kind, mode === 'recovery' ? 'stale_recovered' : 'acquired',
    'restart recovers only the dead Matrix profile writer');
  const identity = await storage.bindDeviceIdentity({
    deviceId: packet.binding.deviceId, fingerprint: substrate.fingerprint,
  });
  assert.ok(identity.kind === 'bound' || identity.kind === 'matched', 'same durable device');
  if (mode === 'first') {
    await assert.rejects(openConnectorStorage({
      directory: packet.stateDirectory, mode: 'existing', limits,
    }), /locked/u, 'only one owner holds the ledger');
  }
  const signer = await loadOrCreateBootstrapSigner(storage);
  assert.ok(signer.jkt);
  const operations = createBootstrapOperationStore(storage);
  const operationId = 'fixture-bootstrap-live';
  const operation = await operations.load(operationId);
  if (mode === 'first') {
    assert.equal(operation.kind, 'absent');
    const saved = await operations.save({
      v: 1, operationId, fingerprint: 'fixture-bootstrap-fingerprint',
      phase: 'connected', deviceId: packet.binding.deviceId, binding: packet.binding,
    }, null);
    assert.equal(saved.kind, 'saved');
  } else {
    assert.equal(operation.kind, 'record');
    if (operation.kind === 'record') assert.deepEqual(operation.record.binding, packet.binding);
  }
  const dispatchStorage = createConnectorDispatchStorage(storage);
  const environment = setupEnvironment(process.env);
  const nativeHooks = await inspectHostedCodexHooks(environment);
  assert.equal(nativeHooks?.modes.sync.status, 'proven', 'installed hook mode must be proven');
  const evidenceRevision = nativeHooks.modes.sync.evidenceRevision;
  assert.ok(evidenceRevision, 'mode evidence revision');
  if (mode === 'first') {
    assert.equal((await storage.ledger.transaction(tx => tx.putBinding(packet.binding))).kind, 'inserted');
    assert.equal((await dispatchStorage.applyEffectivePolicy({
      binding: packet.binding,
      policy: {
        version: 3, armedAt: 3, paused: false, expiresAt: null,
        listening: { version: 1, requested: 'sync', effective: 'sync', evidenceRevision },
      },
    })).kind, 'applied');
  } else {
    const stored = await storage.ledger.transaction(tx => tx.readBinding(packet.binding.bindingId));
    assert.deepEqual(stored, packet.binding, 'exact binding on restart');
  }
  subscription = await startProductionSubscription({
    binding: packet.binding, roomId: packet.roomId as never,
    ownerParticipantId: packet.eventRef.authorParticipantId, storage, matrix: substrate,
    // The original issue expressly permits authenticated base fixture release.
    // The real production authority path is separately covered by #43/#49.
    guard: async () => ({ kind: 'active' }),
  });
  await waitForPending();
  const claim = { harness: 'codex', sessionId: packet.native.sessionId, workdir: packet.native.workdir };
  const inspection = codexMcpSessionInspection({
    session: claim, workdir: claim.workdir,
    readVersion: () => readInstalledCodexVersion(environment),
    generation: async () => packet.binding.generation,
  });
  const core = createHostedCodexHarness({
    binding: packet.binding, claim, sessionInspection: inspection,
    current: async () => {
      const held = await storage.ledger.transaction(tx => tx.readBinding(packet.binding.bindingId));
      const snapshot = await storage.ledger.transaction(tx => tx.readApprovalSnapshot({
        bindingId: packet.binding.bindingId, selection: [],
      }));
      return held !== null && JSON.stringify(held) === JSON.stringify(packet.binding)
        && snapshot?.kind === 'snapshot';
    },
    resolveExecutable: () => environment.probe.resolveExecutable('codex'),
    inspectHooks: () => inspectHostedCodexHooks(environment),
    openInbox: async (bindingId, generation) => openInbox({
      stateDirectory: packet.inboxDirectory, bindingId, generation,
      maxPayloadBytes: 64 * 1024, maxSelectionEvents: 20,
    }),
  });
  let submissions = 0;
  const counting: HarnessPort = {
    inspect: binding => core.inspect(binding),
    notify: (binding, hint) => core.notify(binding, hint),
    async submit(input) { submissions += 1; return core.submit(input); },
    reconcile: job => core.reconcile(job),
    close: () => core.close(),
  };
  harness = mode === 'first' ? stopAfterNativeAcceptance(counting, observation => {
    process.send?.({
      ...observation, deviceFingerprint: substrate!.fingerprint, signerThumbprint: signer.jkt,
    });
  }) : counting;
  const capability = await harness.inspect(packet.binding);
  assert.equal(capability.support, 'tested');
  assert.equal(capability.existingSession, 'native_cli_queue');
  assert.equal(capability.modes.sync.status, 'proven');
  dispatcher = createDispatcher({
    ledger: dispatchStorage.ledger,
    limits: { maxJobsPerCausalRoot: 1, maxConcurrentJobs: 1, busy: 'queue' },
    harness,
    boundary: { await: async ({ job }) => ({
      binding: job.binding, capabilities: await harness!.inspect(job.binding),
    }) },
    approvals: dispatchStorage.approvals, payloads: dispatchStorage.payloads,
    digest: async bytes => sha256Digest(bytes),
    clock: { now: () => new Date() }, newId: kind => kind + '-' + randomUUID(),
    workerId: 'live-' + randomUUID(),
  });
  if (mode === 'recovery') {
    for (const releaseId of await dispatchStorage.reconciliationReleaseIds()) {
      await dispatcher.reconcile(releaseId);
    }
    await dispatcher.idle();
    const record = await dispatchStorage.ledger.transact(tx => tx.record('release-live-1' as never));
    const inbox = await openInbox({
      stateDirectory: packet.inboxDirectory, bindingId: packet.binding.bindingId,
      generation: packet.binding.generation, maxPayloadBytes: 64 * 1024, maxSelectionEvents: 20,
    });
    const listener = await inbox.acquireListener();
    let batch;
    try { batch = await listener.readBatch({ maxBytes: 64 * 1024 }); }
    finally { await listener.release(); }
    const items = batch?.items ?? [];
    const bodies = items.map(item => new TextDecoder().decode(item.payload));
    const withheldSnapshot = await storage.ledger.transaction(tx => tx.readApprovalSnapshot({
      bindingId: packet.binding.bindingId, selection: [packet.withheldRef],
    }));
    process.send?.({
      kind: 'recovered', bindingId: packet.binding.bindingId,
      deviceId: packet.binding.deviceId, sessionId: packet.binding.sessionId,
      deviceFingerprint: substrate.fingerprint, signerThumbprint: signer.jkt,
      bootstrapOperationSame: operation.kind === 'record'
        && JSON.stringify(operation.record.binding) === JSON.stringify(packet.binding),
      recordState: record?.state ?? 'missing', restartSubmissions: submissions,
      inboxReleaseCount: items.filter(item => item.record.releaseId === 'release-live-1').length,
      releasedInInbox: bodies.some(body => body.includes(packet.pending)),
      withheldInInbox: bodies.some(body => body.includes(packet.withheld)),
      pendingStillReviewable: withheldSnapshot?.kind === 'snapshot' && withheldSnapshot.pending.length === 1,
    });
  } else {
    const handler = createReviewControlHandler({
      storage, dispatchStorage, releases: dispatcher, bindingId: packet.binding.bindingId,
      limits, newReleaseId: () => 'release-live-1',
      room: { members: async roomId => roomId === packet.roomId
        ? [packet.eventRef.authorParticipantId, packet.binding.agentParticipantId] : null },
    });
    const authority: OwnerAuthority = {
      ownerId: packet.binding.ownerId, issuer: 'https://fixture.invalid',
      subject: 'disposable-owner', authenticatedAt: new Date().toISOString(),
      authorizationId: 'fixture-authz-live' as never,
    };
    const approved = await handler.approve(authority, {
      v: 1, commandId: 'fixture-approval-live', roomId: packet.roomId,
      bindingId: packet.binding.bindingId, expectedPolicyVersion: 3,
      expectedBindingGeneration: packet.binding.generation,
      selection: [packet.eventRef], issuedAt: new Date().toISOString(),
    });
    assert.deepEqual(approved, { ok: true, releaseIds: ['release-live-1'] },
      'authenticated test-only fixture release');
    // The barrier suspends submit forever. The parent must kill this process.
    await new Promise<void>(() => undefined);
  }
} finally {
  await dispatcher?.stop();
  await harness?.close();
  await subscription?.stop();
  await substrate?.close();
  await storage.close();
}

async function waitForPending(): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt++) {
    const snapshot = await storage.ledger.transaction(tx => tx.readApprovalSnapshot({
      bindingId: packet.binding.bindingId, selection: [packet.eventRef, packet.withheldRef],
    }));
    if (snapshot?.kind === 'snapshot' && snapshot.pending.length === 2
      && subscription?.state().kind === 'live') return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('encrypted_pending_catchup_unavailable');
}
