import {
  decodeDeliveryLimits,
  type DeliveryReceipt,
  type HarnessCapabilities,
  OPENCODE_ROUTE_EVIDENCE,
  type SessionBinding,
  openCodePluginCapabilities,
  unknownModeSupportMap,
} from '@khala/contracts/delivery/index';
import type { RoomId } from '@khala/contracts/messaging/ids';
import { describe, expect, it, vi } from 'vitest';
import type { ConnectorRuntime } from '../../runtime/create';
import type { RuntimeStatus } from '../../runtime/status';
import { agentInstallCommand, createAgentPresenceSource } from './presence';

const decodedLimits = decodeDeliveryLimits({ maxSelectionEvents: 32, maxPayloadBytes: 65_536 });
if (!decodedLimits.ok) throw new Error('invalid limits');

const binding = {
  v: 1,
  bindingId: 'binding-1',
  ownerId: 'owner-1',
  agentParticipantId: 'agent-1',
  deviceId: 'device-1',
  harness: 'codex',
  sessionId: 'session-1',
  generation: 3,
} as SessionBinding;

const capabilities: HarnessCapabilities = {
  v: 3,
  harness: 'codex',
  version: '0.154.0',
  adapterVersion: 'native-cli-notification-1',
  support: 'tested',
  existingSession: 'native_cli_queue',
  immediateNotification: 'native_cli_queue',
  busy: 'queue',
  receiptEvidence: ['harness_queued'],
  reconcileByReleaseId: 'unsupported',
  limits: decodedLimits.value,
  evidenceRef: 'docs/evidence/codex-native-cli.md#queue-idle',
  modes: unknownModeSupportMap('test-codex-native', 'Test fixture has no primary mode proof.', '0.154.0'),
  acknowledgement: 'unknown',
};

function status(overrides: Partial<RuntimeStatus> = {}): RuntimeStatus {
  return {
    binding,
    phase: 'ready',
    prerequisites: {
      storage: 'ready', device: 'ready', bootstrap: 'ready', subscription: 'ready',
      controls: 'ready', harness: 'ready', dispatch: 'ready', review: 'blocked', recovery: 'blocked',
    },
    effectivePolicyVersion: 1,
    harnessCapabilities: capabilities,
    errorCode: null,
    ...overrides,
  };
}

function runtime(current: RuntimeStatus): ConnectorRuntime {
  return { async start() {}, status: () => current, async stop() {} };
}

const receipt = {
  v: 1,
  receiptId: 'receipt-1',
  releaseId: 'release-1',
  bindingId: binding.bindingId,
  generation: binding.generation,
  kind: 'context_consumed',
  observedAt: '2026-09-19T12:00:00.000Z',
  source: 'harness',
  evidenceRef: 'context:release-1',
  errorCode: null,
} as DeliveryReceipt;

describe('connector agent presence source', () => {
  it('renders a shell-safe HTTPS connect command and rejects unsafe links', () => {
    expect(agentInstallCommand("https://khala.example/channel/o'wner"))
      .toBe("khala connect 'https://khala.example/channel/o'\"'\"'wner'");
    expect(() => agentInstallCommand('http://khala.example/channel/1')).toThrow('invalid_room_link');
    expect(() => agentInstallCommand('https://user:secret@khala.example/channel/1')).toThrow('invalid_room_link');
  });

  it('projects one content-free connected row from runtime and ledger metadata', async () => {
    const source = createAgentPresenceSource(runtime(status()), {
      identity: async () => ({
        roomId: 'room-1' as RoomId,
        displayName: 'Build agent',
        ownerDisplayName: 'Owner',
      }),
      lastReceipt: async () => receipt,
      installCommand: async () => "khala connect 'https://khala.example/channel/link'",
      subscribe: () => () => undefined,
    }, { now: () => new Date('2026-09-19T12:00:01.000Z') });

    await expect(source.snapshot('room-1' as RoomId, new AbortController().signal)).resolves.toEqual({
      generation: 3,
      agents: [{
        participantId: binding.agentParticipantId,
        displayName: 'Build agent',
        ownerDisplayName: 'Owner',
        connection: 'connected',
        routeLabel: 'Codex CLI',
        lastReceipt: { kind: 'context_consumed', observedAt: receipt.observedAt },
        acknowledgement: 'unknown',
        installCommand: "khala connect 'https://khala.example/channel/link'",
      }],
    });
  });

  it('uses the fallback label and expires stale receipt evidence to offline', async () => {
    const source = createAgentPresenceSource(runtime(status({
      phase: 'degraded',
      prerequisites: { ...status().prerequisites, subscription: 'blocked', dispatch: 'blocked' },
      harnessCapabilities: {
        ...capabilities,
        support: 'experimental',
        existingSession: 'agent_installed_listener',
        immediateNotification: 'agent_installed_listener',
        evidenceRef: null,
      },
    })), {
      identity: async () => ({ roomId: 'room-1' as RoomId, displayName: 'Agent', ownerDisplayName: 'Owner' }),
      lastReceipt: async () => receipt,
      installCommand: async () => 'khala connect link',
      subscribe: () => () => undefined,
    }, { now: () => new Date('2026-09-19T12:01:01.000Z'), staleAfterMs: 30_000 });

    const snapshot = await source.snapshot('room-1' as RoomId, new AbortController().signal);

    expect(snapshot.agents[0]).toMatchObject({ connection: 'offline', routeLabel: 'Khala skill' });
  });

  it('labels the OpenCode plugin route', async () => {
    const source = createAgentPresenceSource(runtime(status({
      harnessCapabilities: openCodePluginCapabilities({
        version: '1.17.10', limits: decodedLimits.value, claims: OPENCODE_ROUTE_EVIDENCE,
      }),
    })), {
      identity: async () => ({ roomId: 'room-1' as RoomId, displayName: 'Agent', ownerDisplayName: 'Owner' }),
      lastReceipt: async () => null,
      installCommand: async () => 'khala connect link',
      subscribe: () => () => undefined,
    });

    const snapshot = await source.snapshot('room-1' as RoomId, new AbortController().signal);

    expect(snapshot.agents[0]).toMatchObject({ routeLabel: 'OpenCode plugin' });
  });

  it('does not expose a binding to another channel and forwards metadata subscriptions', async () => {
    const unsubscribe = vi.fn();
    const subscribe = vi.fn(() => unsubscribe);
    const source = createAgentPresenceSource(runtime(status()), {
      identity: async () => ({ roomId: 'room-1' as RoomId, displayName: 'Agent', ownerDisplayName: 'Owner' }),
      lastReceipt: async () => receipt,
      installCommand: async () => 'khala connect link',
      subscribe,
    });

    await expect(source.snapshot('room-other' as RoomId, new AbortController().signal))
      .resolves.toEqual({ generation: 3, agents: [] });
    const stop = source.subscribe(() => undefined);
    stop();
    expect(subscribe).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it.each([
    ['unknown', status()],
    ['unsupported', status({ harnessCapabilities: { ...capabilities, acknowledgement: 'unsupported' } })],
    ['batch_token_next_call', status({ harnessCapabilities: { ...capabilities, acknowledgement: 'batch_token_next_call' } })],
    // Without a selected capability nothing is known, whatever the receipts say.
    ['unknown', status({ harnessCapabilities: null })],
  ] as const)('carries the selected capability %s unchanged, never inferred from receipts', async (expected, current) => {
    const acknowledged = { ...receipt, v: 2, kind: 'agent_acknowledged', source: 'agent', evidenceRef: 'ack-1', errorCode: null } as const;
    const source = createAgentPresenceSource(runtime(current), {
      identity: async () => ({ roomId: 'room-1' as RoomId, displayName: 'Agent', ownerDisplayName: 'Owner' }),
      lastReceipt: async () => acknowledged,
      installCommand: async () => 'khala connect link',
      subscribe: () => () => undefined,
    });

    const snapshot = await source.snapshot('room-1' as RoomId, new AbortController().signal);

    expect(snapshot.agents[0]).toMatchObject({
      acknowledgement: expected,
      lastReceipt: { kind: 'agent_acknowledged', observedAt: receipt.observedAt },
    });
  });
});
