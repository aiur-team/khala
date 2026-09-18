import type {
  AuthPrincipal,
  CompareAndSetInput,
  ControlRecord,
  ControlStore,
  DeviceId,
  IdentityPort,
  JsonValue,
  OwnerId,
  RoomId,
  RoomSummary,
} from '@khala/contracts/messaging/index';
import { isRecordLive, sameJsonValue } from '@khala/contracts/messaging/index';
import { describe, expect, it } from 'vitest';
import { createAdmissionService, type AdmissionGateway, type AdmissionServiceOptions } from './index';

export const T0 = Date.parse('2026-09-18T12:00:00Z');
export const ORIGIN = 'https://khala.aiur.team';
export const SECRET = 's'.repeat(32);
export const ROOM_ID = 'room_1' as RoomId;
export const DEVICE_ID = 'device_1' as DeviceId;

export const principal = (owner = 'owner_1', email = 'ada@example.test'): AuthPrincipal => ({
  v: 1,
  ownerId: owner as OwnerId,
  providerIssuer: 'https://id.example.test',
  providerSubject: owner,
  verifiedEmail: email,
  sessionExpiresAt: new Date(T0 + 3600_000).toISOString(),
});

type Fault = 'unavailable' | 'outcome_unknown';

export function fakeStore(clock: () => number) {
  const records = new Map<string, ControlRecord>();
  const operations = new Map<string, { key: string; next: CompareAndSetInput['next']; record?: ControlRecord }>();
  const faults: Partial<Record<'read' | 'compareAndSet' | 'resolve', Fault[]>> = {};
  let revision = 0;
  const take = (op: keyof typeof faults) => faults[op]?.shift();
  const live = (key: string) => {
    const record = records.get(key);
    return record && isRecordLive(record, clock()) ? record : null;
  };
  const store: ControlStore = {
    async read<T extends JsonValue>(key: string) {
      if (take('read')) return { kind: 'unavailable' as const };
      const record = live(key);
      return record ? { kind: 'record' as const, record: record as ControlRecord<T> } : { kind: 'absent' as const };
    },
    async compareAndSet<T extends JsonValue>(input: CompareAndSetInput<T>) {
      const fault = take('compareAndSet');
      if (fault === 'unavailable') return { kind: 'unavailable' as const };
      const previous = operations.get(input.operationId);
      if (previous) {
        const identical = previous.key === input.key && previous.next.expiresAt === input.next.expiresAt
          && sameJsonValue(previous.next.value, input.next.value);
        if (!identical) return { kind: 'operation_mismatch' as const };
        if (previous.record) return { kind: 'applied' as const, record: previous.record as ControlRecord<T> };
      } else {
        operations.set(input.operationId, { key: input.key, next: structuredClone(input.next) });
      }
      const current = live(input.key);
      if ((current?.revision ?? null) !== input.expectedRevision) return { kind: 'conflict' as const, current: current as ControlRecord<T> | null };
      const record: ControlRecord<T> = {
        key: input.key,
        revision: `r${++revision}`,
        operationId: input.operationId,
        value: structuredClone(input.next.value),
        expiresAt: input.next.expiresAt,
      };
      records.set(input.key, record);
      operations.set(input.operationId, { key: input.key, next: structuredClone(input.next), record });
      return fault === 'outcome_unknown'
        ? { kind: 'outcome_unknown' as const, operationId: input.operationId }
        : { kind: 'applied' as const, record };
    },
    async resolve<T extends JsonValue>(input: Readonly<{ key: string; operationId: string }>) {
      if (take('resolve')) return { kind: 'unavailable' as const };
      const operation = operations.get(input.operationId);
      return operation?.key === input.key && operation.record
        ? { kind: 'applied' as const, record: operation.record as ControlRecord<T> }
        : { kind: 'not_applied' as const };
    },
  };
  return {
    store,
    records,
    inject(op: keyof typeof faults, ...values: Fault[]) {
      faults[op] = [...(faults[op] ?? []), ...values];
    },
  };
}

export function harness(overrides: Partial<AdmissionServiceOptions> = {}) {
  let now = T0;
  let current: AuthPrincipal | null | 'unavailable' = principal();
  const clock = () => now;
  const backing = fakeStore(clock);
  const memberships = new Map<string, RoomSummary>();
  const historyReadiness = new Map<string, boolean>();
  const membershipHistoryReadiness = new Map<string, boolean>();
  const admits: string[] = [];
  const histories: string[] = [];
  let nextAdmission: 'ok' | 'outcome_unknown' | 'unavailable' | 'history_unavailable' | 'throw_after_commit' = 'ok';

  const identity: IdentityPort = {
    async current() {
      return current === 'unavailable'
        ? { kind: 'unavailable', retryable: true }
        : current ? { kind: 'signed_in', principal: current } : { kind: 'signed_out' };
    },
    async beginSignIn() { return { kind: 'unavailable', retryable: true }; },
    async signOut() { return { kind: 'ok', value: null }; },
  };
  const gateway: AdmissionGateway = {
    async inspectMembership(input) {
      if (!memberships.has(input.principal.ownerId)) return { kind: 'absent' };
      return {
        kind: 'joined',
        historyReady: input.history === 'none' || membershipHistoryReadiness.get(input.principal.ownerId) === true,
      };
    },
    async admit(input) {
      admits.push(input.operationId);
      if (nextAdmission === 'unavailable') {
        nextAdmission = 'ok';
        return { kind: 'unavailable' };
      }
      const room: RoomSummary = memberships.get(input.principal.ownerId)
        ?? { roomId: input.roomId, title: 'Shared room', membership: 'joined', revision: `m${memberships.size + 1}` };
      memberships.set(input.principal.ownerId, room);
      if (input.history === 'full') histories.push(input.operationId);
      if (nextAdmission === 'throw_after_commit') {
        nextAdmission = 'ok';
        historyReadiness.set(input.operationId, true);
        if (input.history === 'full') membershipHistoryReadiness.set(input.principal.ownerId, true);
        throw new Error('provider response lost after commit');
      }
      if (nextAdmission === 'outcome_unknown') {
        nextAdmission = 'ok';
        return { kind: 'outcome_unknown' };
      }
      if (nextAdmission === 'history_unavailable') {
        nextAdmission = 'ok';
        historyReadiness.set(input.operationId, false);
        if (input.history === 'full') membershipHistoryReadiness.set(input.principal.ownerId, false);
        return { kind: 'joined', room, historyReady: false };
      }
      historyReadiness.set(input.operationId, true);
      if (input.history === 'full') membershipHistoryReadiness.set(input.principal.ownerId, true);
      return { kind: 'joined', room, historyReady: true };
    },
    async lookup(input) {
      const room = memberships.get(input.principal.ownerId);
      return room ? { kind: 'joined', room, historyReady: historyReadiness.get(input.operationId) ?? true } : { kind: 'absent' };
    },
  };
  const service = createAdmissionService({
    store: backing.store,
    identity,
    authority: { async canShare() { return 'allowed'; } },
    gateway,
    clock,
    origin: ORIGIN,
    allowedOrigins: [ORIGIN],
    secret: SECRET,
    inviteLifetimeMs: 3600_000,
    ...overrides,
  });
  return {
    service,
    store: backing,
    memberships,
    admits,
    histories,
    setPrincipal(value: typeof current) { current = value; },
    advance(ms: number) { now += ms; },
    failAdmission(value: typeof nextAdmission) { nextAdmission = value; },
  };
}

describe('invitation test store', () => {
  it('keeps identical operation retries idempotent', async () => {
    const { store } = fakeStore(() => T0);
    const input = { key: 'key', expectedRevision: null, operationId: 'operation', next: { value: 1, expiresAt: null } };
    expect((await store.compareAndSet(input)).kind).toBe('applied');
    expect((await store.compareAndSet(input)).kind).toBe('applied');
  });
});
