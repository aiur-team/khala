// U3: future-access evidence cases against a simulated substrate whose sharing policy
// is "share each new event's key with the devices registered when it is sent". This is
// not the selected SDK: G-SUBSTRATE is open, so the live proof with isolated accounts
// belongs to KHA-136 and KHA-138. A pass here proves only that the module drives the
// ports in the order that policy needs.

import type {
  BindingId, ControlRecord, ControlStore, DeviceId, JsonValue, OwnerId, WriteResult,
} from '@khala/contracts/messaging/index';
import { describe, expect, it } from 'vitest';
import { type RevocationControlPort, type RevocationTargets, createRevocationService } from './index';
import type { ProtocolRevocationPort } from './reconcile';

const alice = 'owner_alice' as OwnerId;
const laptop = 'device_laptop' as DeviceId;
const phone = 'device_phone' as DeviceId;
const connectorDevice = 'device_connector' as DeviceId;
const claudeBinding = 'binding_claude_1' as BindingId;
const replacementBinding = 'binding_claude_2' as BindingId;

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

/** Endpoint-local state survives removal: the substrate cannot reach into a device. */
type Endpoint = { keys: Set<string>; plaintext: Map<string, string> };

function substrate(devices: readonly DeviceId[]) {
  const registered = new Set(devices);
  const endpoints = new Map<DeviceId, Endpoint>(devices.map(d => [d, { keys: new Set(), plaintext: new Map() }]));
  const ciphertext = new Map<string, string>();
  return {
    registered,
    send(eventId: string, body: string) {
      ciphertext.set(eventId, body);
      for (const device of registered) endpoints.get(device)?.keys.add(eventId);
    },
    /** A device can decrypt only with a key it was sent; decrypted text stays in its local store. */
    decrypt(device: DeviceId, eventId: string): string | null {
      const endpoint = endpoints.get(device)!;
      if (!endpoint.keys.has(eventId)) return endpoint.plaintext.get(eventId) ?? null;
      const body = ciphertext.get(eventId) ?? null;
      if (body !== null) endpoint.plaintext.set(eventId, body);
      return body;
    },
    protocol: {
      async removeDevice({ deviceId }) {
        registered.delete(deviceId);
        return { kind: 'removed' };
      },
      async deviceStatus(deviceId) {
        return { kind: registered.has(deviceId) ? 'present' : 'removed' };
      },
    } satisfies ProtocolRevocationPort,
  };
}

/** Khala control plane: release authority is per binding and generation, and it never carries over. */
function khalaControl() {
  const generations = new Map<string, number>([
    [`device:${laptop}`, 1], [`device:${phone}`, 1], [`device:${connectorDevice}`, 1], [`binding:${claudeBinding}`, 1],
  ]);
  const disabled = new Set<string>();
  const trusted = new Set<string>([`${claudeBinding}@1`]);
  const targets: RevocationTargets = {
    async lookup(subject) {
      const generation = generations.get(`${subject.targetKind}:${subject.targetId}`);
      return generation === undefined ? { kind: 'absent' } : { kind: 'found', ownerId: alice, generation };
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
  };
}

function setup() {
  const sdk = substrate([laptop, phone, connectorDevice]);
  const khala = khalaControl();
  const service = createRevocationService({ ownerId: alice, journal: journal(), targets: khala.targets, control: khala.control, protocol: sdk.protocol });
  return { sdk, khala, service };
}

describe('device revocation future access (simulated substrate)', () => {
  it('stops new access through the revoked device while a separately authorised device keeps receiving', async () => {
    const { sdk, service } = setup();
    sdk.send('event_before', 'before revocation');
    expect(sdk.decrypt(laptop, 'event_before')).toBe('before revocation');

    const result = await service.revoke({ operationId: 'op_laptop', targetKind: 'device', targetId: laptop, expectedGeneration: 1 });
    expect(result.kind === 'ok' && result.value.generation).toBe(2);

    sdk.send('event_after', 'after revocation');
    expect(sdk.decrypt(laptop, 'event_after')).toBeNull();
    expect(sdk.decrypt(phone, 'event_after')).toBe('after revocation');
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
    expect([...sdk.registered].sort()).toEqual([connectorDevice, phone]);
    const status = await service.status('op_laptop');
    expect(status.kind === 'ok' && status.value.limitations).toContain('other_devices_unaffected');
    // Not complete until the laptop itself acknowledges; an offline laptop is not reported stopped.
    expect(status.kind === 'ok' && [status.value.protocol, status.value.endpoint, status.value.state]).toEqual(['confirmed', 'pending', 'partial']);
  });
});

describe('binding revocation (simulated substrate)', () => {
  it('blocks queued release for the binding without touching its device, account or membership', async () => {
    const { sdk, khala, service } = setup();
    // A release queued for the binding before revocation.
    const queued = { bindingId: claudeBinding, generation: 1 };
    expect(khala.mayRelease(queued.bindingId, queued.generation)).toBe(true);

    const result = await service.revoke({ operationId: 'op_binding', targetKind: 'binding', targetId: claudeBinding, expectedGeneration: 1 });
    expect(result.kind === 'ok' && result.value.state).toBe('partial');
    expect(khala.mayRelease(queued.bindingId, queued.generation)).toBe(false);

    // The connector device still receives new events: binding revocation is not device revocation.
    sdk.send('event_after', 'after revocation');
    expect(sdk.decrypt(connectorDevice, 'event_after')).toBe('after revocation');
    const status = await service.status('op_binding');
    expect(status.kind === 'ok' && status.value.limitations).toEqual(
      ['disclosed_content_not_recalled', 'device_keys_unchanged', 'account_and_membership_unchanged'],
    );
  });

  it('gives a replacement binding no inherited trust or queued authority', async () => {
    const { khala, service } = setup();
    await service.revoke({ operationId: 'op_binding', targetKind: 'binding', targetId: claudeBinding, expectedGeneration: 1 });
    khala.rebind(replacementBinding);
    expect(khala.mayRelease(replacementBinding, 1)).toBe(false);
    // The old operation's acknowledgment cannot be satisfied by the replacement.
    const ack = await service.acknowledge({ operationId: 'op_binding', targetKind: 'binding', targetId: replacementBinding, generation: 2 });
    expect(ack).toEqual({ kind: 'ok', value: 'ignored' });
  });
});
