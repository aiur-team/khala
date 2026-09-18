// U1: validation and durable intent. The fakes model the injected ports only; passing
// here proves module behaviour, not any provider capability.

import type {
  BindingId, CallOptions, ControlRecord, ControlStore, DeviceId, JsonValue, OwnerId, RevocationRequest, RevocationSubject,
  WriteResult,
} from '@khala/contracts/messaging/index';
import { sameJsonValue } from '@khala/contracts/messaging/index';
import { describe, expect, it } from 'vitest';
import { decodeOperation, encodeOperation, newOperation } from './operation';
import type { DeviceRemovalResult, ProtocolRevocationPort } from './reconcile';
import {
  type DisableResult, type RevocationControlPort, type RevocationTargets, createRevocationService, journalKey,
} from './service';

const alice = 'owner_alice' as OwnerId;
const bob = 'owner_bob' as OwnerId;
const laptop = 'device_laptop' as DeviceId;
const bobPhone = 'device_bob_phone' as DeviceId;
const binding = 'binding_claude_1' as BindingId;

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

type Target = { ownerId: OwnerId; generation: number; disabledBy: Set<string> };

/** Khala control plane and owner mapping over one table, as a request-lifetime function would see it. */
function memoryControl(entries: readonly (RevocationSubject & { ownerId: OwnerId; generation: number })[]) {
  const table = new Map<string, Target>(entries.map(e => [`${e.targetKind}:${e.targetId}`, { ownerId: e.ownerId, generation: e.generation, disabledBy: new Set() }]));
  const faults: DisableResult['kind'][] = [];
  const calls: string[] = [];
  const targets: RevocationTargets = {
    async lookup(subject) {
      const target = table.get(`${subject.targetKind}:${subject.targetId}`);
      return target ? { kind: 'found', ownerId: target.ownerId, generation: target.generation } : { kind: 'absent' };
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
  };
  return { table, faults, calls, targets, control };
}

type RemovalFault = 'unavailable' | 'lost_applied' | 'lost_not_applied' | 'reauthentication_required';

function memoryProtocol(devices: readonly DeviceId[]) {
  const present = new Set(devices);
  const faults = { remove: [] as RemovalFault[], status: [] as 'unavailable'[] };
  const calls = { remove: 0, status: 0 };
  const protocol: ProtocolRevocationPort = {
    async removeDevice({ deviceId }): Promise<DeviceRemovalResult> {
      calls.remove += 1;
      const fault = faults.remove.shift();
      if (fault === 'unavailable') return { kind: 'unavailable' };
      if (fault === 'reauthentication_required') return { kind: 'refused', reason: fault };
      if (fault === 'lost_not_applied') return { kind: 'outcome_unknown' };
      present.delete(deviceId);
      return fault === 'lost_applied' ? { kind: 'outcome_unknown' } : { kind: 'removed' };
    },
    async deviceStatus(deviceId) {
      calls.status += 1;
      if (faults.status.shift() === 'unavailable') return { kind: 'unavailable' };
      return { kind: present.has(deviceId) ? 'present' : 'removed' };
    },
  };
  return { present, faults, calls, protocol };
}

function world(owner: OwnerId = alice) {
  const journal = memoryJournal();
  const control = memoryControl([
    { targetKind: 'device', targetId: laptop, ownerId: alice, generation: 3 },
    { targetKind: 'binding', targetId: binding, ownerId: alice, generation: 1 },
    { targetKind: 'device', targetId: bobPhone, ownerId: bob, generation: 1 },
  ]);
  const protocol = memoryProtocol([laptop, bobPhone]);
  const service = (ownerId: OwnerId = owner) => createRevocationService({
    ownerId, journal: journal.store, targets: control.targets, control: control.control, protocol: protocol.protocol,
  });
  return { journal, control, protocol, service: service(), serviceFor: service };
}

const revokeLaptop: RevocationRequest = { operationId: 'op_1', targetKind: 'device', targetId: laptop, expectedGeneration: 3 };
const revokeBinding: RevocationRequest = { operationId: 'op_2', targetKind: 'binding', targetId: binding, expectedGeneration: 1 };

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
});

describe('revoke idempotency', () => {
  it('returns the original intent for the same operation ID', async () => {
    const w = world();
    const first = await w.service.revoke(revokeLaptop);
    const again = await w.service.revoke(revokeLaptop);
    expect(first).toEqual({ kind: 'ok', value: { operationId: 'op_1', targetKind: 'device', targetId: laptop, generation: 4, state: 'partial' } });
    expect(again).toEqual(first);
    expect(w.control.calls).toEqual(['op_1']);
    expect(w.protocol.calls.remove).toBe(1);
  });

  it('refuses the same operation ID for a changed target or generation', async () => {
    const w = world();
    await w.service.revoke(revokeLaptop);
    expect(await w.service.revoke({ ...revokeBinding, operationId: 'op_1' })).toEqual({ kind: 'rejected', code: 'operation_mismatch' });
    expect(await w.service.revoke({ ...revokeLaptop, expectedGeneration: 4 })).toEqual({ kind: 'rejected', code: 'operation_mismatch' });
    expect(w.control.table.get(`binding:${binding}`)?.generation).toBe(1);
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
    const status = await w.service.status('op_1');
    expect(status.kind === 'ok' && [status.value.state, status.value.control, status.value.retryable]).toEqual(['failed', 'stale', false]);
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
    w.journal.records.set(key, { key, revision: 'rx', operationId: 'foreign', value: { v: 2 }, expiresAt: null });
    expect(await w.service.revoke(revokeLaptop)).toEqual({ kind: 'unavailable', retryable: true });
    expect(w.control.calls).toEqual([]);
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
    const status = await w.service.status('op_2');
    expect(status.kind === 'ok' && status.value.control).toBe('pending');
  });

  it('never touches the messaging protocol for a binding', async () => {
    const w = world();
    await w.service.revoke(revokeBinding);
    expect(w.protocol.calls).toEqual({ remove: 0, status: 0 });
    const status = await w.service.status('op_2');
    expect(status.kind === 'ok' && status.value.protocol).toBe('not_applicable');
  });
});

describe('reconciliation through the service', () => {
  it('reports local disable and protocol effect separately, then reconciles after a retry', async () => {
    const w = world();
    w.protocol.faults.remove.push('lost_applied');
    w.protocol.faults.status.push('unavailable');
    const first = await w.service.revoke(revokeLaptop);
    expect(first.kind === 'ok' && first.value.state).toBe('propagating');
    const pending = await w.service.status('op_1');
    expect(pending.kind === 'ok' && [pending.value.state, pending.value.control, pending.value.protocol, pending.value.endpoint])
      .toEqual(['protocol_pending', 'disabled', 'unknown', 'pending']);
    // The retry reads status, finds the device gone, and does not remove it twice.
    const second = await w.service.revoke(revokeLaptop);
    expect(second.kind === 'ok' && second.value.state).toBe('partial');
    expect(w.protocol.calls.remove).toBe(1);
    const acked = await w.service.acknowledge({ operationId: 'op_1', targetKind: 'device', targetId: laptop, generation: 4 });
    expect(acked).toEqual({ kind: 'ok', value: 'recorded' });
    expect(await w.service.inspect('op_1')).toEqual({
      kind: 'ok', value: { operationId: 'op_1', targetKind: 'device', targetId: laptop, generation: 4, state: 'complete' },
    });
  });

  it('leaves an offline connector pending and completes on its acknowledgment', async () => {
    const w = world();
    const result = await w.service.revoke(revokeBinding);
    expect(result.kind === 'ok' && result.value.state).toBe('partial');
    const ack = { operationId: 'op_2', targetKind: 'binding' as const, targetId: binding, generation: 2 };
    expect(await w.service.acknowledge({ ...ack, generation: 1 })).toEqual({ kind: 'ok', value: 'ignored' });
    expect(await w.service.acknowledge(ack)).toEqual({ kind: 'ok', value: 'recorded' });
    expect(await w.service.acknowledge(ack)).toEqual({ kind: 'ok', value: 'duplicate' });
    const status = await w.service.status('op_2');
    expect(status.kind === 'ok' && [status.value.state, status.value.retryable]).toEqual(['completed', false]);
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
    const status = await w.service.status('op_1');
    expect(status.kind === 'ok' && status.value.protocol).toBe('confirmed');
  });

  it('does not remove a device that a replacement registered again under the same ID', async () => {
    const w = world();
    w.protocol.faults.remove.push('reauthentication_required');
    const refused = await w.service.revoke(revokeLaptop);
    expect(refused.kind === 'ok' && refused.value.state).toBe('partial');
    // The laptop re-initialises as a new generation before the owner re-authenticates.
    w.control.table.get(`device:${laptop}`)!.generation = 5;
    const retried = await w.service.revoke(revokeLaptop);
    expect(retried.kind === 'ok' && retried.value.state).toBe('partial');
    expect(w.protocol.calls.remove).toBe(1);
    expect(w.protocol.present.has(laptop)).toBe(true);
    const status = await w.service.status('op_1');
    expect(status.kind === 'ok' && [status.value.protocol, status.value.protocolRefusal, status.value.retryable])
      .toEqual(['superseded', null, false]);
  });

  it('defers the protocol step while the target generation cannot be read', async () => {
    const w = world();
    const lookup = w.control.targets.lookup;
    let calls = 0;
    w.control.targets.lookup = async (subject, options?: CallOptions) => (++calls === 2 ? { kind: 'unavailable' } : lookup(subject, options));
    const result = await w.service.revoke(revokeLaptop);
    expect(result.kind === 'ok' && result.value.state).toBe('propagating');
    expect(w.protocol.calls.remove).toBe(0);
    const retried = await w.service.revoke(revokeLaptop);
    expect(retried.kind === 'ok' && retried.value.state).toBe('partial');
  });

  it('asks an endpoint to resend an acknowledgment that arrives before the disable is journaled', async () => {
    const w = world();
    w.control.faults.push('unavailable');
    await w.service.revoke(revokeBinding);
    const ack = { operationId: 'op_2', targetKind: 'binding' as const, targetId: binding, generation: 2 };
    expect(await w.service.acknowledge(ack)).toEqual({ kind: 'unavailable', retryable: true });
    await w.service.revoke(revokeBinding);
    expect(await w.service.acknowledge(ack)).toEqual({ kind: 'ok', value: 'recorded' });
  });

  it('keeps journal keys bounded for maximum-length identifiers', async () => {
    const key = await journalKey('o'.repeat(512) as OwnerId, 'x'.repeat(512));
    expect(key).toMatch(/^revocation\/[0-9a-f]{64}$/);
    expect(await journalKey(alice, 'op_1')).not.toBe(await journalKey(bob, 'op_1'));
  });

  it('asks the endpoint to resend when its acknowledgment cannot be recorded', async () => {
    const w = world();
    await w.service.revoke(revokeBinding);
    w.journal.faults.write.push('unavailable');
    const ack = { operationId: 'op_2', targetKind: 'binding' as const, targetId: binding, generation: 2 };
    expect(await w.service.acknowledge(ack)).toEqual({ kind: 'unavailable', retryable: true });
    expect(await w.service.acknowledge(ack)).toEqual({ kind: 'ok', value: 'recorded' });
  });

  it("ignores acknowledgments for unknown operations and another owner's operations", async () => {
    const w = world();
    await w.service.revoke(revokeBinding);
    const ack = { operationId: 'op_2', targetKind: 'binding' as const, targetId: binding, generation: 2 };
    expect(await w.serviceFor(bob).acknowledge(ack)).toEqual({ kind: 'ok', value: 'ignored' });
    expect(await w.service.acknowledge({ ...ack, operationId: 'op_none' })).toEqual({ kind: 'ok', value: 'ignored' });
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
    const record = newOperation(alice, revokeLaptop);
    expect(decodeOperation(encodeOperation(record))).toEqual(record);
    const value = encodeOperation(record) as Record<string, JsonValue>;
    for (const bad of [
      { ...value, extra: 1 },
      { ...value, v: 2 },
      { ...value, revokedGeneration: 9 },
      { ...value, protocol: 'not_applicable' },
      { ...value, protocol: 'refused' },
      { ...value, protocolRefusal: 'forbidden' },
      { ...value, control: 'maybe' },
      { ...value, seq: -1 },
      { ...value, targetId: '' },
      [value],
      null,
    ]) expect(decodeOperation(bad as JsonValue)).toBeNull();
  });
});
