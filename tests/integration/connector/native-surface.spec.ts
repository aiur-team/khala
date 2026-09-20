import { expect, test } from '@playwright/test';
import {
  decodeDeliveryLimits,
  type DeliveryReceipt,
  type HarnessCapabilities,
  type HarnessPort,
  type ReleasedJob,
  type SessionBinding,
} from '../../../packages/contracts/src/delivery/index';
import type { RoomId } from '../../../packages/contracts/src/messaging/ids';
import { createRuntimeHarnessSelection } from '../../../apps/connector/src/composition/agent/harnesses';
import { createAgentPresenceSource, agentInstallCommand } from '../../../apps/connector/src/composition/agent/presence';
import {
  createConnectorRuntime,
  type ConnectorRuntimeFactories,
} from '../../../apps/connector/src/runtime/create';
import { unavailableCapability } from '../../../apps/connector/src/runtime/capabilities';
import { registerAgentHandlers } from '../../../apps/control/src/composition/agent/handlers';
import { createRoomUiPort } from '../../../apps/web/src/composition/human/room';

const decodedLimits = decodeDeliveryLimits({ maxSelectionEvents: 32, maxPayloadBytes: 65_536 });
if (!decodedLimits.ok) throw new Error('invalid limits');

const binding = {
  v: 1,
  bindingId: 'binding-integration-1',
  ownerId: 'owner-integration-1',
  agentParticipantId: 'agent-integration-1',
  deviceId: 'device-integration-1',
  harness: 'codex',
  sessionId: 'session-integration-1',
  generation: 2,
} as SessionBinding;

const capabilities: HarnessCapabilities = {
  v: 2,
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
};

const consumed = {
  v: 1,
  receiptId: 'receipt-integration-1',
  releaseId: 'release-integration-1',
  bindingId: binding.bindingId,
  generation: binding.generation,
  kind: 'context_consumed',
  observedAt: '2026-09-19T12:00:00.000Z',
  source: 'harness',
  evidenceRef: 'userMessage:release-integration-1',
  errorCode: null,
} as DeliveryReceipt;

test('selected native capability delivers exact released bytes and reaches room presence without pending content', async () => {
  const pendingPlaintext = 'pending plaintext must never reach an agent-facing surface';
  const releasedBytes = new TextEncoder().encode('approved release bytes');
  let delivered: Uint8Array | null = null;
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
  const job = {
    v: 1,
    releaseId: consumed.releaseId,
    binding,
    policyVersion: 4,
    events: [],
    payloadRef: 'ledger:release/integration-1',
    payloadDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    causalRootId: 'root-integration-1',
  } as unknown as ReleasedJob;
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
    loadControls: async () => ({ state: 'ready', version: 4 }),
    openHarness: async () => selected,
    openDispatcher: async ({ harness }) => ({
      async reconcilePending() {
        const adapter = harness.selected?.();
        if (!adapter) throw new Error('selected_harness_unavailable');
        await adapter.submit({ job, payload: releasedBytes });
      },
      setEnabled() {},
      async stop() {},
    }),
    registerCapabilities: () => [
      { id: 'controls', state: 'ready', async start() {}, async stop() {} },
      unavailableCapability('review'),
      unavailableCapability('recovery'),
    ],
  };
  const runtime = createConnectorRuntime({ requiredCapabilities: [] }, factories);
  await runtime.start();

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
  const room = createRoomUiPort({
    endpoint: 'https://khala.example/api/agent/status',
    fetch: request => handler.handle(new Request(request)),
  });

  const snapshot = await room.agents('room-integration-1' as RoomId, new AbortController().signal);
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
  await expect(room.installCommand(binding.agentParticipantId, new AbortController().signal))
    .resolves.toBe("khala connect 'https://khala.example/rooms/integration'");
  await runtime.stop();
});

test('unauthorized room status never reads connector metadata', async () => {
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
