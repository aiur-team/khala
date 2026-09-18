import { describe, expect, it } from 'vitest';
import conformance from '../../fixtures/messaging/control-store.json';
import invalid from '../../fixtures/messaging/invalid.json';
import {
  type CompareAndSetInput, type ControlRecord, type ControlStore, type JsonValue, type TrustedClock,
  MAX_JSON_DEPTH, decodeControlRecord, isRecordLive, sameJsonValue,
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
    await runSteps(scenario.steps as readonly Step[]);
  });

  it.each(invalid.peers.cases.filter(peer => peer.check === 'controlStore'))('invalid peer: $name', async peer => {
    await runSteps(peer.steps as readonly Step[]);
  });
});

async function runSteps(steps: readonly Step[]): Promise<void> {
  let now = Date.parse('2026-09-16T00:00:00Z');
  const { store, inject } = createFakeStore(() => now);
  const saved = new Map<string, string>();
  for (const step of steps) {
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
}

describe('isRecordLive', () => {
  const expiresAt = '2026-09-16T12:00:00Z';
  it('stops authorising at the expiry instant', () => {
    expect(isRecordLive({ expiresAt }, Date.parse(expiresAt) - 1)).toBe(true);
    expect(isRecordLive({ expiresAt }, Date.parse(expiresAt))).toBe(false);
    expect(isRecordLive({ expiresAt: null }, Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it('never authorises with an unparseable expiry or clock', () => {
    expect(isRecordLive({ expiresAt: 'not a timestamp' }, 0)).toBe(false);
    expect(isRecordLive({ expiresAt }, Number.NaN)).toBe(false);
  });
});

describe('sameJsonValue', () => {
  it('ignores object key order but not array order', () => {
    expect(sameJsonValue({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
    expect(sameJsonValue([1, 2], [2, 1])).toBe(false);
    expect(sameJsonValue({ a: null }, {})).toBe(false);
    expect(sameJsonValue([], {})).toBe(false);
  });

  it('refuses extra keys on either side', () => {
    expect(sameJsonValue({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(sameJsonValue({ a: 1, b: 2 }, { a: 1 })).toBe(false);
    expect(sameJsonValue({ a: 1, b: 2 }, { a: 1, c: 2 })).toBe(false);
  });
});

describe('decodeControlRecord is total', () => {
  const envelope = (value: unknown) => ({ key: 'k', revision: 'r1', operationId: 'op_1', value, expiresAt: null });

  it.each([
    ['NaN', Number.NaN, 'value', 'invalid_value'],
    ['Infinity', Number.POSITIVE_INFINITY, 'value', 'invalid_value'],
    ['nested -Infinity', { limits: [Number.NEGATIVE_INFINITY] }, 'value.limits[0]', 'invalid_value'],
    ['undefined', undefined, 'value', 'wrong_type'],
    ['a function', () => 1, 'value', 'wrong_type'],
    ['a bigint', 1n, 'value', 'wrong_type'],
    ['a Date', new Date(0), 'value', 'wrong_type'],
    ['a sparse array hole', { roles: ['owner', , 'member'] }, 'value.roles[1]', 'wrong_type'],
  ])('rejects %s in the value', (_name, value, path, code) => {
    expect(decodeControlRecord(envelope(value))).toEqual({ ok: false, error: { path, code } });
  });

  it('accepts nesting up to the depth bound', () => {
    let value: JsonValue = 'leaf';
    for (let depth = 0; depth < MAX_JSON_DEPTH; depth += 1) value = [value];
    expect(decodeControlRecord(envelope(value)).ok).toBe(true);
  });

  it('fails on deeper nesting instead of exhausting the stack', () => {
    let value: JsonValue = 'leaf';
    for (let depth = 0; depth < 100_000; depth += 1) value = { next: value };
    const decoded = decodeControlRecord(envelope(value));
    expect(decoded.ok || decoded.error.code).toBe('too_deep');
  });

  it('fails on cyclic input instead of throwing', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic.self = cyclic;
    const decoded = decodeControlRecord(envelope(cyclic));
    expect(decoded.ok || decoded.error.code).toBe('too_deep');
  });
});
