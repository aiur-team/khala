// U3: future-access evidence cases against a simulated substrate whose senders reuse one
// outbound session, as Megolm does, until it is rotated. A device that holds the session can
// decrypt every later event sent on it. This is not the selected SDK: G-SUBSTRATE is open,
// so the live proof with isolated accounts belongs to KHA-136 and KHA-138. A pass here
// proves only that the module drives the ports in the order that model needs.

import type {
  AuthPrincipal, BindingId, ControlRecord, ControlStore, DeviceId, JsonValue, OwnerId, WriteResult,
} from '@khala/contracts/messaging/index';
import { describe, expect, it } from 'vitest';
import {
  type ExcludedDevice, type ProtocolRevocationPort, type RevocationControlPort, type RevocationTargets,
  createAcknowledgmentReceiver, createRevocationService,
} from './index';

const alice = 'owner_alice' as OwnerId;
const laptop = 'device_laptop' as DeviceId;
const phone = 'device_phone' as DeviceId;
const connectorDevice = 'device_connector' as DeviceId;
const agentDevice = 'device_agent' as DeviceId;
const claudeBinding = 'binding_claude_1' as BindingId;
const replacementBinding = 'binding_claude_2' as BindingId;

const principal: AuthPrincipal = {
  v: 1, ownerId: alice, providerIssuer: 'https://issuer.test', providerSubject: 'sub_alice',
  verifiedEmail: 'alice@example.test', sessionExpiresAt: '2099-01-01T00:00:00Z',
};

const devices: Record<string, ExcludedDevice> = {
  [laptop]: { deviceId: laptop, deviceKey: 'key_laptop' },
  [phone]: { deviceId: phone, deviceKey: 'key_phone' },
  [connectorDevice]: { deviceId: connectorDevice, deviceKey: 'key_connector' },
  [agentDevice]: { deviceId: agentDevice, deviceKey: 'key_agent' },
};

function journal(): ControlStore {
  const records = new Map<string, ControlRecord>();
  let revision = 0;
  return {
    async read<T extends JsonValue>(key: string) {
      const record = records.get(key);
      return record ? { kind: 'record' as const, record: record as ControlRecord<T> } : { kind: 'absent' as const };
    },
    async compareAndSet<T extends JsonValue>(input: Parameters<ControlStore['compareAndSet']>[0]): Promise<WriteResult<T>> {
      const current = records.get(input.key) ?? null;
      if ((current?.revision ?? null) !== input.expectedRevision) return { kind: 'conflict', current: current as ControlRecord<T> | null };
      revision += 1;
      const record: ControlRecord = { key: input.key, revision: `r${revision}`, operationId: input.operationId, ...input.next };
      records.set(input.key, record);
      return { kind: 'applied', record: record as ControlRecord<T> };
    },
    async resolve() {
      return { kind: 'not_applied' as const };
    },
  };
}

/**
 * One room. A session's key goes to every registered device key when the session starts, and to
 * any key registered later, as a sender shares with new devices. Endpoint-local state survives
 * removal: the substrate cannot reach into a device.
 */
function substrate(initial: readonly ExcludedDevice[], adapter: Readonly<{ holdsSends: boolean }> = { holdsSends: true }) {
  const registered = new Map(initial.map(d => [d.deviceId, d.deviceKey]));
  const sessionKeys = new Map<string, Set<number>>(initial.map(d => [d.deviceKey, new Set<number>()]));
  const plaintext = new Map<string, Map<string, string>>();
  const events = new Map<string, Readonly<{ session: number; body: string }>>();
  const holds = new Set<string>();
  const queued: [string, string][] = [];
  let session: number | null = null;
  let sessions = 0;
  let rotationFails = 0;

  function deliver(eventId: string, body: string) {
    if (session === null) session = ++sessions;
    for (const key of registered.values()) sessionKeys.get(key)?.add(session);
    events.set(eventId, { session, body });
  }

  const protocol: ProtocolRevocationPort = {
    async removeDevice({ operationId, deviceId, deviceKey }) {
      if (adapter.holdsSends) holds.add(operationId);
      if (registered.has(deviceId) && registered.get(deviceId) !== deviceKey) return { kind: 'replaced' };
      registered.delete(deviceId);
      return { kind: 'removed' };
    },
    async deviceStatus({ deviceId, deviceKey }) {
      const current = registered.get(deviceId);
      return { kind: current === undefined ? 'removed' : current === deviceKey ? 'present' : 'replaced' };
    },
    async rotateSessions({ operationId }) {
      if (rotationFails > 0) {
        rotationFails -= 1;
        return { kind: 'unavailable' };
      }
      session = null;
      holds.delete(operationId);
      while (holds.size === 0 && queued.length > 0) deliver(...queued.shift()!);
      return { kind: 'rotated' };
    },
  };

  return {
    protocol,
    registered,
    failNextRotation() {
      rotationFails += 1;
    },
    send(eventId: string, body: string) {
      if (holds.size > 0) queued.push([eventId, body]);
      else deliver(eventId, body);
    },
    /** A device decrypts only with a session key it holds; decrypted text stays in its local store. */
    decrypt(device: DeviceId, eventId: string): string | null {
      const key = devices[device]!.deviceKey;
      const local = plaintext.get(key) ?? new Map<string, string>();
      plaintext.set(key, local);
      const event = events.get(eventId);
      if (event === undefined || !sessionKeys.get(key)?.has(event.session)) return local.get(eventId) ?? null;
      local.set(eventId, event.body);
      return event.body;
    },
  };
}

/** Khala control plane: release authority is per binding and generation, and it never carries over. */
function khalaControl() {
  const generations = new Map<string, number>([
    [`device:${laptop}`, 1], [`device:${phone}`, 1], [`device:${connectorDevice}`, 1], [`binding:${claudeBinding}`, 1],
  ]);
  const deviceOf = new Map<string, DeviceId>([[`binding:${claudeBinding}`, agentDevice]]);
  const disabled = new Set<string>();
  const trusted = new Set<string>([`${claudeBinding}@1`]);
  const adapterTokens = new Set<BindingId>([claudeBinding]);
  const targets: RevocationTargets = {
    async lookup(subject) {
      const key = `${subject.targetKind}:${subject.targetId}`;
      const generation = generations.get(key);
      const device = devices[deviceOf.get(key) ?? subject.targetId];
      return generation === undefined || device === undefined ? { kind: 'absent' } : { kind: 'found', ownerId: alice, generation, device };
    },
  };
  const control: RevocationControlPort = {
    async disable(input) {
      const key = `${input.targetKind}:${input.targetId}`;
      if (disabled.has(`${key}:${input.operationId}`)) return { kind: 'applied' };
      if (generations.get(key) !== input.expectedGeneration) return { kind: 'stale' };
      generations.set(key, input.revokedGeneration);
      disabled.add(`${key}:${input.operationId}`);
      return { kind: 'applied' };
    },
    async revokeAdapterCapability(input) {
      adapterTokens.delete(input.bindingId);
      return { kind: 'applied' };
    },
  };
  return {
    targets,
    control,
    rebind(bindingId: BindingId) {
      generations.set(`binding:${bindingId}`, 1);
    },
    /** Queued releases are checked at release time against the binding's current generation. */
    mayRelease(bindingId: BindingId, generation: number): boolean {
      return generations.get(`binding:${bindingId}`) === generation && trusted.has(`${bindingId}@${generation}`);
    },
    adapterAccepts(bindingId: BindingId): boolean {
      return adapterTokens.has(bindingId);
    },
  };
}

function setup(adapter?: Readonly<{ holdsSends: boolean }>) {
  const sdk = substrate([laptop, phone, connectorDevice, agentDevice].map(d => devices[d]!), adapter);
  const khala = khalaControl();
  const store = journal();
  const service = createRevocationService({ principal, journal: store, targets: khala.targets, control: khala.control, protocol: sdk.protocol });
  const endpoint = createAcknowledgmentReceiver({ ownerId: alice, journal: store });
  return { sdk, khala, service, endpoint };
}

describe('device revocation future access (simulated substrate)', () => {
  it('stops new access through the revoked device while a separately authorised device keeps receiving', async () => {
    const { sdk, service } = setup();
    // The laptop holds the room's current outbound session before revocation.
    sdk.send('event_before', 'before revocation');
    expect(sdk.decrypt(laptop, 'event_before')).toBe('before revocation');

    const result = await service.revoke({ operationId: 'op_laptop', targetKind: 'device', targetId: laptop, expectedGeneration: 1 });
    expect(result.kind === 'ok' && result.value.generation).toBe(2);

    sdk.send('event_after', 'after revocation');
    expect(sdk.decrypt(laptop, 'event_after')).toBeNull();
    expect(sdk.decrypt(phone, 'event_after')).toBe('after revocation');
  });

  it('holds sends until rotation, then sends them only on a session the revoked device lacks', async () => {
    const { sdk, service } = setup();
    sdk.send('event_before', 'before revocation');
    sdk.failNextRotation();
    await service.revoke({ operationId: 'op_laptop', targetKind: 'device', targetId: laptop, expectedGeneration: 1 });
    const status = await service.status('op_laptop');
    expect(status.kind === 'ok' && [status.value.state, status.value.removal, status.value.rotation])
      .toEqual(['protocol_pending', 'removed', 'pending']);

    // Removed but not yet rotated: this send must not go out on the laptop's session.
    sdk.send('event_during', 'during revocation');
    expect(sdk.decrypt(phone, 'event_during')).toBeNull();
    await service.revoke({ operationId: 'op_laptop', targetKind: 'device', targetId: laptop, expectedGeneration: 1 });
    expect(sdk.decrypt(laptop, 'event_during')).toBeNull();
    expect(sdk.decrypt(phone, 'event_during')).toBe('during revocation');
  });

  it('shows that removal without rotation would leave the device reading new events', async () => {
    // Control case for the model: an adapter that neither holds nor rotates leaks through session reuse.
    const { sdk } = setup({ holdsSends: false });
    sdk.send('event_before', 'before revocation');
    await sdk.protocol.removeDevice({ operationId: 'op_x', deviceId: laptop, deviceKey: 'key_laptop' });
    sdk.send('event_after', 'after removal only');
    expect(sdk.decrypt(laptop, 'event_after')).toBe('after removal only');
  });

  it('records that content the device already decrypted stays readable there', async () => {
    const { sdk, service } = setup();
    sdk.send('event_before', 'before revocation');
    sdk.decrypt(laptop, 'event_before');
    await service.revoke({ operationId: 'op_laptop', targetKind: 'device', targetId: laptop, expectedGeneration: 1 });

    // Expected limitation, not a failure: removal erases nothing the endpoint holds.
    expect(sdk.decrypt(laptop, 'event_before')).toBe('before revocation');
    const status = await service.status('op_laptop');
    expect(status.kind === 'ok' && status.value.limitations).toContain('disclosed_content_not_recalled');
    expect(status.kind === 'ok' && status.value.limitations).toContain('retained_keys_not_recalled');
  });

  it('accounts for the remaining devices explicitly', async () => {
    const { sdk, service } = setup();
    await service.revoke({ operationId: 'op_laptop', targetKind: 'device', targetId: laptop, expectedGeneration: 1 });
    expect([...sdk.registered.keys()].sort()).toEqual([agentDevice, connectorDevice, phone]);
    const status = await service.status('op_laptop');
    expect(status.kind === 'ok' && status.value.limitations).toContain('other_devices_unaffected');
    // Not complete until the laptop itself acknowledges; an offline laptop is not reported stopped.
    expect(status.kind === 'ok' && [status.value.removal, status.value.rotation, status.value.endpoint, status.value.state])
      .toEqual(['removed', 'rotated', 'pending', 'partial']);
  });
});

describe('binding revocation (simulated substrate)', () => {
  it("cuts the agent off: queued release, adapter tokens and its device's future access", async () => {
    const { sdk, khala, service } = setup();
    sdk.send('event_before', 'before revocation');
    expect(sdk.decrypt(agentDevice, 'event_before')).toBe('before revocation');
    // A release queued for the binding before revocation.
    expect(khala.mayRelease(claudeBinding, 1)).toBe(true);

    const result = await service.revoke({ operationId: 'op_binding', targetKind: 'binding', targetId: claudeBinding, expectedGeneration: 1 });
    expect(result.kind === 'ok' && result.value.state).toBe('partial');
    expect(khala.mayRelease(claudeBinding, 1)).toBe(false);
    expect(khala.adapterAccepts(claudeBinding)).toBe(false);

    sdk.send('event_after', 'after revocation');
    expect(sdk.decrypt(agentDevice, 'event_after')).toBeNull();
    // The owner's connector is a different device and keeps receiving.
    expect(sdk.decrypt(connectorDevice, 'event_after')).toBe('after revocation');
    const status = await service.status('op_binding');
    expect(status.kind === 'ok' && status.value.limitations).toContain('account_and_membership_unchanged');
  });

  it('gives a replacement binding no inherited trust or queued authority', async () => {
    const { khala, service, endpoint } = setup();
    await service.revoke({ operationId: 'op_binding', targetKind: 'binding', targetId: claudeBinding, expectedGeneration: 1 });
    khala.rebind(replacementBinding);
    expect(khala.mayRelease(replacementBinding, 1)).toBe(false);
    // The old operation's acknowledgment cannot be satisfied by the replacement.
    const ack = await endpoint.acknowledge({ operationId: 'op_binding', targetKind: 'binding', targetId: replacementBinding, generation: 2 });
    expect(ack).toEqual({ kind: 'ok', value: 'ignored' });
  });
});
