import { describe, expect, it } from 'vitest';
import {
  type BindingRecord, agentBindingStoreKeys, createAgentBindingStore,
} from './store';
import {
  type BindingId, type CompareAndSetInput, type ControlRecord, type ControlStore, type JsonValue,
  type OwnerId, type ParticipantId, type RoomId, sameJsonValue,
} from '@khala/contracts/messaging/index';

const ownerId = 'owner_a' as OwnerId;
const roomId = 'room_a' as RoomId;
const participantA = 'participant_a' as ParticipantId;
const participantB = 'participant_b' as ParticipantId;

function binding(participantId = participantA, overrides: Partial<BindingRecord['binding']> = {}): BindingRecord {
  return {
    binding: {
      v: 1, bindingId: `binding_${participantId}` as BindingId, ownerId, agentParticipantId: participantId,
      deviceId: 'device_a' as BindingRecord['binding']['deviceId'], harness: 'codex', sessionId: `session_${participantId}`,
      generation: 3, ...overrides,
    },
    revokedGeneration: null,
    capability: 'a'.repeat(43),
  };
}

function fakeStore() {
  const records = new Map<string, ControlRecord>();
  const operations = new Map<string, { key: string; next: CompareAndSetInput['next']; record: ControlRecord }>();
  let revision = 0;
  let loseResponse: ((input: CompareAndSetInput) => boolean) | null = null;
  let beforeWrite: ((input: CompareAndSetInput) => void | Promise<void>) | null = null;
  const store: ControlStore = {
    async read<T extends JsonValue>(key: string) {
      const record = records.get(key);
      return record ? { kind: 'record' as const, record: record as ControlRecord<T> } : { kind: 'absent' as const };
    },
    async compareAndSet<T extends JsonValue>(input: CompareAndSetInput<T>) {
      if (beforeWrite) await beforeWrite(input);
      const prior = operations.get(input.operationId);
      if (prior) {
        const same = prior.key === input.key && prior.next.expiresAt === input.next.expiresAt
          && sameJsonValue(prior.next.value, input.next.value);
        return same ? { kind: 'applied' as const, record: prior.record as ControlRecord<T> } : { kind: 'operation_mismatch' as const };
      }
      const current = records.get(input.key) ?? null;
      if ((current?.revision ?? null) !== input.expectedRevision) return { kind: 'conflict' as const, current: current as ControlRecord<T> | null };
      revision += 1;
      const record: ControlRecord<T> = {
        key: input.key, revision: `r${revision}`, operationId: input.operationId, value: input.next.value, expiresAt: input.next.expiresAt,
      };
      records.set(input.key, record);
      operations.set(input.operationId, { key: input.key, next: input.next, record });
      if (loseResponse?.(input)) {
        loseResponse = null;
        return { kind: 'outcome_unknown' as const, operationId: input.operationId };
      }
      return { kind: 'applied' as const, record };
    },
    async resolve<T extends JsonValue>(input: Readonly<{ key: string; operationId: string }>) {
      const operation = operations.get(input.operationId);
      return operation && operation.key === input.key
        ? { kind: 'applied' as const, record: operation.record as ControlRecord<T> }
        : { kind: 'not_applied' as const };
    },
  };
  const seed = (key: string, value: JsonValue) => {
    revision += 1;
    records.set(key, { key, revision: `r${revision}`, operationId: `seed-${revision}`, value, expiresAt: null });
  };
  return {
    store, seed, value: (key: string) => records.get(key)?.value,
    loseNext: (predicate: (input: CompareAndSetInput) => boolean) => { loseResponse = predicate; },
    beforeEachWrite: (hook: ((input: CompareAndSetInput) => void | Promise<void>) | null) => { beforeWrite = hook; },
  };
}

describe('agent binding store migration', () => {
  it('keeps marker writes disabled by default while reading legacy state', async () => {
    const fake = fakeStore();
    const legacy = binding();
    fake.seed(agentBindingStoreKeys.legacy(ownerId, roomId), legacy);
    const bindings = createAgentBindingStore({ store: fake.store });

    expect(await bindings.findParticipant({ ownerId, roomId, agentParticipantId: participantA })).toEqual({ kind: 'found', record: legacy });
    expect(fake.value(agentBindingStoreKeys.legacy(ownerId, roomId))).toEqual(legacy);
    expect(fake.value(agentBindingStoreKeys.participant(ownerId, roomId, participantA))).toBeUndefined();
  });

  it('does not replace an authoritative legacy record while marker writes are disabled', async () => {
    const fake = fakeStore();
    const legacy = binding();
    const replacement = binding(participantA, { bindingId: 'binding_replacement' as BindingId, generation: 4 });
    fake.seed(agentBindingStoreKeys.legacy(ownerId, roomId), legacy);
    const bindings = createAgentBindingStore({ store: fake.store });

    expect(await bindings.putParticipant({
      ownerId, roomId, agentParticipantId: participantA, expectedBindingId: legacy.binding.bindingId, record: replacement,
    })).toEqual({ kind: 'unavailable' });
    expect(fake.value(agentBindingStoreKeys.legacy(ownerId, roomId))).toEqual(legacy);
  });

  it('migrates the complete legacy record and installs participant-aware locators when activated', async () => {
    const fake = fakeStore();
    const legacy = binding();
    fake.seed(agentBindingStoreKeys.legacy(ownerId, roomId), legacy);
    fake.seed(agentBindingStoreKeys.index(legacy.binding.bindingId), { ownerId, roomId });
    const bindings = createAgentBindingStore({ store: fake.store, legacyMigrationWritesEnabled: true });

    expect(await bindings.findParticipant({ ownerId, roomId, agentParticipantId: participantA })).toEqual({ kind: 'found', record: legacy });
    expect(fake.value(agentBindingStoreKeys.participant(ownerId, roomId, participantA))).toEqual(legacy);
    expect(fake.value(agentBindingStoreKeys.legacy(ownerId, roomId))).toEqual({
      v: 1, kind: 'binding_forward', agentParticipantId: participantA, bindingId: legacy.binding.bindingId,
    });
    expect(fake.value(agentBindingStoreKeys.index(legacy.binding.bindingId))).toEqual({
      v: 1, ownerId, roomId, agentParticipantId: participantA,
    });
    expect(fake.value(agentBindingStoreKeys.session(ownerId, roomId, 'codex', 'session_participant_a'))).toEqual({
      v: 1, ownerId, roomId, harness: 'codex', sessionId: 'session_participant_a', agentParticipantId: participantA,
    });
  });

  it('fails closed on a forwarding marker whose target is missing', async () => {
    const fake = fakeStore();
    fake.seed(agentBindingStoreKeys.legacy(ownerId, roomId), {
      v: 1, kind: 'binding_forward', agentParticipantId: participantA, bindingId: 'binding_missing',
    });
    const bindings = createAgentBindingStore({ store: fake.store });
    expect(await bindings.findParticipant({ ownerId, roomId, agentParticipantId: participantA })).toEqual({ kind: 'unavailable' });
  });

  it('preserves revoked generation and null capability', async () => {
    const fake = fakeStore();
    const legacy = { ...binding(), revokedGeneration: 7, capability: null };
    fake.seed(agentBindingStoreKeys.legacy(ownerId, roomId), legacy);
    const bindings = createAgentBindingStore({ store: fake.store, legacyMigrationWritesEnabled: true });

    expect(await bindings.findParticipant({ ownerId, roomId, agentParticipantId: participantA })).toEqual({ kind: 'found', record: legacy });
    expect(fake.value(agentBindingStoreKeys.participant(ownerId, roomId, participantA))).toEqual(legacy);
  });

  it.each(['copy', 'forward', 'index'] as const)('settles a lost %s response without widening authority', async stage => {
    const fake = fakeStore();
    const legacy = binding();
    const legacyKey = agentBindingStoreKeys.legacy(ownerId, roomId);
    const scopedKey = agentBindingStoreKeys.participant(ownerId, roomId, participantA);
    const indexKey = agentBindingStoreKeys.index(legacy.binding.bindingId);
    fake.seed(legacyKey, legacy);
    fake.loseNext(input => input.key === (stage === 'copy' ? scopedKey : stage === 'forward' ? legacyKey : indexKey));
    const bindings = createAgentBindingStore({ store: fake.store, legacyMigrationWritesEnabled: true });

    expect(await bindings.findParticipant({ ownerId, roomId, agentParticipantId: participantA })).toEqual({ kind: 'found', record: legacy });
    expect(await bindings.findBinding(legacy.binding.bindingId)).toEqual({ kind: 'found', record: legacy });
  });

  it('recopies a concurrent legacy revocation before installing the forwarding marker', async () => {
    const fake = fakeStore();
    const original = binding();
    const revoked = { ...original, revokedGeneration: 4, capability: null };
    const legacyKey = agentBindingStoreKeys.legacy(ownerId, roomId);
    fake.seed(legacyKey, original);
    fake.beforeEachWrite(input => {
      if (input.key !== legacyKey || (input.next.value as { kind?: string }).kind !== 'binding_forward') return;
      fake.beforeEachWrite(null);
      fake.seed(legacyKey, revoked);
    });
    const bindings = createAgentBindingStore({ store: fake.store, legacyMigrationWritesEnabled: true });

    expect(await bindings.findParticipant({ ownerId, roomId, agentParticipantId: participantA })).toEqual({ kind: 'found', record: revoked });
    expect(fake.value(agentBindingStoreKeys.participant(ownerId, roomId, participantA))).toEqual(revoked);
  });

  it('refuses a competing legacy session claim while migration is between copy and forwarding', async () => {
    const fake = fakeStore();
    const legacy = binding();
    const legacyKey = agentBindingStoreKeys.legacy(ownerId, roomId);
    fake.seed(legacyKey, legacy);
    let release!: () => void;
    let reached!: () => void;
    const reachedForward = new Promise<void>(resolve => { reached = resolve; });
    const continueForward = new Promise<void>(resolve => { release = resolve; });
    fake.beforeEachWrite(async input => {
      if (input.key !== legacyKey || (input.next.value as { kind?: string }).kind !== 'binding_forward') return;
      fake.beforeEachWrite(null);
      reached();
      await continueForward;
    });
    const bindings = createAgentBindingStore({ store: fake.store, legacyMigrationWritesEnabled: true });
    const migration = bindings.findParticipant({ ownerId, roomId, agentParticipantId: participantA });
    await reachedForward;

    expect(await bindings.claimSession({
      ownerId, roomId, agentParticipantId: participantB, harness: legacy.binding.harness, sessionId: legacy.binding.sessionId,
    })).toEqual({ kind: 'conflict', agentParticipantId: participantA });
    release();
    expect(await migration).toEqual({ kind: 'found', record: legacy });
  });
});

describe('agent binding store scoped state', () => {
  const address = (agentParticipantId: ParticipantId) => ({ ownerId, roomId, agentParticipantId });

  it('keeps an unrelated legacy participant while creating a second scoped participant', async () => {
    const fake = fakeStore();
    const legacy = binding();
    const second = binding(participantB);
    const legacyKey = agentBindingStoreKeys.legacy(ownerId, roomId);
    fake.seed(legacyKey, legacy);
    const bindings = createAgentBindingStore({ store: fake.store, legacyMigrationWritesEnabled: true });

    expect(await bindings.putParticipant({ ...address(participantB), expectedBindingId: null, record: second })).toEqual({ kind: 'applied', record: second });
    expect(fake.value(legacyKey)).toEqual(legacy);
    expect(await bindings.findParticipant(address(participantA))).toEqual({ kind: 'found', record: legacy });
    expect(await bindings.findParticipant(address(participantB))).toEqual({ kind: 'found', record: second });
  });

  it('converges duplicate creates on one authoritative binding and locator', async () => {
    const fake = fakeStore();
    const first = binding(participantA, { bindingId: 'binding_first' as BindingId });
    const second = binding(participantA, { bindingId: 'binding_second' as BindingId });
    const bindings = createAgentBindingStore({ store: fake.store, legacyMigrationWritesEnabled: true });

    const results = await Promise.all([
      bindings.putParticipant({ ...address(participantA), expectedBindingId: null, record: first }),
      bindings.putParticipant({ ...address(participantA), expectedBindingId: null, record: second }),
    ]);
    const winner = results.find(result => result.kind === 'applied');
    const loser = results.find(result => result.kind === 'conflict');
    expect(winner?.kind).toBe('applied');
    expect(loser).toMatchObject({ kind: 'conflict', record: winner?.record });
    expect(await bindings.findBinding(winner!.record.binding.bindingId)).toEqual({ kind: 'found', record: winner!.record });
    const losingId = winner!.record.binding.bindingId === first.binding.bindingId ? second.binding.bindingId : first.binding.bindingId;
    expect(await bindings.findBinding(losingId)).toEqual({ kind: 'absent' });
  });

  it('refuses participant substitution for one session but permits distinct sessions and participants', async () => {
    const fake = fakeStore();
    const bindings = createAgentBindingStore({ store: fake.store, legacyMigrationWritesEnabled: true });
    expect(await bindings.claimSession({
      ...address(participantA), harness: 'codex', sessionId: 'shared-session',
    })).toEqual({ kind: 'claimed' });
    expect(await bindings.claimSession({
      ...address(participantB), harness: 'codex', sessionId: 'shared-session',
    })).toEqual({ kind: 'conflict', agentParticipantId: participantA });
    expect(await bindings.claimSession({
      ...address(participantB), harness: 'codex', sessionId: 'other-session',
    })).toEqual({ kind: 'claimed' });
  });

  it('replaces one binding, treats its old index as absent, and resolves the new binding', async () => {
    const fake = fakeStore();
    const first = binding();
    const replacement = binding(participantA, { bindingId: 'binding_replacement' as BindingId, generation: 4 });
    const bindings = createAgentBindingStore({ store: fake.store, legacyMigrationWritesEnabled: true });
    expect((await bindings.putParticipant({ ...address(participantA), expectedBindingId: null, record: first })).kind).toBe('applied');
    expect((await bindings.putParticipant({
      ...address(participantA), expectedBindingId: first.binding.bindingId, record: replacement,
    })).kind).toBe('applied');

    expect(await bindings.findBinding(first.binding.bindingId)).toEqual({ kind: 'absent' });
    expect(await bindings.findBinding(replacement.binding.bindingId)).toEqual({ kind: 'found', record: replacement });
  });

  it('updates only the binding resolved by its participant-aware index', async () => {
    const fake = fakeStore();
    const first = binding();
    const second = binding(participantB);
    const bindings = createAgentBindingStore({ store: fake.store, legacyMigrationWritesEnabled: true });
    await bindings.putParticipant({ ...address(participantA), expectedBindingId: null, record: first });
    await bindings.putParticipant({ ...address(participantB), expectedBindingId: null, record: second });

    expect(await bindings.updateBinding(first.binding.bindingId, record => ({ ...record, revokedGeneration: 4, capability: null }))).toBe('applied');
    expect(await bindings.findBinding(first.binding.bindingId)).toEqual({
      kind: 'found', record: { ...first, revokedGeneration: 4, capability: null },
    });
    expect(await bindings.findBinding(second.binding.bindingId)).toEqual({ kind: 'found', record: second });
  });

  it('refuses a mutation that changes immutable binding identity', async () => {
    const fake = fakeStore();
    const first = binding();
    const bindings = createAgentBindingStore({ store: fake.store, legacyMigrationWritesEnabled: true });
    await bindings.putParticipant({ ...address(participantA), expectedBindingId: null, record: first });

    expect(await bindings.updateBinding(first.binding.bindingId, record => ({
      ...record, binding: { ...record.binding, sessionId: 'substituted' },
    }))).toBe('unavailable');
    expect(await bindings.findBinding(first.binding.bindingId)).toEqual({ kind: 'found', record: first });
  });

  it('fails closed on malformed session locators and binding indices', async () => {
    const fake = fakeStore();
    fake.seed(agentBindingStoreKeys.session(ownerId, roomId, 'codex', 'broken'), {
      v: 1, ownerId, roomId, harness: 'codex', sessionId: 'broken', agentParticipantId: participantA, extra: true,
    });
    fake.seed(agentBindingStoreKeys.index('binding_broken'), { v: 1, ownerId, roomId });
    const bindings = createAgentBindingStore({ store: fake.store, legacyMigrationWritesEnabled: true });

    expect(await bindings.claimSession({
      ...address(participantA), harness: 'codex', sessionId: 'broken',
    })).toEqual({ kind: 'unavailable' });
    expect(await bindings.findBinding('binding_broken')).toEqual({ kind: 'unavailable' });
  });

  it('fails closed on a malformed scoped binding record', async () => {
    const fake = fakeStore();
    fake.seed(agentBindingStoreKeys.participant(ownerId, roomId, participantA), {
      ...binding(), capability: 'not-a-capability-digest',
    });
    const bindings = createAgentBindingStore({ store: fake.store, legacyMigrationWritesEnabled: true });
    expect(await bindings.findParticipant(address(participantA))).toEqual({ kind: 'unavailable' });
  });

  it('fails closed when a participant-aware index has no target record', async () => {
    const fake = fakeStore();
    fake.seed(agentBindingStoreKeys.index('binding_missing'), {
      v: 1, ownerId, roomId, agentParticipantId: participantA,
    });
    const bindings = createAgentBindingStore({ store: fake.store, legacyMigrationWritesEnabled: true });
    expect(await bindings.findBinding('binding_missing')).toEqual({ kind: 'unavailable' });
  });
});
