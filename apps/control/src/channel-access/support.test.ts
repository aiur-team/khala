import {
  type CompareAndSetInput,
  type ControlRecord,
  type ControlStore,
  type JsonValue,
  sameJsonValue,
} from '@khala/contracts/messaging/index';
import { describe, expect, it } from 'vitest';

type Fault = 'unavailable' | 'throw' | 'lose_response';

export function fakeControlStore() {
  const records = new Map<string, ControlRecord>();
  const operations = new Map<string, { key: string; next: CompareAndSetInput['next']; record: ControlRecord }>();
  const faults: Partial<Record<'read' | 'compareAndSet' | 'resolve', Fault[]>> = {};
  let revision = 0;
  let beforeWrite: ((input: CompareAndSetInput) => Promise<void> | void) | null = null;
  const take = (operation: keyof typeof faults) => faults[operation]?.shift();
  const store: ControlStore = {
    async read<T extends JsonValue>(recordKey: string) {
      const fault = take('read');
      if (fault === 'throw') throw new Error('secret provider detail');
      if (fault) return { kind: 'unavailable' as const };
      const record = records.get(recordKey);
      return record ? { kind: 'record' as const, record: record as ControlRecord<T> } : { kind: 'absent' as const };
    },
    async compareAndSet<T extends JsonValue>(input: CompareAndSetInput<T>) {
      const fault = take('compareAndSet');
      if (fault === 'throw') throw new Error('secret provider detail');
      if (fault === 'unavailable') return { kind: 'unavailable' as const };
      if (beforeWrite) await beforeWrite(input);
      const previous = operations.get(input.operationId);
      if (previous) {
        return previous.key === input.key
          && previous.next.expiresAt === input.next.expiresAt
          && sameJsonValue(previous.next.value, input.next.value)
          ? { kind: 'applied' as const, record: previous.record as ControlRecord<T> }
          : { kind: 'operation_mismatch' as const };
      }
      const current = records.get(input.key) ?? null;
      if ((current?.revision ?? null) !== input.expectedRevision) {
        return { kind: 'conflict' as const, current: current as ControlRecord<T> | null };
      }
      revision += 1;
      const record: ControlRecord<T> = {
        key: input.key,
        revision: `r${revision}`,
        operationId: input.operationId,
        value: structuredClone(input.next.value),
        expiresAt: input.next.expiresAt,
      };
      records.set(input.key, record);
      operations.set(input.operationId, { key: input.key, next: structuredClone(input.next), record });
      return fault === 'lose_response'
        ? { kind: 'outcome_unknown' as const, operationId: input.operationId }
        : { kind: 'applied' as const, record };
    },
    async resolve<T extends JsonValue>(input: Readonly<{ key: string; operationId: string }>) {
      const fault = take('resolve');
      if (fault === 'throw') throw new Error('secret provider detail');
      if (fault) return { kind: 'unavailable' as const };
      const operation = operations.get(input.operationId);
      return operation?.key === input.key
        ? { kind: 'applied' as const, record: operation.record as ControlRecord<T> }
        : { kind: 'not_applied' as const };
    },
  };
  return {
    store,
    records,
    inject(operation: keyof typeof faults, ...values: Fault[]) {
      faults[operation] = [...(faults[operation] ?? []), ...values];
    },
    interceptWrites(interceptor: typeof beforeWrite) { beforeWrite = interceptor; },
  };
}

describe('channel access test control store', () => {
  it('replays an identical operation and refuses a changed one', async () => {
    const backing = fakeControlStore();
    const next = { value: { a: 1 }, expiresAt: null };
    const first = await backing.store.compareAndSet({ key: 'k', expectedRevision: null, operationId: 'op', next });
    expect(await backing.store.compareAndSet({ key: 'k', expectedRevision: null, operationId: 'op', next })).toEqual(first);
    expect(await backing.store.compareAndSet({ key: 'k', expectedRevision: null, operationId: 'op', next: { value: { a: 2 }, expiresAt: null } }))
      .toEqual({ kind: 'operation_mismatch' });
  });
});
