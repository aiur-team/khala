// U1: validation and durable intent. The fakes model the injected ports only; passing
// here proves module behaviour, not any provider capability.

import type {
  AuthPrincipal, BindingId, CallOptions, ControlRecord, ControlStore, DeviceId, JsonValue, OwnerId, RevocationRequest,
  RevocationSubject, WriteResult,
} from '@khala/contracts/messaging/index';
import { sameJsonValue } from '@khala/contracts/messaging/index';
import { describe, expect, it } from 'vitest';
import { journalKey } from './journal';
import { type ExcludedDevice, decodeOperation, encodeOperation, newOperation } from './operation';
import type { DeviceRemovalResult, ProtocolRevocationPort, SessionRotationResult } from './reconcile';
import {
  type CapabilityRevocationResult, type DisableResult, type RevocationControlPort, type RevocationTargets,
  createAcknowledgmentReceiver, createRevocationService,
} from './service';

const alice = 'owner_alice' as OwnerId;
const bob = 'owner_bob' as OwnerId;
const laptop = 'device_laptop' as DeviceId;
const phone = 'device_phone' as DeviceId;
const bobPhone = 'device_bob_phone' as DeviceId;
const agentDevice = 'device_agent' as DeviceId;
const binding = 'binding_claude_1' as BindingId;

function principal(ownerId: OwnerId): AuthPrincipal {
  return {
    v: 1, ownerId, providerIssuer: 'https://issuer.test', providerSubject: `sub_${ownerId}`,
    verifiedEmail: `${ownerId}@example.test`, sessionExpiresAt: '2099-01-01T00:00:00Z',
  };
}

/** Faults are consumed one per call, in order. `ok` lets a call through. */
type WriteFault = 'ok' | 'unavailable' | 'lost_applied' | 'lost_not_applied' | 'lost_unresolvable';

function memoryJournal() {
  const records = new Map<string, ControlRecord>();
  const writes = new Map<string, Readonly<{ key: string; value: JsonValue }>>();
  const faults = { read: [] as ('unavailable' | 'ok')[], write: [] as WriteFault[] };
  let revision = 0;
  const unresolvable = new Set<string>();
  const store: ControlStore = {
    async read<T extends JsonValue>(key: string) {
      if (faults.read.shift() === 'unavailable') return { kind: 'unavailable' as const };
      const record = records.get(key);
      return record ? { kind: 'record' as const, record: record as ControlRecord<T> } : { kind: 'absent' as const };
    },
    async compareAndSet<T extends JsonValue>(input: Parameters<ControlStore['compareAndSet']>[0]): Promise<WriteResult<T>> {
      const fault = faults.write.shift();
      if (fault === 'unavailable') return { kind: 'unavailable' };
      const prior = writes.get(input.operationId);
      if (prior && (prior.key !== input.key || !sameJsonValue(prior.value, input.next.value))) return { kind: 'operation_mismatch' };
      const current = records.get(input.key) ?? null;
      if (prior && current?.operationId === input.operationId) return { kind: 'applied', record: current as ControlRecord<T> };
      if ((current?.revision ?? null) !== input.expectedRevision) return { kind: 'conflict', current: current as ControlRecord<T> | null };
      if (fault === 'lost_not_applied') return { kind: 'outcome_unknown', operationId: input.operationId };
      if (fault === 'lost_unresolvable') {
        // Like a per-key provider, the store claims the write ID even though the write never lands.
        unresolvable.add(input.operationId);
        writes.set(input.operationId, { key: input.key, value: input.next.value });
        return { kind: 'outcome_unknown', operationId: input.operationId };
      }
      revision += 1;
      const record: ControlRecord = { key: input.key, revision: `r${revision}`, operationId: input.operationId, ...input.next };
      records.set(input.key, record);
      writes.set(input.operationId, { key: input.key, value: input.next.value });
      return fault === 'lost_applied' ? { kind: 'outcome_unknown', operationId: input.operationId } : { kind: 'applied', record: record as ControlRecord<T> };
    },
    async resolve<T extends JsonValue>(input: Readonly<{ key: string; operationId: string }>) {
      if (unresolvable.has(input.operationId)) return { kind: 'outcome_unknown' as const, operationId: input.operationId };
      const record = records.get(input.key);
      return record?.operationId === input.operationId
        ? { kind: 'applied' as const, record: record as ControlRecord<T> }
        : { kind: 'not_applied' as const };
    },
  };
  return { store, records, faults };
}

type Target = { ownerId: OwnerId; generation: number; device: ExcludedDevice; disabledBy: Set<string> };
type Entry = RevocationSubject & { ownerId: OwnerId; generation: number; device: ExcludedDevice };

/** Khala control plane and owner mapping over one table, as a request-lifetime function would see it. */
function memoryControl(entries: readonly Entry[]) {
  const table = new Map<string, Target>(entries.map(e => [
    `${e.targetKind}:${e.targetId}`, { ownerId: e.ownerId, generation: e.generation, device: e.device, disabledBy: new Set() },
  ]));
  const faults: DisableResult['kind'][] = [];
  const capabilityFaults: CapabilityRevocationResult['kind'][] = [];
  const calls: string[] = [];
  const revokedCapabilities = new Set<BindingId>();
  const targets: RevocationTargets = {
    async lookup(subject) {
      const target = table.get(`${subject.targetKind}:${subject.targetId}`);
      return target ? { kind: 'found', ownerId: target.ownerId, generation: target.generation, device: target.device } : { kind: 'absent' };
    },
  };
  const control: RevocationControlPort = {
    async disable(input) {
      calls.push(input.operationId);
      const fault = faults.shift();
      if (fault === 'unavailable') return { kind: 'unavailable' };
      const target = table.get(`${input.targetKind}:${input.targetId}`);
      if (!target) return { kind: 'stale' };
      if (!target.disabledBy.has(input.operationId)) {
        if (target.generation !== input.expectedGeneration) return { kind: 'stale' };
        target.generation = input.revokedGeneration;
        target.disabledBy.add(input.operationId);
      }
      return fault === 'outcome_unknown' ? { kind: 'outcome_unknown' } : { kind: 'applied' };
    },
    async revokeAdapterCapability(input) {
      calls.push(`capability:${input.operationId}`);
      const fault = capabilityFaults.shift();
      if (fault === 'unavailable') return { kind: 'unavailable' };
      revokedCapabilities.add(input.bindingId);
      return fault === 'outcome_unknown' ? { kind: 'outcome_unknown' } : { kind: 'applied' };
    },
  };
  return { table, faults, capabilityFaults, calls, revokedCapabilities, targets, control };
}

type RemovalFault = 'unavailable' | 'lost_applied' | 'lost_not_applied' | 'reauthentication_required';

/** Device IDs map to the key registered under them. */
function memoryProtocol(devices: readonly ExcludedDevice[]) {
  const registered = new Map(devices.map(d => [d.deviceId, d.deviceKey]));
  const faults = { remove: [] as RemovalFault[], status: [] as 'unavailable'[], rotate: [] as SessionRotationResult['kind'][] };
  const calls = { remove: 0, status: 0, rotate: 0 };
  const rotated = new Set<string>();
  const protocol: ProtocolRevocationPort = {
    async removeDevice({ deviceId, deviceKey }): Promise<DeviceRemovalResult> {
      calls.remove += 1;
      const fault = faults.remove.shift();
      if (fault === 'unavailable') return { kind: 'unavailable' };
      if (fault === 'reauthentication_required') return { kind: 'refused', reason: fault };
      if (fault === 'lost_not_applied') return { kind: 'outcome_unknown' };
      const current = registered.get(deviceId);
      if (current !== undefined && current !== deviceKey) return { kind: 'replaced' };
      registered.delete(deviceId);
      return fault === 'lost_applied' ? { kind: 'outcome_unknown' } : { kind: 'removed' };
    },
    async deviceStatus({ deviceId, deviceKey }) {
      calls.status += 1;
      if (faults.status.shift() === 'unavailable') return { kind: 'unavailable' };
      const current = registered.get(deviceId);
      return { kind: current === undefined ? 'removed' : current === deviceKey ? 'present' : 'replaced' };
    },
    async rotateSessions({ deviceKey }) {
      calls.rotate += 1;
      const fault = faults.rotate.shift();
      if (fault === 'unavailable') return { kind: 'unavailable' };
      rotated.add(deviceKey);
      return { kind: fault ?? 'rotated' };
    },
  };
  return { registered, faults, calls, rotated, protocol };
}

const laptopDevice = { deviceId: laptop, deviceKey: 'key_laptop_1' };
const phoneDevice = { deviceId: phone, deviceKey: 'key_phone_1' };
const bobPhoneDevice = { deviceId: bobPhone, deviceKey: 'key_bob_phone_1' };
const agent = { deviceId: agentDevice, deviceKey: 'key_agent_1' };

function world(owner: OwnerId = alice) {
  const journal = memoryJournal();
  const control = memoryControl([
    { targetKind: 'device', targetId: laptop, ownerId: alice, generation: 3, device: laptopDevice },
    { targetKind: 'device', targetId: phone, ownerId: alice, generation: 3, device: phoneDevice },
    { targetKind: 'binding', targetId: binding, ownerId: alice, generation: 1, device: agent },
    { targetKind: 'device', targetId: bobPhone, ownerId: bob, generation: 1, device: bobPhoneDevice },
  ]);
  const protocol = memoryProtocol([laptopDevice, phoneDevice, bobPhoneDevice, agent]);
  const service = (ownerId: OwnerId = owner) => createRevocationService({
    principal: principal(ownerId), journal: journal.store, targets: control.targets, control: control.control, protocol: protocol.protocol,
  });
  const receiver = (ownerId: OwnerId = owner) => createAcknowledgmentReceiver({ ownerId, journal: journal.store });
  return { journal, control, protocol, service: service(), serviceFor: service, endpoint: receiver(), endpointFor: receiver };
}

const revokeLaptop: RevocationRequest = { operationId: 'op_1', targetKind: 'device', targetId: laptop, expectedGeneration: 3 };
const revokeBinding: RevocationRequest = { operationId: 'op_2', targetKind: 'binding', targetId: binding, expectedGeneration: 1 };
const laptopAck = { operationId: 'op_1', targetKind: 'device' as const, targetId: laptop, generation: 4 };
const bindingAck = { operationId: 'op_2', targetKind: 'binding' as const, targetId: binding, generation: 2 };

async function statusOf(w: ReturnType<typeof world>, operationId: string) {
  const status = await w.service.status(operationId);
  if (status.kind !== 'ok') throw new Error(`no status for ${operationId}`);
  return status.value;
}

describe('revoke validation', () => {
  it('rejects a wrong owner before any journal write or effect', async () => {
    const w = world(bob);
    expect(await w.service.revoke(revokeLaptop)).toEqual({ kind: 'rejected', code: 'forbidden' });
    expect(w.journal.records.size).toBe(0);
    expect(w.control.calls).toEqual([]);
    expect(w.protocol.calls.remove).toBe(0);
  });

  it('rejects a stale generation before any journal write or effect', async () => {
    const w = world();
    expect(await w.service.revoke({ ...revokeLaptop, expectedGeneration: 2 })).toEqual({ kind: 'rejected', code: 'stale_generation' });
    expect(w.journal.records.size).toBe(0);
    expect(w.control.calls).toEqual([]);
    expect(w.control.table.get(`device:${laptop}`)?.generation).toBe(3);
  });

  it('rejects an unknown target', async () => {
    const w = world();
    expect(await w.service.revoke({ ...revokeLaptop, targetId: 'device_other' as DeviceId })).toEqual({ kind: 'rejected', code: 'not_found' });
  });

  it('never names a device ID as a binding', async () => {
    const w = world();
    const result = await w.service.revoke({ operationId: 'op_x', targetKind: 'binding', targetId: laptop as unknown as BindingId, expectedGeneration: 3 });
    expect(result).toEqual({ kind: 'rejected', code: 'not_found' });
  });

  it('never acts on a device lookup that names another device', async () => {
    const w = world();
    w.control.table.get(`device:${laptop}`)!.device = phoneDevice;
    expect(await w.service.revoke(revokeLaptop)).toEqual({ kind: 'unavailable', retryable: true });
    expect(w.journal.records.size).toBe(0);
  });
});

describe('revoke idempotency', () => {
  it('returns the original intent for the same operation ID', async () => {
    const w = world();
    const first = await w.service.revoke(revokeLaptop);
    const again = await w.service.revoke(revokeLaptop);
    expect(first).toEqual({ kind: 'ok', value: { operationId: 'op_1', targetKind: 'device', targetId: laptop, generation: 4, state: 'partial' } });
    expect(again).toEqual(first);
    expect(w.control.calls).toEqual(['op_1']);
    expect(w.protocol.calls).toEqual({ remove: 1, status: 0, rotate: 1 });
  });

  it('refuses the same operation ID for a changed target or generation', async () => {
    const w = world();
    await w.service.revoke(revokeLaptop);
    expect(await w.service.revoke({ ...revokeBinding, operationId: 'op_1' })).toEqual({ kind: 'rejected', code: 'operation_mismatch' });
    expect(await w.service.revoke({ ...revokeLaptop, expectedGeneration: 4 })).toEqual({ kind: 'rejected', code: 'operation_mismatch' });
    expect(w.control.table.get(`binding:${binding}`)?.generation).toBe(1);
  });

  it("refuses a different intent that collides with an earlier request's unresolved intent write", async () => {
    const w = world();
    // The laptop request's intent write is lost, and the store keeps its claim on the write ID.
    w.journal.faults.write.push('lost_unresolvable');
    expect(await w.service.revoke(revokeLaptop)).toEqual({ kind: 'outcome_unknown', operationId: 'op_1' });
    // The same operation ID for the phone reaches the store with other bytes at the same write ID.
    expect(await w.service.revoke({ ...revokeLaptop, targetId: phone })).toEqual({ kind: 'rejected', code: 'operation_mismatch' });
    expect(w.control.calls).toEqual([]);
    expect(w.protocol.calls.remove).toBe(0);
  });

  it('scopes operation IDs per owner, so another owner can neither see nor occupy them', async () => {
    const w = world();
    await w.service.revoke(revokeLaptop);
    const other = w.serviceFor(bob);
    expect(await other.revoke(revokeLaptop)).toEqual({ kind: 'rejected', code: 'forbidden' });
    expect(await other.inspect('op_1')).toEqual({ kind: 'rejected', code: 'not_found' });
    expect(await other.status('op_1')).toEqual({ kind: 'rejected', code: 'not_found' });
    // Bob's own operation under the same ID is independent of Alice's.
    const bobs = await other.revoke({ operationId: 'op_1', targetKind: 'device', targetId: bobPhone, expectedGeneration: 1 });
    expect(bobs.kind === 'ok' && bobs.value.targetId).toBe(bobPhone);
    const alices = await w.service.inspect('op_1');
    expect(alices.kind === 'ok' && alices.value.targetId).toBe(laptop);
  });

  it('reports a failed target race the same way on every retry', async () => {
    const w = world();
    // The laptop re-initialises between the owner check and the disable.
    const lookup = w.control.targets.lookup;
    w.control.targets.lookup = async (subject, options?: CallOptions) => {
      const found = await lookup(subject, options);
      w.control.table.get(`device:${laptop}`)!.generation = 9;
      return found;
    };
    expect(await w.service.revoke(revokeLaptop)).toEqual({ kind: 'rejected', code: 'stale_generation' });
    expect(await w.service.revoke(revokeLaptop)).toEqual({ kind: 'rejected', code: 'stale_generation' });
    expect(w.protocol.calls.remove).toBe(0);
    expect(await w.service.inspect('op_1')).toEqual({ kind: 'rejected', code: 'not_found' });
    const status = await statusOf(w, 'op_1');
    expect([status.state, status.control, status.retryable]).toEqual(['failed', 'stale', false]);
  });
});

describe('journal before effect', () => {
  it('makes no remote effect when the intent write fails', async () => {
    const w = world();
    w.journal.faults.write.push('unavailable');
    expect(await w.service.revoke(revokeLaptop)).toEqual({ kind: 'unavailable', retryable: true });
    expect(w.control.calls).toEqual([]);
    expect(w.protocol.calls.remove).toBe(0);
  });

  it('makes no remote effect when the intent write cannot be resolved', async () => {
    const w = world();
    w.journal.faults.write.push('lost_unresolvable');
    expect(await w.service.revoke(revokeLaptop)).toEqual({ kind: 'outcome_unknown', operationId: 'op_1' });
    expect(w.control.calls).toEqual([]);
  });

  it('treats a lost intent write that provably did not land as unavailable', async () => {
    const w = world();
    w.journal.faults.write.push('lost_not_applied');
    expect(await w.service.revoke(revokeLaptop)).toEqual({ kind: 'unavailable', retryable: true });
    expect(w.control.calls).toEqual([]);
  });

  it('proceeds when a lost intent write resolves as applied', async () => {
    const w = world();
    w.journal.faults.write.push('lost_applied');
    const result = await w.service.revoke(revokeLaptop);
    expect(result.kind === 'ok' && result.value.state).toBe('partial');
    expect(w.control.calls).toEqual(['op_1']);
  });

  it('holds the protocol step until the disable is journaled', async () => {
    const w = world();
    // The intent lands. The disable applies remotely, but its journal write fails.
    w.journal.faults.write.push('ok', 'unavailable');
    const result = await w.service.revoke(revokeLaptop);
    // Only the journaled state is reported, so revoke and inspect agree.
    expect(result.kind === 'ok' && result.value.state).toBe('pending');
    expect(w.protocol.calls.remove).toBe(0);
    const inspected = await w.service.inspect('op_1');
    expect(inspected.kind === 'ok' && inspected.value.state).toBe('pending');
    // Retrying repeats the idempotent disable, records it, and continues.
    const retried = await w.service.revoke(revokeLaptop);
    expect(retried.kind === 'ok' && retried.value.state).toBe('partial');
    expect(w.control.calls).toEqual(['op_1', 'op_1']);
    expect(w.protocol.calls.remove).toBe(1);
  });

  it('reports an unavailable journal read as unavailable, never as absent', async () => {
    const w = world();
    w.journal.faults.read.push('unavailable');
    expect(await w.service.revoke(revokeLaptop)).toEqual({ kind: 'unavailable', retryable: true });
    w.journal.faults.read.push('unavailable');
    expect(await w.service.inspect('op_1')).toEqual({ kind: 'unavailable', retryable: true });
  });

  it('refuses to act on a journal record it cannot read', async () => {
    const w = world();
    const key = (await journalKey(alice, 'op_1'))!;
    w.journal.records.set(key, { key, revision: 'rx', operationId: 'foreign', value: { v: 1 }, expiresAt: null });
    expect(await w.service.revoke(revokeLaptop)).toEqual({ kind: 'unavailable', retryable: true });
    expect(w.control.calls).toEqual([]);
  });

  it('keeps journal keys bounded for maximum-length identifiers', async () => {
    const key = await journalKey('o'.repeat(512) as OwnerId, 'x'.repeat(512));
    expect(key).toMatch(/^revocation\/[0-9a-f]{64}$/);
    expect(await journalKey(alice, 'op_1')).not.toBe(await journalKey(bob, 'op_1'));
  });
});

describe('local disable', () => {
  it('keeps a request pending when the control plane is unavailable, then resumes by operation ID', async () => {
    const w = world();
    w.control.faults.push('unavailable');
    expect(await w.service.revoke(revokeBinding)).toEqual({
      kind: 'ok', value: { operationId: 'op_2', targetKind: 'binding', targetId: binding, generation: 2, state: 'pending' },
    });
    const retried = await w.service.revoke(revokeBinding);
    expect(retried.kind === 'ok' && retried.value.state).toBe('partial');
    expect(w.control.table.get(`binding:${binding}`)?.generation).toBe(2);
  });

  it('never turns a disable timeout into success', async () => {
    const w = world();
    w.control.faults.push('outcome_unknown');
    const result = await w.service.revoke(revokeBinding);
    expect(result.kind === 'ok' && result.value.state).toBe('pending');
    expect((await statusOf(w, 'op_2')).control).toBe('pending');
  });

  it('recognises its own earlier disable when a retry after a crash reports stale', async () => {
    const w = world();
    // The disable applies, but its journal write fails. The retried disable then reports stale.
    w.journal.faults.write.push('ok', 'unavailable');
    await w.service.revoke(revokeLaptop);
    w.control.table.get(`device:${laptop}`)!.disabledBy.clear();
    const retried = await w.service.revoke(revokeLaptop);
    expect(retried.kind === 'ok' && retried.value.state).toBe('partial');
    const status = await statusOf(w, 'op_1');
    expect([status.control, status.removal, status.rotation]).toEqual(['disabled', 'removed', 'rotated']);
  });

  it('treats a target that disappeared after its disable as converged and still excludes its device', async () => {
    const w = world();
    w.journal.faults.write.push('ok', 'unavailable');
    await w.service.revoke(revokeLaptop);
    w.control.table.delete(`device:${laptop}`);
    const retried = await w.service.revoke(revokeLaptop);
    expect(retried.kind === 'ok' && retried.value.state).toBe('partial');
    expect(w.protocol.registered.has(laptop)).toBe(false);
    expect((await statusOf(w, 'op_1')).control).toBe('disabled');
  });
});

describe('binding revocation', () => {
  it("revokes the adapter capability and excludes the agent's device, but never reports completed", async () => {
    const w = world();
    const result = await w.service.revoke(revokeBinding);
    expect(result.kind === 'ok' && result.value.state).toBe('partial');
    expect(w.control.revokedCapabilities.has(binding)).toBe(true);
    expect(w.protocol.registered.has(agentDevice)).toBe(false);
    expect(w.protocol.rotated.has(agent.deviceKey)).toBe(true);
    expect(await w.endpoint.acknowledge(bindingAck)).toEqual({ kind: 'ok', value: 'recorded' });
    const status = await statusOf(w, 'op_2');
    // Room membership stays out of scope, so the binding stays partial and says why.
    expect([status.state, status.capability, status.removal, status.rotation, status.endpoint, status.retryable])
      .toEqual(['partial', 'revoked', 'removed', 'rotated', 'acknowledged', false]);
    expect(status.limitations).toContain('account_and_membership_unchanged');
  });

  it('keeps a binding retryable until its adapter capability is revoked', async () => {
    const w = world();
    w.control.capabilityFaults.push('outcome_unknown');
    const result = await w.service.revoke(revokeBinding);
    expect(result.kind === 'ok' && result.value.state).toBe('propagating');
    let status = await statusOf(w, 'op_2');
    // The device exclusion does not wait on the capability.
    expect([status.state, status.capability, status.removal, status.retryable]).toEqual(['local_disabled', 'pending', 'removed', true]);
    await w.service.revoke(revokeBinding);
    status = await statusOf(w, 'op_2');
    expect([status.state, status.capability]).toEqual(['partial', 'revoked']);
  });
});

describe('reconciliation through the service', () => {
  it('reports local disable and protocol effect separately, then reconciles after a retry', async () => {
    const w = world();
    w.protocol.faults.remove.push('lost_applied');
    w.protocol.faults.status.push('unavailable');
    const first = await w.service.revoke(revokeLaptop);
    expect(first.kind === 'ok' && first.value.state).toBe('propagating');
    const pending = await statusOf(w, 'op_1');
    expect([pending.state, pending.control, pending.removal, pending.rotation, pending.endpoint])
      .toEqual(['protocol_pending', 'disabled', 'unknown', 'pending', 'pending']);
    // The retry reads status, finds the device gone, does not remove it twice, and rotates.
    const second = await w.service.revoke(revokeLaptop);
    expect(second.kind === 'ok' && second.value.state).toBe('partial');
    expect(w.protocol.calls).toEqual({ remove: 1, status: 2, rotate: 1 });
    expect(await w.endpoint.acknowledge(laptopAck)).toEqual({ kind: 'ok', value: 'recorded' });
    expect(await w.service.inspect('op_1')).toEqual({
      kind: 'ok', value: { operationId: 'op_1', targetKind: 'device', targetId: laptop, generation: 4, state: 'complete' },
    });
  });

  it('does not report the device excluded until its sessions are rotated', async () => {
    const w = world();
    w.protocol.faults.rotate.push('outcome_unknown');
    const first = await w.service.revoke(revokeLaptop);
    expect(first.kind === 'ok' && first.value.state).toBe('propagating');
    await w.endpoint.acknowledge(laptopAck);
    let status = await statusOf(w, 'op_1');
    expect([status.state, status.removal, status.rotation, status.retryable]).toEqual(['protocol_pending', 'removed', 'pending', true]);
    await w.service.revoke(revokeLaptop);
    status = await statusOf(w, 'op_1');
    expect([status.state, status.rotation]).toEqual(['completed', 'rotated']);
    expect(w.protocol.calls).toEqual({ remove: 1, status: 0, rotate: 2 });
  });

  it('never reuses a journal write ID for different content after an unresolvable save', async () => {
    const w = world();
    // The removal response is lost and status is unreadable. Saving `unknown` is lost too,
    // and the store keeps its claim on that write ID.
    w.protocol.faults.remove.push('lost_applied');
    w.protocol.faults.status.push('unavailable');
    w.journal.faults.write.push('ok', 'ok', 'lost_unresolvable');
    const first = await w.service.revoke(revokeLaptop);
    expect(first.kind === 'ok' && first.value.state).toBe('propagating');
    // The next pass learns the device is gone and saves different content at the same position.
    const second = await w.service.revoke(revokeLaptop);
    expect(second.kind === 'ok' && second.value.state).toBe('partial');
    expect((await statusOf(w, 'op_1')).removal).toBe('removed');
  });

  it('still removes a revoked device that reports a higher generation with the same key', async () => {
    const w = world();
    w.protocol.faults.remove.push('reauthentication_required');
    const refused = await w.service.revoke(revokeLaptop);
    expect(refused.kind === 'ok' && refused.value.state).toBe('partial');
    expect((await statusOf(w, 'op_1')).removalRefusal).toBe('reauthentication_required');
    // The revoked laptop re-initialises with its old key before the owner re-authenticates.
    w.control.table.get(`device:${laptop}`)!.generation = 5;
    await w.service.revoke(revokeLaptop);
    expect(w.protocol.registered.has(laptop)).toBe(false);
    const status = await statusOf(w, 'op_1');
    expect([status.removal, status.removalRefusal, status.rotation]).toEqual(['removed', null, 'rotated']);
  });

  it('never removes a new device key registered under the same ID, but still rotates the old key out', async () => {
    const w = world();
    w.protocol.faults.remove.push('reauthentication_required');
    await w.service.revoke(revokeLaptop);
    w.protocol.registered.set(laptop, 'key_laptop_2');
    await w.service.revoke(revokeLaptop);
    expect(w.protocol.registered.get(laptop)).toBe('key_laptop_2');
    expect(w.protocol.rotated.has(laptopDevice.deviceKey)).toBe(true);
    const status = await statusOf(w, 'op_1');
    expect([status.state, status.removal, status.rotation, status.retryable]).toEqual(['partial', 'superseded', 'rotated', false]);
  });
});

describe('endpoint acknowledgments', () => {
  it('leaves an offline endpoint pending and completes a device on its acknowledgment', async () => {
    const w = world();
    const result = await w.service.revoke(revokeLaptop);
    expect(result.kind === 'ok' && result.value.state).toBe('partial');
    expect(await w.endpoint.acknowledge({ ...laptopAck, generation: 3 })).toEqual({ kind: 'ok', value: 'ignored' });
    expect(await w.endpoint.acknowledge(laptopAck)).toEqual({ kind: 'ok', value: 'recorded' });
    expect(await w.endpoint.acknowledge(laptopAck)).toEqual({ kind: 'ok', value: 'duplicate' });
    const status = await statusOf(w, 'op_1');
    expect([status.state, status.retryable]).toEqual(['completed', false]);
  });

  it('asks an endpoint to resend an acknowledgment that arrives before the disable is journaled', async () => {
    const w = world();
    w.control.faults.push('unavailable');
    await w.service.revoke(revokeBinding);
    expect(await w.endpoint.acknowledge(bindingAck)).toEqual({ kind: 'unavailable', retryable: true });
    await w.service.revoke(revokeBinding);
    expect(await w.endpoint.acknowledge(bindingAck)).toEqual({ kind: 'ok', value: 'recorded' });
  });

  it('asks the endpoint to resend when its acknowledgment cannot be recorded', async () => {
    const w = world();
    await w.service.revoke(revokeBinding);
    w.journal.faults.write.push('unavailable');
    expect(await w.endpoint.acknowledge(bindingAck)).toEqual({ kind: 'unavailable', retryable: true });
    expect(await w.endpoint.acknowledge(bindingAck)).toEqual({ kind: 'ok', value: 'recorded' });
  });

  it("ignores acknowledgments for unknown operations and another owner's operations", async () => {
    const w = world();
    await w.service.revoke(revokeBinding);
    expect(await w.endpointFor(bob).acknowledge(bindingAck)).toEqual({ kind: 'ok', value: 'ignored' });
    expect(await w.endpoint.acknowledge({ ...bindingAck, operationId: 'op_none' })).toEqual({ kind: 'ok', value: 'ignored' });
  });

  it('grants an endpoint no revoke or status rights', () => {
    expect(Object.keys(world().endpoint)).toEqual(['acknowledge']);
    expect(Object.keys(world().service).sort()).toEqual(['inspect', 'revoke', 'status']);
  });
});

describe('cancellation', () => {
  it('reports nothing done when aborted before the intent', async () => {
    const w = world();
    const controller = new AbortController();
    controller.abort();
    expect(await w.service.revoke(revokeLaptop, { signal: controller.signal })).toEqual({ kind: 'unavailable', retryable: true });
    expect(w.journal.records.size).toBe(0);
  });

  it('reports outcome_unknown, not cancellation, once the intent exists', async () => {
    const w = world();
    const controller = new AbortController();
    w.control.control.disable = async () => {
      controller.abort();
      return { kind: 'applied' };
    };
    expect(await w.service.revoke(revokeLaptop, { signal: controller.signal })).toEqual({ kind: 'outcome_unknown', operationId: 'op_1' });
    expect(w.protocol.calls.remove).toBe(0);
  });
});

describe('journal record', () => {
  it('round-trips and rejects anything else', () => {
    for (const record of [newOperation(alice, revokeLaptop, laptopDevice), newOperation(alice, revokeBinding, agent)]) {
      expect(decodeOperation(encodeOperation(record))).toEqual(record);
    }
    const value = encodeOperation(newOperation(alice, revokeLaptop, laptopDevice)) as Record<string, JsonValue>;
    for (const bad of [
      { ...value, extra: 1 },
      { ...value, v: 1 },
      { ...value, revokedGeneration: 9 },
      { ...value, deviceId: phone },
      { ...value, deviceKey: '' },
      { ...value, capability: 'pending' },
      { ...value, removal: 'refused' },
      { ...value, removalRefusal: 'forbidden' },
      { ...value, rotation: 'rotated' },
      { ...value, control: 'maybe' },
      { ...value, seq: -1 },
      { ...value, targetId: '' },
      [value],
      null,
    ]) expect(decodeOperation(bad as JsonValue)).toBeNull();
    const binding = encodeOperation(newOperation(alice, revokeBinding, agent)) as Record<string, JsonValue>;
    expect(decodeOperation({ ...binding, capability: 'not_applicable' })).toBeNull();
  });
});
