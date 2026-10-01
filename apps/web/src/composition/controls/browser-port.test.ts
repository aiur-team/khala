import { describe, expect, it, vi } from 'vitest';
import {
  type BindingId, type CommandId, type OwnerId, type ParticipantId, type PolicyAck, type PolicySetCommand,
  type ListeningModeCommand, type ListeningModeResult,
  type RoomId, type SessionBinding, decodeDeliveryLimits, unknownModeSupportMap,
} from '@khala/contracts/delivery/index';
import { createAgentControlsController } from '../../features/agent-controls/controller';
import type { HumanRouteContext } from '../human/application';
import { registerHumanCapabilities } from '../human/capabilities';
import { type ControlsClient, createBrowserAgentControlsPort } from './browser-port';
import { registerControls } from './register';
import { createOwnerMailboxControlsClient } from './owner-mailbox-client';

const bindingId = 'binding_b' as BindingId;
const roomId = 'room_controls' as RoomId;
const viewer = 'owner_b' as OwnerId;
const peer = 'participant_a' as ParticipantId;

const binding = (generation = 0): SessionBinding => ({
  v: 1, bindingId, ownerId: viewer, agentParticipantId: 'participant_agent_b' as ParticipantId,
  deviceId: 'device_b' as SessionBinding['deviceId'], harness: 'codex', sessionId: `session_g${generation}`, generation,
});

const limits = (() => {
  const decoded = decodeDeliveryLimits({ maxSelectionEvents: 2, maxPayloadBytes: 4096 });
  if (!decoded.ok) throw new Error('limits');
  return decoded.value;
})();

const capabilities = {
  v: 3, harness: 'codex', version: '1.0.0', adapterVersion: '1.0.0', support: 'tested',
  existingSession: 'khala_hosted_resume', immediateNotification: 'khala_hosted_idle', busy: 'queue',
  receiptEvidence: [], reconcileByReleaseId: 'while_queued', limits, evidenceRef: 'evidence-1',
  modes: unknownModeSupportMap('test-codex-interactive', 'Test fixture has no primary mode proof.', '1.0.0'),
  acknowledgement: 'unknown',
};

function statusBody(overrides: Readonly<{
  generation?: number;
  version?: number | null;
  paused?: boolean | null;
  requested?: unknown;
  extra?: Record<string, unknown>;
}> = {}) {
  const generation = overrides.generation ?? 0;
  const version = overrides.version === undefined ? 3 : overrides.version;
  return {
    v: 1,
    binding: binding(generation),
    bindingStatus: 'active',
    capabilities,
    policy: {
      bindingId, generation, effectiveVersion: version,
      effectiveMode: version === null ? null : 'review',
      paused: overrides.paused === undefined ? (version === null ? null : false) : overrides.paused,
    },
    requested: overrides.requested ?? null,
    busy: false,
    latestReceipt: null,
    listeningUnavailable: null,
    listening: { bindingId, generation, version: 1, requested: 'sync', effective: null,
      effectiveReason: 'unsupported', support: capabilities.modes,
      experimentalGrants: [], hardCancelGrants: [], lastChangedBy: { kind: 'unknown' } },
    ...overrides.extra,
  };
}

function ack(command: PolicySetCommand, overrides: Partial<PolicyAck> = {}): PolicyAck {
  return {
    v: 1, commandId: command.commandId, bindingId, generation: command.expectedBindingGeneration,
    requestedVersion: command.expectedPolicyVersion + 1, effectiveVersion: command.expectedPolicyVersion + 1,
    connectorState: 'effective', errorCode: null, ...overrides,
  };
}

type StatusAnswer = Awaited<ReturnType<ControlsClient['status']>>;
type PolicyAnswer = Awaited<ReturnType<ControlsClient['setPolicy']>>;

function scripted() {
  let status: () => StatusAnswer | Promise<StatusAnswer> = () => ({ kind: 'ok', body: statusBody() });
  let policy: (command: PolicySetCommand) => PolicyAnswer | Promise<PolicyAnswer> =
    command => ({ kind: 'answered', body: ack(command) });
  let listening: (command: ListeningModeCommand) => Awaited<ReturnType<ControlsClient['setListeningMode']>> =
    () => ({ kind: 'lost' });
  let grant: () => Awaited<ReturnType<ControlsClient['setRouteGrant']>> = () => ({ kind: 'lost' });
  const commands: PolicySetCommand[] = [];
  const client: ControlsClient = {
    status: async () => status(),
    async setPolicy(command) {
      commands.push(command);
      return policy(command);
    },
    async setListeningMode(next) { return listening(next); },
    async setRouteGrant() { return grant(); },
  };
  return {
    client,
    commands,
    onStatus(next: typeof status) { status = next; },
    onPolicy(next: typeof policy) { policy = next; },
    onListening(next: typeof listening) { listening = next; },
    onGrant(next: typeof grant) { grant = next; },
  };
}

function command(commandId: string, overrides: Partial<PolicySetCommand> = {}): PolicySetCommand {
  return {
    v: 1, commandId: commandId as CommandId, roomId, bindingId, peerParticipantId: peer, expectedPolicyVersion: 3,
    expectedBindingGeneration: 0, mode: 'review', paused: true, issuedAt: '2026-09-25T10:02:00Z', ...overrides,
  };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('browser agent controls port', () => {
  it('recovers an offline owner status after the same connector completes it', async () => {
    const storageValues = new Map<string, string>();
    const storage = { getItem: (key: string) => storageValues.get(key) ?? null,
      setItem: (key: string, value: string) => { storageValues.set(key, value); },
      removeItem: (key: string) => { storageValues.delete(key); } };
    let operationId = '';
    let completed = false;
    const submissions: string[] = [];
    let submissionsAtCompletion = 0;
    const fetcher: typeof fetch = async (url, init) => {
      if (String(url).endsWith('/submit')) {
        operationId = (JSON.parse(String(init?.body)) as { operationId: string }).operationId;
        submissions.push(operationId);
      } else {
        expect(new URL(String(url)).searchParams.get('operation_id')).toBe(operationId);
        if (completed && submissionsAtCompletion === 0) submissionsAtCompletion = submissions.length;
      }
      return new Response(JSON.stringify({ v: 1, operationId,
        outcome: completed ? { ok: true, status: statusBody() } : null }),
      { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const client = createOwnerMailboxControlsClient({ origin: 'https://khala.example',
      csrf: async () => 'csrf', fetch: fetcher, waitMs: 0, storage });
    const port = createBrowserAgentControlsPort({ client, bindingId, refreshMs: 5 });
    const seen: number[] = [];
    const dispose = port.subscribe(bindingId, snapshot => {
      if (snapshot.policy.effectiveVersion !== null) seen.push(snapshot.policy.effectiveVersion);
    });
    await expect(port.readSnapshot(bindingId)).rejects.toMatchObject({ code: 'waiting_for_agent' });
    expect(submissions).toHaveLength(1);
    completed = true;
    // The observer's next interval reconciles the same ID.
    await vi.waitFor(() => expect(seen).toContain(3));
    expect(submissionsAtCompletion).toBe(1);
    expect([...storageValues.keys()].filter(key => key.includes(':pending:'))).toHaveLength(0);
    dispose();
    port.dispose();
  });
  it('preserves policy controls while the connector listening handler starts', async () => {
    const script = scripted();
    script.onStatus(() => ({ kind: 'ok', body: statusBody({ extra: {
      listening: null, listeningUnavailable: 'connector_starting',
    } }) }));
    const port = createBrowserAgentControlsPort({ client: script.client, bindingId, refreshMs: 0 });
    expect(await port.readSnapshot(bindingId)).toMatchObject({ connection: 'connected',
      policy: { effectiveVersion: 3, effectiveMode: 'review' }, listening: null,
      listeningUnavailableReason: expect.stringContaining('connector is starting') });
    port.dispose();
  });
  it('reads a supported exact listening session and waits for a newer snapshot after set', async () => {
    const script = scripted();
    const support = { status: 'proven' as const, route: 'codex-interactive', testedVersion: '1.0.0',
      evidenceRef: 'proof', evidenceRevision: 'rev-1', reason: null };
    const modes = { steer: support, sync: support, async: capabilities.modes.async };
    let version = 1;
    let requested: 'sync' | 'steer' = 'sync';
    script.onStatus(() => ({ kind: 'ok', body: { ...statusBody(),
      capabilities: { ...capabilities, modes }, listening: {
        bindingId, generation: 0, version, requested, effective: requested,
        effectiveReason: null, support: modes, experimentalGrants: [], hardCancelGrants: [],
        lastChangedBy: version === 1 ? { kind: 'unknown' } : { kind: 'owner', participantId: viewer },
      } } }));
    const port = createBrowserAgentControlsPort({ client: script.client, bindingId, bindingGeneration: 0, refreshMs: 0 });
    expect((await port.readSnapshot(bindingId)).listening?.view).toMatchObject({ version: 1, requested: 'sync', effective: 'sync' });
    script.onListening(next => ({ kind: 'answered', body: { v: 1, commandId: next.commandId,
      bindingId, generation: 0, outcome: 'applied', version: 2,
      requested: 'steer', effective: 'steer', reason: null } satisfies ListeningModeResult }));
    const mode: ListeningModeCommand = { v: 1, commandId: 'mode-command-1' as CommandId,
      bindingId, expectedBindingGeneration: 0, expectedVersion: 1, requested: 'steer',
      issuedAt: '2026-09-25T10:02:00Z' };
    expect(await port.submitListeningMode(mode)).toMatchObject({ outcome: 'applied', version: 2 });
    expect((await port.readSnapshot(bindingId)).listening?.view).toMatchObject({ version: 1, effective: 'sync' });
    version = 2; requested = 'steer';
    expect((await port.readSnapshot(bindingId)).listening?.view).toMatchObject({ version: 2,
      requested: 'steer', effective: 'steer', lastChangedBy: { kind: 'owner' } });
    port.dispose();
  });
  it('reads the enforced policy and never reads a status for another binding or with smuggled fields', async () => {
    const script = scripted();
    const port = createBrowserAgentControlsPort({ client: script.client, bindingId, refreshMs: 0 });
    expect(await port.readSnapshot(bindingId)).toMatchObject({
      connection: 'connected', listening: { view: { requested: 'sync', effective: null } },
      policy: { effectiveVersion: 3, effectiveMode: 'review', paused: false, generation: 0 },
    });
    await expect(port.readSnapshot('binding_x' as BindingId)).rejects.toMatchObject({ code: 'forbidden' });

    script.onStatus(() => ({ kind: 'ok', body: statusBody({ extra: { ownerAuthority: 'x' } }) }));
    await expect(port.readSnapshot(bindingId)).rejects.toMatchObject({ code: 'unavailable' });
    expect(port.observation()).toMatchObject({ connection: 'offline' });
    await expect(port.submitPolicy(command('untrusted-status'))).rejects.toMatchObject({ code: 'unavailable' });
    script.onStatus(() => ({ kind: 'ok', body: { ...statusBody(), binding: { ...binding(), bindingId: 'binding_x' } } }));
    await expect(port.readSnapshot(bindingId)).rejects.toMatchObject({ code: 'unavailable' });
    // An enforced request is never reported as still pending.
    script.onStatus(() => ({
      kind: 'ok',
      body: statusBody({
        requested: { commandId: 'pause-1', version: 3, mode: 'review', paused: true, connectorState: 'pending', errorCode: null },
      }),
    }));
    await expect(port.readSnapshot(bindingId)).rejects.toMatchObject({ code: 'unavailable' });
    port.dispose();
  });

  it('keeps a discovered owner binding pinned to its exact generation', async () => {
    const script = scripted();
    const port = createBrowserAgentControlsPort({ client: script.client, bindingId, bindingGeneration: 0, refreshMs: 0 });
    await port.readSnapshot(bindingId);
    script.onStatus(() => ({ kind: 'ok', body: statusBody({ generation: 1 }) }));
    expect(await port.readSnapshot(bindingId)).toMatchObject({ connection: 'offline', capabilities: null,
      policy: { generation: 0, effectiveVersion: 3 } });
    await expect(port.submitPolicy(command('generation-mismatch', { expectedBindingGeneration: 1 })))
      .rejects.toMatchObject({ code: 'unavailable' });
    await expect(port.submitPolicy(command('old-generation'))).rejects.toMatchObject({ code: 'unavailable' });
    expect(script.commands).toHaveLength(0);
    port.dispose();
  });

  it('keeps null versions null and the last enforced values when the connector is unreachable', async () => {
    const script = scripted();
    script.onStatus(() => ({ kind: 'ok', body: statusBody({ version: null }) }));
    const port = createBrowserAgentControlsPort({ client: script.client, bindingId, refreshMs: 0 });
    expect((await port.readSnapshot(bindingId)).policy).toMatchObject({ effectiveVersion: null, paused: null });

    script.onStatus(() => ({ kind: 'ok', body: statusBody() }));
    await port.readSnapshot(bindingId);
    script.onStatus(() => ({ kind: 'lost' }));
    expect(await port.readSnapshot(bindingId)).toMatchObject({ connection: 'offline', policy: { effectiveVersion: 3 } });
    expect(port.observation()).toMatchObject({ connection: 'offline', effectiveVersion: 3 });

    const fresh = createBrowserAgentControlsPort({ client: script.client, bindingId, refreshMs: 0 });
    await expect(fresh.readSnapshot(bindingId)).rejects.toMatchObject({ code: 'lost' });
    port.dispose();
    fresh.dispose();
  });

  it('returns only an acknowledgment that echoes the exact command; anything else is unknown', async () => {
    const script = scripted();
    const reads = vi.spyOn(script.client, 'status');
    const port = createBrowserAgentControlsPort({ client: script.client, bindingId, refreshMs: 0 });
    expect(await port.submitPolicy(command('pause-1'))).toMatchObject({ commandId: 'pause-1', connectorState: 'effective' });
    await tick();
    const correlatedReads = reads.mock.calls.length;

    script.onPolicy(next => ({ kind: 'answered', body: ack({ ...next, commandId: 'other' as CommandId }) }));
    await expect(port.submitPolicy(command('pause-2'))).rejects.toMatchObject({ code: 'lost' });
    script.onPolicy(() => ({ kind: 'answered', body: { ok: true } }));
    await expect(port.submitPolicy(command('pause-3'))).rejects.toMatchObject({ code: 'lost' });
    script.onPolicy(() => ({ kind: 'lost' }));
    await expect(port.submitPolicy(command('pause-4'))).rejects.toMatchObject({ code: 'lost' });
    expect(reads.mock.calls.length).toBe(correlatedReads);
    await expect(port.submitPolicy(command('pause-5', { bindingId: 'binding_x' as BindingId })))
      .rejects.toMatchObject({ code: 'unavailable' });
    expect(script.commands.map(sent => sent.commandId)).toEqual(['pause-1', 'pause-2', 'pause-3', 'pause-4']);
    // The command carries no owner authority; the transport attaches it out of band.
    expect(Object.keys(script.commands[0]!)).not.toContain('ownerId');
    port.dispose();
  });

  it('keeps a lost listening result unknown and accepts only exact grant replies', async () => {
    const script = scripted();
    const port = createBrowserAgentControlsPort({ client: script.client, bindingId, refreshMs: 0 });
    await expect(port.submitListeningMode({
      v: 1, commandId: 'mode-1' as CommandId, bindingId, expectedBindingGeneration: 0, expectedVersion: 1,
      requested: 'sync', issuedAt: '2026-09-25T10:02:00Z',
    })).rejects.toMatchObject({ code: 'lost' });
    const grantCommand = { v: 1 as const, kind: 'grant_experimental_route' as const,
      commandId: 'grant-1' as CommandId, bindingId, expectedBindingGeneration: 0,
      expectedVersion: 1, mode: 'steer' as const, route: 'codex-steer',
      harnessVersion: '0.154.0', evidenceRevision: 'proof-1', issuedAt: '2026-09-25T10:02:00Z' };
    await expect(port.submitRouteGrant(grantCommand)).rejects.toMatchObject({ code: 'lost' });
    script.onGrant(() => ({ kind: 'answered', body: { commandId: grantCommand.commandId,
      outcome: 'applied', reason: null, view: { ...statusBody().listening, version: 2 } } }));
    await expect(port.submitRouteGrant(grantCommand)).resolves.toEqual({
      commandId: grantCommand.commandId, outcome: 'applied', reason: null,
    });
    script.onGrant(() => ({ kind: 'answered', body: { commandId: grantCommand.commandId,
      outcome: 'applied', reason: null, view: { ...statusBody().listening, bindingId: 'other-binding', version: 2 } } }));
    await expect(port.submitRouteGrant(grantCommand)).rejects.toMatchObject({ code: 'lost' });
    expect(script.commands).toEqual([]);
    port.dispose();
  });

  it('shows a pause as pending while the connector is offline, then effective after reconnect', async () => {
    const script = scripted();
    const port = createBrowserAgentControlsPort({ client: script.client, bindingId, refreshMs: 0 });
    const controller = createAgentControlsController({ agentControls: port }, {
      bindingId, roomId, peerParticipantId: peer, viewerOwnerId: viewer, agentLabel: 'agent-b', roomLabel: 'room',
    }, { createId: () => 'pause-1' });
    await tick();
    expect(controller.getView().controlsAvailable).toBe(true);

    let sent: PolicySetCommand | null = null;
    script.onPolicy(next => {
      sent = next;
      return { kind: 'answered', body: ack(next, { effectiveVersion: null, connectorState: 'offline', errorCode: null }) };
    });
    script.onStatus(() => ({ kind: 'lost' }));
    controller.requestPause(true);
    await tick();
    await tick();
    expect(controller.getView().policy).toMatchObject({
      acknowledgment: 'offline', requestedPaused: true, requestedVersion: 4, effectiveVersion: 3, paused: false,
    });
    expect(sent).toMatchObject({ commandId: 'pause-1', expectedPolicyVersion: 3, mode: 'review', paused: true });

    // Reconnected: the connector enforced version 4 and the status says so.
    script.onStatus(() => ({ kind: 'ok', body: statusBody({ version: 4, paused: true }) }));
    await port.readSnapshot(bindingId);
    await tick();
    expect(controller.getView().policy).toMatchObject({ effectiveVersion: 4, paused: true });
    expect(controller.getView().policy.acknowledgment).not.toBe('offline');
    controller.dispose();
    port.dispose();
  });

  it('publishes nothing after a lost submit, so the same-command retry survives', async () => {
    const script = scripted();
    const port = createBrowserAgentControlsPort({ client: script.client, bindingId, refreshMs: 0 });
    const controller = createAgentControlsController({ agentControls: port }, {
      bindingId, roomId, peerParticipantId: peer, viewerOwnerId: viewer, agentLabel: 'agent-b', roomLabel: 'room',
    }, { createId: () => 'pause-1' });
    await tick();
    script.onPolicy(() => ({ kind: 'lost' }));
    controller.requestPause(true);
    await tick();
    await tick();
    expect(controller.getView().retryAvailable).toBe(true);

    script.onPolicy(next => ({ kind: 'answered', body: ack(next) }));
    controller.retry();
    await tick();
    expect(script.commands.map(sent => [sent.commandId, sent.expectedPolicyVersion]))
      .toEqual([['pause-1', 3], ['pause-1', 3]]);
    controller.dispose();
    port.dispose();
  });

  it('marks a refused read offline for subscribers and abandons a hung read', async () => {
    const script = scripted();
    const port = createBrowserAgentControlsPort({ client: script.client, bindingId, refreshMs: 0, statusTimeoutMs: 5 });
    const seen: string[] = [];
    port.subscribe(bindingId, snapshot => seen.push(snapshot.connection));
    await port.readSnapshot(bindingId);
    script.onStatus(() => ({ kind: 'refused', code: 'unavailable' }));
    await expect(port.readSnapshot(bindingId)).rejects.toMatchObject({ code: 'unavailable' });
    expect(seen).toEqual(['connected', 'offline']);

    script.onStatus(() => new Promise<StatusAnswer>(() => undefined));
    expect(await port.readSnapshot(bindingId)).toMatchObject({ connection: 'offline' });
    script.onStatus(() => ({ kind: 'ok', body: statusBody() }));
    expect(await port.readSnapshot(bindingId)).toMatchObject({ connection: 'connected' });
    port.dispose();
  });

  it('drops a status from an older binding generation', async () => {
    const script = scripted();
    script.onStatus(() => ({ kind: 'ok', body: statusBody({ generation: 1, version: 5 }) }));
    const port = createBrowserAgentControlsPort({ client: script.client, bindingId, refreshMs: 0 });
    await port.readSnapshot(bindingId);
    script.onStatus(() => ({ kind: 'ok', body: statusBody({ generation: 0, version: 9 }) }));
    expect((await port.readSnapshot(bindingId)).policy).toMatchObject({ generation: 1, effectiveVersion: 5 });
    port.dispose();
  });

  it('builds a content-free observation', async () => {
    const script = scripted();
    const port = createBrowserAgentControlsPort({ client: script.client, bindingId, refreshMs: 0 });
    await port.readSnapshot(bindingId);
    const observation = JSON.stringify(port.observation());
    expect(observation).not.toContain('session_g0');
    expect(observation).not.toContain(viewer);
    port.dispose();
  });
});

describe('browser controls registration', () => {
  const context = { principal: { ownerId: viewer } } as unknown as HumanRouteContext;

  it('stays unavailable without the protected transport and keeps the central list intact', () => {
    expect(registerControls().state).toBe('unavailable');
    expect(registerControls().portFor(context, roomId)).toBeNull();
    expect(registerHumanCapabilities().map(capability => capability.id)).toEqual(['review', 'controls', 'recovery']);
  });

  it('disposes every port and observer when the route ends', async () => {
    const script = scripted();
    const status = vi.spyOn(script.client, 'status');
    const capability = registerControls({ client: script.client, bindingFor: () => bindingId, refreshMs: 1 });
    expect(capability.portFor(context, roomId)).toBeNull();
    const attachment = capability.attach(context);
    const port = capability.portFor(context, roomId)!;
    expect(capability.portFor(context, roomId)).toBe(port);
    const listener = vi.fn();
    port.subscribe(bindingId, listener);
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(listener).toHaveBeenCalled();

    attachment.dispose();
    const calls = status.mock.calls.length;
    listener.mockClear();
    await new Promise(resolve => setTimeout(resolve, 5));
    expect(status.mock.calls.length).toBe(calls);
    expect(listener).not.toHaveBeenCalled();
    expect(capability.portFor(context, roomId)).toBeNull();
  });

  it('creates a generation-scoped port only after route attachment for an owner-discovered binding', () => {
    const script = scripted();
    const capability = registerControls({ client: script.client, bindingFor: () => null, refreshMs: 0 });
    const discovered = { bindingId, generation: 0 };
    expect(capability.portFor(context, roomId, discovered)).toBeNull();
    const attachment = capability.attach(context);
    const port = capability.portFor(context, roomId, discovered);
    expect(port).not.toBeNull();
    expect(capability.portFor(context, roomId, discovered)).toBe(port);
    expect(capability.portFor(context, roomId, { bindingId, generation: 1 })).not.toBe(port);
    attachment.dispose();
    expect(capability.portFor(context, roomId, discovered)).toBeNull();
  });
});
