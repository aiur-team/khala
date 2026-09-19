import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  decodeDeliveryLimits,
  type DeviceId,
  type SessionBinding,
} from '@khala/contracts/delivery/index';
import {
  createBootstrapOperationStore,
  loadOrCreateBootstrapSigner,
} from '../../../../packages/connector/src/storage/bootstrap';
import { createConnectorDispatchStorage } from '../../../../packages/connector/src/storage/dispatch';
import {
  openConnectorStorage,
  type ConnectorStorage,
} from '../../../../packages/connector/src/storage/open';
import { createClaudeHarness } from '../../../../packages/harnesses/src/claude/index';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { unavailableCapability, type ConnectorCapability } from './capabilities';
import {
  createConnectorRuntime,
  type ConnectorRuntimeFactories,
  type RuntimeStoragePort,
} from './create';

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
          return {
            async reconcilePending() {
              expect(await dispatch.reconciliationReleaseIds()).toEqual([]);
            },
            setEnabled(enabled) { eligibility.push(enabled); },
            async stop() {},
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
      await first.stop();

      const restarted = createConnectorRuntime({ requiredCapabilities: [] }, factories);
      await restarted.start();
      expect(restarted.status()).toMatchObject({ phase: 'ready', binding });
      expect(signerThumbprints).toHaveLength(2);
      expect(new Set(signerThumbprints).size).toBe(1);
      expect(eligibility.filter(Boolean)).toHaveLength(2);
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
      openHarness: async () => ({
        async inspect() {
          const capabilities = await adapter.inspect(claudeBinding);
          return { state: capabilities.support === 'unsupported' ? 'unsupported' : 'ready' };
        },
        close: () => adapter.close(),
      }),
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
