import { describe, expect, it } from 'vitest';
import conformance from '../../fixtures/messaging/control-store.json';
import {
  type CompareAndSetInput, type ControlRecord, type ControlStore, type JsonValue, type TrustedClock,
  isRecordLive, sameJsonValue,
} from './control-store';

type Fault = 'unavailable' | 'lose_response' | null;

/**
 * Test-only conformance fake. It is never exported: production adapters live with
 * their persistence owner and must pass the same fixture scenarios live.
 */
function createFakeStore(clock: TrustedClock) {
  const records = new Map<string, ControlRecord>();
  const operations = new Map<string, { key: string; next: CompareAndSetInput['next']; record: ControlRecord }>();
  let revision = 0;
  let fault: Fault = null;
  const takeFault = () => {
    const current = fault;
    fault = null;
    return current;
  };
  const live = (key: string) => {
    const record = records.get(key);
    return record && isRecordLive(record, clock()) ? record : null;
  };

  const store: ControlStore = {
    async read<T extends JsonValue>(key: string) {
      if (takeFault()) return { kind: 'unavailable' as const };
      const record = live(key);
      return record ? { kind: 'record' as const, record: record as ControlRecord<T> } : { kind: 'absent' as const };
    },
    async compareAndSet<T extends JsonValue>(input: CompareAndSetInput<T>) {
      const injected = takeFault();
      if (injected === 'unavailable') return { kind: 'unavailable' as const };
      const previous = operations.get(input.operationId);
      if (previous) {
        const identical = previous.key === input.key && previous.next.expiresAt === input.next.expiresAt
          && sameJsonValue(previous.next.value, input.next.value);
        return identical ? { kind: 'applied' as const, record: previous.record as ControlRecord<T> } : { kind: 'operation_mismatch' as const };
      }
      const current = live(input.key);
      if ((current?.revision ?? null) !== input.expectedRevision) {
        return { kind: 'conflict' as const, current: current as ControlRecord<T> | null };
      }
      revision += 1;
      const record: ControlRecord<T> = {
        key: input.key, revision: `r${revision}`, operationId: input.operationId, value: input.next.value, expiresAt: input.next.expiresAt,
      };
      records.set(input.key, record);
      operations.set(input.operationId, { key: input.key, next: input.next, record });
      return injected === 'lose_response'
        ? { kind: 'outcome_unknown' as const, operationId: input.operationId }
        : { kind: 'applied' as const, record };
    },
    async resolve<T extends JsonValue>(input: Readonly<{ key: string; operationId: string }>) {
      if (takeFault()) return { kind: 'unavailable' as const };
      const operation = operations.get(input.operationId);
      if (!operation || operation.key !== input.key) return { kind: 'not_applied' as const };
      return { kind: 'applied' as const, record: operation.record as ControlRecord<T> };
    },
  };
  return { store, inject: (mode: Fault) => { fault = mode; } };
}

type Step = Readonly<Record<string, unknown> & { op: string }>;
type Expectation = Readonly<{ kind: string; value?: JsonValue; currentValue?: JsonValue }>;

describe('ControlStore conformance scenarios', () => {
  it.each(conformance.scenarios)('$name', async scenario => {
    let now = Date.parse('2026-09-16T00:00:00Z');
    const { store, inject } = createFakeStore(() => now);
    const saved = new Map<string, string>();
    for (const step of scenario.steps as readonly Step[]) {
      const expectation = step.expect as Expectation | undefined;
      let result: Readonly<Record<string, unknown> & { kind: string }>;
      if (step.op === 'fault') {
        inject(step.mode as Fault);
        continue;
      } else if (step.op === 'clock') {
        now = step.nowMs as number;
        continue;
      } else if (step.op === 'read') {
        result = await store.read(step.key as string);
      } else if (step.op === 'resolve') {
        result = await store.resolve({ key: step.key as string, operationId: step.operationId as string });
      } else if (step.op === 'compareAndSet') {
        const expected = step.expectedRevision as string | null;
        result = await store.compareAndSet({
          key: step.key as string,
          expectedRevision: expected?.startsWith('$') ? saved.get(expected.slice(1)) ?? null : expected,
          operationId: step.operationId as string,
          next: step.next as CompareAndSetInput['next'],
        });
      } else throw new Error(`unknown step ${step.op}`);

      expect(result.kind, JSON.stringify(step)).toBe(expectation?.kind);
      const record = result.record as ControlRecord | undefined;
      if (expectation?.value !== undefined) expect(record?.value).toEqual(expectation.value);
      if (expectation?.currentValue !== undefined) {
        expect((result.current as ControlRecord | null)?.value ?? null).toEqual(expectation.currentValue);
      }
      if (result.kind === 'outcome_unknown') expect(result.operationId).toBe(step.operationId);
      if (typeof step.saveRevisionAs === 'string' && record) saved.set(step.saveRevisionAs, record.revision);
    }
  });
});

describe('isRecordLive', () => {
  const expiresAt = '2026-09-16T12:00:00Z';
  it('stops authorising at the expiry instant', () => {
    expect(isRecordLive({ expiresAt }, Date.parse(expiresAt) - 1)).toBe(true);
    expect(isRecordLive({ expiresAt }, Date.parse(expiresAt))).toBe(false);
    expect(isRecordLive({ expiresAt: null }, Number.MAX_SAFE_INTEGER)).toBe(true);
  });
});

describe('sameJsonValue', () => {
  it('ignores object key order but not array order', () => {
    expect(sameJsonValue({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
    expect(sameJsonValue([1, 2], [2, 1])).toBe(false);
    expect(sameJsonValue({ a: null }, {})).toBe(false);
    expect(sameJsonValue([], {})).toBe(false);
  });
});
