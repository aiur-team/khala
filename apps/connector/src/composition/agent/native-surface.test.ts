import { expect, test } from 'vitest';
import {
  decodeDeliveryLimits,
  type DeliveryReceipt,
  type HarnessCapabilities,
  type HarnessPort,
} from '@khala/contracts/delivery/index';
import type { RoomId } from '@khala/contracts/messaging/ids';
import {
  makeRelease,
  provenModes,
  seed,
  testPolicy,
  world,
} from '../../../../../packages/connector/src/dispatch/fixtures/fakes';
import { createRuntimeHarnessSelection } from './harnesses';
import { createAgentPresenceSource, agentInstallCommand } from './presence';
import {
  createConnectorRuntime,
  type ConnectorRuntimeFactories,
} from '../../runtime/create';
import { unavailableCapability } from '../../runtime/capabilities';
import { registerAgentHandlers } from '../../../../control/src/composition/agent/handlers';
import { createChannelUiPort } from '../../../../web/src/composition/human/agent-presence';

const decodedLimits = decodeDeliveryLimits({ maxSelectionEvents: 32, maxPayloadBytes: 65_536 });
if (!decodedLimits.ok) throw new Error('invalid limits');

const capabilities: HarnessCapabilities = {
  v: 3,
  harness: 'codex',
  version: '0.154.0',
  adapterVersion: 'native-cli-notification-1',
  support: 'tested',
  existingSession: 'native_cli_queue',
  immediateNotification: 'native_cli_queue',
  busy: 'queue',
  receiptEvidence: ['harness_queued', 'context_consumed'],
  reconcileByReleaseId: 'unsupported',
  limits: decodedLimits.value,
  evidenceRef: 'docs/evidence/codex-native-cli.md#queue-idle',
  // Dispatch delivers only on a route with evidenced support for the binding's effective mode.
  modes: provenModes(),
  acknowledgement: 'batch_token_next_call',
};

test('selected native capability delivers exact released bytes and reaches channel presence without pending content', async () => {
  const pendingPlaintext = 'pending plaintext must never reach an agent-facing surface';
  const releasedBytes = new TextEncoder().encode('approved release bytes');
  const dispatchWorld = await world(testPolicy(), ['binding-integration-1']);
  const release = dispatchWorld.add(makeRelease({
    releaseId: 'release-integration-1',
    bindingId: 'binding-integration-1',
    generation: 2,
    payload: releasedBytes,
  }));
  const { binding } = release.job;
  await dispatchWorld.ledger.transact(tx => tx.setBinding({ binding, revoked: false }));
  const consumed = {
    v: 1,
    receiptId: 'receipt-integration-1',
    releaseId: release.job.releaseId,
    bindingId: binding.bindingId,
    generation: binding.generation,
    kind: 'context_consumed',
    observedAt: '2026-09-19T12:00:00.000Z',
    source: 'harness',
    evidenceRef: 'userMessage:release-integration-1',
    errorCode: null,
  } as DeliveryReceipt;
  let delivered: Uint8Array | null = null;
  let dispatcherIdle: () => Promise<void> = async () => undefined;
  const nativeHarness: HarnessPort = {
    async inspect() { return capabilities; },
    async notify() {},
    async submit({ payload }) { delivered = payload.slice(); return consumed; },
    async reconcile() { return null; },
    async close() {},
  };
  const selected = createRuntimeHarnessSelection(binding, [
    { routeId: 'codex-native', harness: nativeHarness },
  ], { record: async () => 'stored' });
  await expect(selected.inspect()).resolves.toMatchObject({ state: 'ready', routeId: 'codex-native' });
  await seed(dispatchWorld.ledger, release.job);
  const factories: ConnectorRuntimeFactories = {
    openStorage: async () => ({ async close() {} }),
    openDevice: async () => ({ fingerprint: 'fixture-device', async close() {} }),
    bindDeviceIdentity: async () => undefined,
    bootstrap: async () => ({ binding }),
    openSubscription: async () => ({
      state: () => 'ready',
      onStateChange: () => () => undefined,
      async stop() {},
    }),
    loadControls: async () => ({ state: 'ready', version: testPolicy().version }),
    openHarness: async () => selected,
    openDispatcher: async ({ harness }) => {
      const adapter = harness.selected?.();
      if (!adapter) throw new Error('selected_harness_unavailable');
      const dispatcher = dispatchWorld.dispatcher({
        harness: adapter,
        // The selected route reaches its proved boundary at once, reporting its own capabilities.
        boundary: {
          await: async ({ job }) => ({ binding: job.binding, capabilities: await adapter.inspect(job.binding) }),
        },
      });
      dispatcherIdle = () => dispatcher.idle();
      return {
        async reconcilePending() {},
        setEnabled(enabled) { if (enabled) dispatcher.wake(); },
        async stop() { await dispatcher.stop(); },
      };
    },
    registerCapabilities: () => [
      { id: 'controls', state: 'ready', async start() {}, async stop() {} },
      unavailableCapability('review'),
      unavailableCapability('recovery'),
    ],
  };
  const runtime = createConnectorRuntime({ requiredCapabilities: [] }, factories);
  await runtime.start();
  await dispatcherIdle();

  expect(delivered).toEqual(releasedBytes);
  expect(runtime.status()).toMatchObject({
    phase: 'ready',
    harnessCapabilities: { existingSession: 'native_cli_queue' },
  });

  const source = createAgentPresenceSource(runtime, {
    identity: async () => ({
      roomId: 'room-integration-1' as RoomId,
      displayName: 'Integration agent',
      ownerDisplayName: 'Integration owner',
      pendingPlaintext,
    }),
    lastReceipt: async () => consumed,
    installCommand: async () => agentInstallCommand('https://khala.example/rooms/integration'),
    subscribe: () => () => undefined,
  });
  const handler = registerAgentHandlers({
    authorize: async () => 'allowed',
    status: source,
  })[0]!;
  const channel = createChannelUiPort({
    endpoint: 'https://khala.example/api/agent/status',
    fetch: request => handler.handle(new Request(request)),
  });

  const snapshot = await channel.agents('room-integration-1' as RoomId, new AbortController().signal);
  const serialized = JSON.stringify(snapshot);

  expect(snapshot).toMatchObject({
    generation: 2,
    agents: [{
      participantId: binding.agentParticipantId,
      connection: 'connected',
      routeLabel: 'Codex CLI',
      lastReceipt: { kind: 'context_consumed' },
    }],
  });
  expect(serialized).not.toContain(pendingPlaintext);
  await expect(channel.installCommand(binding.agentParticipantId, new AbortController().signal))
    .resolves.toBe("khala connect 'https://khala.example/rooms/integration'");
  await runtime.stop();
});

test('unauthorized channel status never reads connector metadata', async () => {
  let reads = 0;
  const handler = registerAgentHandlers({
    authorize: async () => 'forbidden',
    status: { snapshot: async () => { reads += 1; throw new Error('must not read'); } },
  })[0]!;

  const response = await handler.handle(
    new Request('https://khala.example/api/agent/status?roomId=room-integration-1'),
  );

  expect(response.status).toBe(403);
  expect(reads).toBe(0);
});
