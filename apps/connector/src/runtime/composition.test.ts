import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  decodeDeliveryLimits, type DeliveryReceipt,
  type DeviceId,
  type HarnessPort,
  type SessionBinding,
} from '@khala/contracts/delivery/index';
import { capabilities, receipt, testPolicy } from '../../../../packages/connector/src/dispatch/fixtures/fakes';
import { createDispatcher } from '../../../../packages/connector/src/dispatch/run';
import type { Dispatcher, DispatchLedger } from '../../../../packages/connector/src/dispatch/types';
import {
  createBootstrapOperationStore,
  loadOrCreateBootstrapSigner,
} from '../../../../packages/connector/src/storage/bootstrap';
import { createConnectorDispatchStorage } from '../../../../packages/connector/src/storage/dispatch';
import {
  approval, commandRecord, content, eventRef, pendingInput, release,
} from '../../../../packages/connector/src/storage/fixtures/fakes';
import {
  openConnectorStorage,
  type ConnectorStorage,
} from '../../../../packages/connector/src/storage/open';
import { sha256Digest } from '../../../../packages/connector/src/storage/payloads';
import { createClaudeHarness } from '../../../../packages/harnesses/src/claude/index';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { unavailableCapability, type ConnectorCapability } from './capabilities';
import {
  createConnectorRuntime,
  type ConnectorRuntimeFactories,
  type RuntimeStoragePort,
} from './create';
import { createRuntimeHarnessAdapter } from './harness';

const decodedLimits = decodeDeliveryLimits({ maxSelectionEvents: 20, maxPayloadBytes: 64 * 1024 });
if (!decodedLimits.ok) throw new Error('invalid test limits');

const binding = {
  v: 1,
  bindingId: 'binding-runtime-1',
  ownerId: 'owner-runtime-1',
  agentParticipantId: 'agent-runtime-1',
  deviceId: 'device-runtime-1',
  harness: 'contract-test',
  sessionId: 'existing-session-1',
  generation: 0,
} as SessionBinding;

const readyControlsCapability: ConnectorCapability = {
  id: 'controls',
  state: 'ready',
  async start() {},
  async stop() {},
};

let scratch: string | undefined;

afterEach(() => {
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
  scratch = undefined;
});

describe('real storage runtime composition', () => {
  it('reopens one signer, device, operation, and binding without duplicate dispatch', async () => {
    // This managed workspace gives `/` a synthetic uid. The storage ownership
    // behavior has dedicated tests; this composition proof uses its non-POSIX path.
    const getuid = Object.getOwnPropertyDescriptor(process, 'getuid');
    const getgid = Object.getOwnPropertyDescriptor(process, 'getgid');
    Object.defineProperty(process, 'getuid', { configurable: true, value: undefined });
    Object.defineProperty(process, 'getgid', { configurable: true, value: undefined });
    try {
      scratch = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'kha133-runtime-'));
      const state = path.join(scratch, 'state');
      let opens = 0;
      let storage: ConnectorStorage | undefined;
      const signerThumbprints: string[] = [];
      const eligibility: boolean[] = [];
      const submittedPayloads: Uint8Array[] = [];
      const submittedReleaseIds: string[] = [];
      let submissions = 0;
      let reconciliations = 0;
      let failPersistence = 0;
      let nextId = 0;
      let activeDispatcher: Dispatcher | undefined;
      const unknownReleaseId = 'release-runtime-unknown';
      const acceptedReleaseId = 'release-runtime-accepted';

      const factories: ConnectorRuntimeFactories = {
        async openStorage() {
          storage = await openConnectorStorage({
            directory: state,
            mode: opens++ === 0 ? 'create' : 'existing',
            limits: decodedLimits.value,
          });
          return storage as ConnectorStorage & RuntimeStoragePort;
        },
        async openDevice() {
          return { fingerprint: 'device-fingerprint-runtime-1', async close() {} };
        },
        async bindDeviceIdentity() {
          const result = await storage!.bindDeviceIdentity({
            deviceId: binding.deviceId as DeviceId,
            fingerprint: 'device-fingerprint-runtime-1',
          });
          if (result.kind !== 'bound' && result.kind !== 'matched') throw new Error(result.kind);
        },
        async bootstrap() {
          const signer = await loadOrCreateBootstrapSigner(storage!);
          signerThumbprints.push(signer.jkt);
          const operations = createBootstrapOperationStore(storage!);
          const current = await operations.load('bootstrap-runtime-1');
          if (current.kind === 'record') return { binding: current.record.binding! };
          const saved = await operations.save({
            v: 1,
            operationId: 'bootstrap-runtime-1',
            fingerprint: 'bootstrap-fingerprint-runtime-1',
            phase: 'connected',
            deviceId: binding.deviceId,
            binding,
          }, null);
          if (saved.kind !== 'saved') throw new Error(saved.kind);
          await storage!.ledger.transaction(tx => tx.putBinding(binding));
          return { binding };
        },
        async openSubscription() {
          return {
            state: () => 'ready',
            onStateChange: () => () => undefined,
            async stop() {},
          };
        },
        async loadControls() {
          return { state: 'ready', version: 1 };
        },
        async openHarness() {
          return { inspect: async () => ({ state: 'ready' }), async close() {} };
        },
        async openDispatcher() {
          const dispatch = createConnectorDispatchStorage(storage!);
          const ledger: DispatchLedger = {
            async transact(work) {
              if (failPersistence > 0) {
                failPersistence -= 1;
                throw new Error('injected receipt persistence failure');
              }
              return dispatch.ledger.transact(work);
            },
          };
          const harness: HarnessPort = {
            async inspect() {
              return capabilities('queue', { harness: binding.harness });
            },
            async notify() {},
            async submit(input): Promise<DeliveryReceipt> {
              submissions += 1;
              submittedPayloads.push(input.payload.slice());
              submittedReleaseIds.push(input.job.releaseId);
              if (input.job.releaseId === unknownReleaseId) {
                // Native acceptance succeeded, but both receipt persistence and the
                // fallback unknown marker fail as if the process died at this boundary.
                failPersistence = 2;
              }
              return receipt(input.job, 'harness_queued');
            },
            async reconcile() {
              reconciliations += 1;
              return null;
            },
            async close() {},
          };
          activeDispatcher = createDispatcher({
            ledger,
            harness,
            approvals: dispatch.approvals,
            payloads: dispatch.payloads,
            digest: async bytes => sha256Digest(bytes),
            clock: { now: () => new Date('2026-09-19T12:00:00.000Z') },
            newId: kind => `${kind}-runtime-${++nextId}`,
            workerId: 'worker-runtime-1',
          });
          return {
            async reconcilePending() {
              const releaseIds = await dispatch.reconciliationReleaseIds();
              // On restart, an accepted record coexists with the ambiguous record.
              // Pin the exact candidates before delegation so accepted work can
              // never be re-reconciled by a widened storage query.
              if (opens > 1) expect(releaseIds).toEqual([unknownReleaseId]);
              for (const releaseId of releaseIds) {
                await activeDispatcher!.reconcile(releaseId);
              }
            },
            setEnabled(enabled) {
              eligibility.push(enabled);
              if (enabled) activeDispatcher!.wake();
            },
            stop: () => activeDispatcher!.stop(),
          };
        },
        registerCapabilities: () => [
          unavailableCapability('review'),
          readyControlsCapability,
          unavailableCapability('recovery'),
        ],
      };

      const first = createConnectorRuntime({ requiredCapabilities: [] }, factories);
      await first.start();
      expect(first.status()).toMatchObject({ phase: 'ready', binding });

      const dispatch = createConnectorDispatchStorage(storage!);
      expect(await dispatch.applyEffectivePolicy({
        binding,
        policy: testPolicy({ version: 1, armedAt: 1 }),
      })).toEqual({ kind: 'applied' });
      const pendingSentinel = 'pending plaintext must never reach the harness';
      const pendingPlaintext = content(pendingSentinel);
      const releasedPayload = content('authenticated released runtime payload');
      const event = eventRef('event-runtime-1', pendingSentinel);
      await storage!.persistPending({
        ...pendingInput('event-runtime-1', pendingSentinel),
        key: {
          roomId: event.roomId,
          eventId: event.eventId,
          recipientBindingId: binding.bindingId,
          recipientGeneration: binding.generation,
        },
      });
      const command = {
        ...approval('approve-runtime-1', [event]),
        bindingId: binding.bindingId,
        expectedBindingGeneration: binding.generation,
      };
      const job = release(command, binding, releasedPayload, unknownReleaseId);
      const revision = await storage!.ledger.transaction(tx => tx.ledgerRevision());
      expect(await storage!.ledger.transaction(tx => tx.putRelease({
        command: { ...commandRecord(command, job.releaseId), ownerId: binding.ownerId },
        job,
        payload: releasedPayload,
        expectedLedgerRevision: revision,
      }))).toEqual({ kind: 'committed' });
      expect(await activeDispatcher!.enqueue(job)).toBe('queued');
      await activeDispatcher!.idle();
      expect(submissions).toBe(1);
      expect(submittedPayloads).toEqual([releasedPayload]);
      expect(submittedPayloads).not.toContainEqual(pendingPlaintext);
      expect(await dispatch.ledger.transact(tx => tx.record(job.releaseId)))
        .toMatchObject({ state: 'dispatching' });

      const acceptedPendingBody = 'second pending plaintext must remain connector-local';
      const acceptedEvent = eventRef('event-runtime-accepted', acceptedPendingBody);
      await storage!.persistPending({
        ...pendingInput('event-runtime-accepted', acceptedPendingBody),
        key: {
          roomId: acceptedEvent.roomId,
          eventId: acceptedEvent.eventId,
          recipientBindingId: binding.bindingId,
          recipientGeneration: binding.generation,
        },
      });
      const acceptedCommand = {
        ...approval('approve-runtime-accepted', [acceptedEvent]),
        bindingId: binding.bindingId,
        expectedBindingGeneration: binding.generation,
      };
      const acceptedPayload = content('authenticated accepted runtime payload');
      const acceptedJob = release(acceptedCommand, binding, acceptedPayload, acceptedReleaseId);
      const acceptedRevision = await storage!.ledger.transaction(tx => tx.ledgerRevision());
      expect(await storage!.ledger.transaction(tx => tx.putRelease({
        command: {
          ...commandRecord(acceptedCommand, acceptedJob.releaseId),
          ownerId: binding.ownerId,
        },
        job: acceptedJob,
        payload: acceptedPayload,
        expectedLedgerRevision: acceptedRevision,
      }))).toEqual({ kind: 'committed' });
      expect(await activeDispatcher!.enqueue(acceptedJob)).toBe('queued');
      await activeDispatcher!.idle();
      expect(submissions).toBe(2);
      expect(submittedPayloads).toEqual([releasedPayload, acceptedPayload]);
      expect(submittedPayloads).not.toContainEqual(pendingPlaintext);
      expect(submittedPayloads).not.toContainEqual(content(acceptedPendingBody));
      expect(await dispatch.ledger.transact(tx => tx.record(acceptedJob.releaseId)))
        .toMatchObject({ state: 'accepted' });
      await first.stop();

      const restarted = createConnectorRuntime({ requiredCapabilities: [] }, factories);
      await restarted.start();
      expect(restarted.status()).toMatchObject({ phase: 'ready', binding });
      expect(signerThumbprints).toHaveLength(2);
      expect(new Set(signerThumbprints).size).toBe(1);
      expect(eligibility.filter(Boolean)).toHaveLength(2);
      expect(submissions).toBe(2);
      expect(submittedReleaseIds.filter(releaseId => releaseId === acceptedReleaseId)).toHaveLength(1);
      expect(reconciliations).toBe(1);
      expect(await createConnectorDispatchStorage(storage!).ledger.transact(tx => tx.record(job.releaseId)))
        .toMatchObject({ state: 'outcome_unknown' });
      expect(await createConnectorDispatchStorage(storage!).ledger.transact(tx => tx.record(acceptedJob.releaseId)))
        .toMatchObject({ state: 'accepted' });
      await restarted.stop();
    } finally {
      if (getuid) Object.defineProperty(process, 'getuid', getuid);
      if (getgid) Object.defineProperty(process, 'getgid', getgid);
    }
  });

  it('keeps the real Claude adapter unsupported without calling its route', async () => {
    const routeSubmit = vi.fn(async () => ({ status: 'not_sent' as const }));
    const claudeBinding = { ...binding, harness: 'claude' };
    const adapter = createClaudeHarness({
      probe: {
        installedVersion: async () => '2.1.276',
        session: async () => 'present',
      },
      route: { submit: routeSubmit },
      clock: { now: () => new Date('2026-09-19T12:00:00.000Z') },
      limits: decodedLimits.value,
    });
    const factories: ConnectorRuntimeFactories = {
      openStorage: async () => ({ async close() {} }),
      openDevice: async () => ({ fingerprint: 'claude-device', async close() {} }),
      bindDeviceIdentity: async () => undefined,
      bootstrap: async () => ({ binding: claudeBinding }),
      openSubscription: async () => ({
        state: () => 'ready',
        onStateChange: () => () => undefined,
        async stop() {},
      }),
      loadControls: async () => ({ state: 'ready', version: 1 }),
      openHarness: async () => createRuntimeHarnessAdapter(claudeBinding, adapter),
      openDispatcher: async () => ({
        async reconcilePending() {},
        setEnabled() {},
        async stop() {},
      }),
      registerCapabilities: () => [
        unavailableCapability('review'),
        readyControlsCapability,
        unavailableCapability('recovery'),
      ],
    };
    const runtime = createConnectorRuntime({ requiredCapabilities: [] }, factories);

    await runtime.start();

    expect(runtime.status()).toMatchObject({
      phase: 'degraded',
      errorCode: 'harness_unsupported',
      prerequisites: { harness: 'unsupported', dispatch: 'blocked' },
    });
    expect(routeSubmit).not.toHaveBeenCalled();
    await runtime.stop();
  });
});
