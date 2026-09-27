import type { BindingId, ListeningModeActor, ListeningModeControl, ParticipantId } from '@khala/contracts/delivery/index';
import { describe, expect, it } from 'vitest';
import type {
  ListeningModeStore,
  ListeningModeStoreKey,
  ListeningModeStoreWrite,
} from '../../../src/listening-mode/store';

export type ListeningModeStoreFixture = Readonly<{
  store: ListeningModeStore;
  key: ListeningModeStoreKey;
  initial: ListeningModeControl;
}>;

const actor: ListeningModeActor = { kind: 'agent', participantId: 'conformance-agent' as ParticipantId };

const write = (
  fixture: ListeningModeStoreFixture,
  operationId: string,
  requested: ListeningModeControl['requested'],
  expectedVersion = fixture.initial.version,
): ListeningModeStoreWrite => ({
  key: fixture.key,
  expectedVersion,
  operationId,
  operationFingerprint: JSON.stringify({ operationId, requested, expectedVersion }),
  next: {
    requested,
    experimentalGrants: fixture.initial.experimentalGrants,
    hardCancelGrants: fixture.initial.hardCancelGrants,
    lastChangedBy: actor,
  },
});

/** Shared observable contract for memory, hosted, and future local adapters. */
export function listeningModeStoreConformance(
  name: string,
  createFixture: () => ListeningModeStoreFixture,
): void {
  describe(`${name} ListeningModeStore conformance`, () => {
    it('reads only the exact binding and generation', async () => {
      const fixture = createFixture();
      await expect(fixture.store.read(fixture.key))
        .resolves.toEqual({ kind: 'record', control: fixture.initial });
      await expect(fixture.store.read({ ...fixture.key, bindingId: 'other-binding' as BindingId }))
        .resolves.toEqual({ kind: 'absent' });
      await expect(fixture.store.read({ ...fixture.key, generation: fixture.key.generation + 1 }))
        .resolves.toEqual({ kind: 'absent' });
    });

    it('permits exactly one writer at an expected version', async () => {
      const fixture = createFixture();
      const results = await Promise.all([
        fixture.store.compareAndSet(write(fixture, 'race-steer', 'steer')),
        fixture.store.compareAndSet(write(fixture, 'race-async', 'async')),
      ]);

      expect(results.map(result => result.kind).sort()).toEqual(['applied', 'conflict']);
      await expect(fixture.store.read(fixture.key)).resolves.toMatchObject({
        kind: 'record',
        control: { version: fixture.initial.version + 1 },
      });
    });

    it('round-trips a null requested mode', async () => {
      const fixture = createFixture();
      const applied = await fixture.store.compareAndSet(write(fixture, 'null-request', null));
      expect(applied).toMatchObject({ kind: 'applied', control: { requested: null } });
      await expect(fixture.store.read(fixture.key)).resolves.toMatchObject({
        kind: 'record',
        control: { requested: null, version: fixture.initial.version + 1 },
      });
    });

    it('returns the original result for a retry and rejects changed operation reuse', async () => {
      const fixture = createFixture();
      const firstWrite = write(fixture, 'retry-operation', 'steer');
      const first = await fixture.store.compareAndSet(firstWrite);
      expect(first).toMatchObject({ kind: 'applied', control: { version: fixture.initial.version + 1 } });

      await expect(fixture.store.compareAndSet(write(
        fixture,
        'later-operation',
        'async',
        fixture.initial.version + 1,
      ))).resolves.toMatchObject({ kind: 'applied', control: { version: fixture.initial.version + 2 } });
      await expect(fixture.store.compareAndSet(firstWrite)).resolves.toEqual(first);
      await expect(fixture.store.compareAndSet({ ...firstWrite, operationFingerprint: 'changed' }))
        .resolves.toEqual({ kind: 'idempotency_conflict' });
    });

    it('records the actor of the applied write and keeps it across a conflict', async () => {
      const fixture = createFixture();
      const applied = await fixture.store.compareAndSet(write(fixture, 'actor-operation', 'steer'));
      expect(applied).toMatchObject({ kind: 'applied', control: { lastChangedBy: actor } });
      await expect(fixture.store.read(fixture.key)).resolves.toMatchObject({
        kind: 'record',
        control: { lastChangedBy: actor },
      });

      const owner: ListeningModeActor = { kind: 'owner', participantId: 'conformance-owner' as ParticipantId };
      const stale = await fixture.store.compareAndSet({
        ...write(fixture, 'stale-actor-operation', 'async', fixture.initial.version),
        next: { ...write(fixture, 'unused', 'async').next, lastChangedBy: owner },
      });
      expect(stale).toMatchObject({ kind: 'conflict', current: { lastChangedBy: actor } });
      await expect(fixture.store.read(fixture.key)).resolves.toMatchObject({
        kind: 'record',
        control: { lastChangedBy: actor },
      });
    });

    it('returns the current record on a stale version conflict', async () => {
      const fixture = createFixture();
      await expect(fixture.store.compareAndSet(write(
        fixture,
        'stale-operation',
        'steer',
        fixture.initial.version - 1,
      ))).resolves.toEqual({ kind: 'conflict', current: fixture.initial });
    });

    it('durably replays a future-version conflict after control reaches that version', async () => {
      const fixture = createFixture();
      const futureWrite = write(
        fixture,
        'future-operation',
        'steer',
        fixture.initial.version + 2,
      );
      const first = await fixture.store.compareAndSet(futureWrite);
      expect(first).toEqual({ kind: 'conflict', current: fixture.initial });

      await expect(fixture.store.compareAndSet(write(
        fixture,
        'advance-once',
        'async',
      ))).resolves.toMatchObject({ kind: 'applied', control: { version: fixture.initial.version + 1 } });
      await expect(fixture.store.compareAndSet(write(
        fixture,
        'advance-twice',
        'sync',
        fixture.initial.version + 1,
      ))).resolves.toMatchObject({ kind: 'applied', control: { version: fixture.initial.version + 2 } });

      await expect(fixture.store.compareAndSet(futureWrite)).resolves.toEqual(first);
      await expect(fixture.store.compareAndSet({ ...futureWrite, operationFingerprint: 'changed' }))
        .resolves.toEqual({ kind: 'idempotency_conflict' });
    });
  });
}
