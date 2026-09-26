import {
  type CompareAndSetInput,
  type ControlRecord,
  type ControlStore,
  type DeviceId,
  type JsonValue,
  type OwnerId,
  type RoomId,
  sameJsonValue,
} from '@khala/contracts/messaging/index';
import { describe, expect, it } from 'vitest';
import { createControlStore, type BlobsStoreLike } from '../runtime/control-store';
import { createPairingPolicy, type PairingKeyring } from './policy';
import {
  createPairingStore,
  type PairingBootstrapAuthorization,
  type PairingClaimInput,
  type PairingStore,
} from './store';

const T0 = Date.parse('2026-09-24T12:00:00Z');
const OWNER = 'owner_1' as OwnerId;
const OTHER_OWNER = 'owner_2' as OwnerId;
const CHANNEL = 'room_1' as RoomId;
const OTHER_CHANNEL = 'room_2' as RoomId;
const DEVICE = 'device_1' as DeviceId;
const JKT = 'j'.repeat(43);
const OTHER_JKT = 'k'.repeat(43);
const BOUND = { session: { harness: 'codex', sessionId: 'thread_1', generation: 3 }, deviceId: DEVICE as string };

const key = (fill: number) => new Uint8Array(32).fill(fill);
const keyring = (activeKeyId = 'key-2', keys = [{ id: 'key-2', key: key(2) }, { id: 'key-1', key: key(1) }]): PairingKeyring => ({
  v: 1, activeKeyId, keys,
});

const createInput = {
  ownerId: OWNER,
  channelId: CHANNEL,
  origin: 'https://khala.example',
  descriptorId: 'descriptor_v1',
  operationId: 'create_1',
} as const;

const claimInput = (overrides: Partial<PairingClaimInput> = {}): PairingClaimInput => ({
  code: '',
  operationId: 'claim_1',
  jkt: JKT,
  harness: 'codex',
  sessionId: 'thread_1',
  generation: 3,
  deviceId: DEVICE,
  evidenceDigest: 'e'.repeat(43),
  ...overrides,
});

type Fault = 'unavailable' | 'throw' | 'lose_response';

function fakeControlStore() {
  const records = new Map<string, ControlRecord>();
  const operations = new Map<string, { key: string; next: CompareAndSetInput['next']; record: ControlRecord }>();
  const diagnostics: string[] = [];
  const faults: Partial<Record<'read' | 'compareAndSet' | 'resolve', Fault[]>> = {};
  let revision = 0;
  let beforeWrite: ((input: CompareAndSetInput) => Promise<void> | void) | null = null;
  const take = (operation: keyof typeof faults) => faults[operation]?.shift();

  const store: ControlStore = {
    async read<T extends JsonValue>(recordKey: string) {
      diagnostics.push(`read:${recordKey}`);
      const fault = take('read');
      if (fault === 'throw') throw new Error('provider details: authorization=secret');
      if (fault) return { kind: 'unavailable' as const };
      const record = records.get(recordKey);
      return record ? { kind: 'record' as const, record: record as ControlRecord<T> } : { kind: 'absent' as const };
    },
    async compareAndSet<T extends JsonValue>(input: CompareAndSetInput<T>) {
      diagnostics.push(`cas:${input.key}:${input.operationId}`);
      const fault = take('compareAndSet');
      if (fault === 'throw') throw new Error('provider details: cookie=secret');
      if (fault === 'unavailable') return { kind: 'unavailable' as const };
      if (beforeWrite) await beforeWrite(input);
      const previous = operations.get(input.operationId);
      if (previous) {
        const identical = previous.key === input.key
          && previous.next.expiresAt === input.next.expiresAt
          && sameJsonValue(previous.next.value, input.next.value);
        return identical
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
      diagnostics.push(`resolve:${input.key}:${input.operationId}`);
      const fault = take('resolve');
      if (fault === 'throw') throw new Error('provider details: proof=secret');
      if (fault) return { kind: 'unavailable' as const };
      const operation = operations.get(input.operationId);
      if (!operation || operation.key !== input.key) return { kind: 'not_applied' as const };
      return { kind: 'applied' as const, record: operation.record as ControlRecord<T> };
    },
  };

  return {
    store,
    records,
    operations,
    diagnostics,
    inject(operation: keyof typeof faults, ...values: Fault[]) {
      faults[operation] = [...(faults[operation] ?? []), ...values];
    },
    interceptWrites(interceptor: typeof beforeWrite) {
      beforeWrite = interceptor;
    },
  };
}

function barrier(parties: number) {
  let arrivals = 0;
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  return async () => {
    arrivals += 1;
    if (arrivals === parties) release();
    await ready;
  };
}

function harness(options: Readonly<{ now?: number; keys?: PairingKeyring; random?: (bytes: number) => Uint8Array }> = {}) {
  let now = options.now ?? T0;
  const backing = fakeControlStore();
  const policy = createPairingPolicy(options.keys ?? keyring());
  const pairing = createPairingStore({
    store: backing.store,
    policy,
    clock: () => now,
    ...(options.random ? { random: options.random } : {}),
  });
  return {
    ...backing,
    pairing,
    policy,
    setNow(value: number) { now = value; },
  };
}

async function issue(h: ReturnType<typeof harness>, input = createInput) {
  const result = await h.pairing.create(input);
  if (result.kind !== 'created') throw new Error(`create failed: ${result.kind}`);
  return result;
}

async function claim(h: ReturnType<typeof harness>, code: string, overrides: Partial<PairingClaimInput> = {}) {
  return h.pairing.claim(claimInput({ code, ...overrides }));
}

async function claimed(h: ReturnType<typeof harness>) {
  const created = await issue(h);
  const result = await claim(h, created.code);
  if (result.kind !== 'claimed') throw new Error(`claim failed: ${result.kind}`);
  return { created, result };
}

async function approve(h: ReturnType<typeof harness>, requestHandle: string, operationId = 'approve_1') {
  const inspected = await h.pairing.inspect({ ownerId: OWNER, requestHandle });
  if (inspected.kind !== 'found' || !inspected.projection.claim) throw new Error('inspect failed');
  return h.pairing.decide({
    ownerId: OWNER,
    requestHandle,
    revision: inspected.revision,
    claimFingerprint: inspected.projection.claim.fingerprint,
    decision: 'approve',
    operationId,
  });
}

describe('PairingStore request creation', () => {
  it('recovers identical creates and conflicts when one owner operation changes tuple bytes', async () => {
    const h = harness();
    const first = await issue(h);
    expect(await h.pairing.create(createInput)).toEqual(first);
    expect(await h.pairing.create({ ...createInput, channelId: OTHER_CHANNEL })).toEqual({ kind: 'conflict' });
    expect([...h.records].filter(([key]) => key.startsWith('pairing.request.'))).toHaveLength(1);
  });

  it('recovers a request created under a retained key after rotation, including a terminal response', async () => {
    const backing = fakeControlStore();
    let now = T0;
    const oldStore = createPairingStore({ store: backing.store, policy: createPairingPolicy(keyring('key-1', [{ id: 'key-1', key: key(1) }])), clock: () => now });
    const first = await oldStore.create(createInput);
    expect(first.kind).toBe('created');
    const rotated = createPairingStore({ store: backing.store, policy: createPairingPolicy(keyring()), clock: () => now });
    expect(await rotated.create(createInput)).toEqual(first);
    now += 5 * 60_000;
    if (first.kind === 'created') await rotated.inspect({ ownerId: OWNER, requestHandle: first.requestHandle });
    expect(await rotated.create(createInput)).toEqual(first);
  });

  it('keeps owner/operation tuple conflicts authoritative across key rotation', async () => {
    const backing = fakeControlStore();
    const oldStore = createPairingStore({
      store: backing.store,
      policy: createPairingPolicy(keyring('key-1', [{ id: 'key-1', key: key(1) }])),
      clock: () => T0,
    });
    expect((await oldStore.create(createInput)).kind).toBe('created');
    const rotated = createPairingStore({ store: backing.store, policy: createPairingPolicy(keyring()), clock: () => T0 });
    expect(await rotated.create({ ...createInput, channelId: OTHER_CHANNEL })).toEqual({ kind: 'conflict' });
    expect([...backing.records].filter(([recordKey]) => recordKey.startsWith('pairing.request.'))).toHaveLength(1);
  });

  it('settles a lost create response and maps thrown or unresolved storage to unavailable', async () => {
    const recovered = harness();
    recovered.inject('compareAndSet', 'lose_response');
    expect((await recovered.pairing.create(createInput)).kind).toBe('created');

    const failed = harness();
    failed.inject('read', 'throw');
    expect(await failed.pairing.create(createInput)).toEqual({ kind: 'unavailable' });

    const unresolved = harness();
    unresolved.inject('compareAndSet', 'lose_response');
    unresolved.inject('resolve', 'unavailable');
    expect(await unresolved.pairing.create(createInput)).toEqual({ kind: 'unavailable' });
  });
});

describe('PairingStore one-winner claim', () => {
  it('uses an exact-revision CAS so synchronized claimants have exactly one winner', async () => {
    const h = harness();
    const created = await issue(h);
    const rendezvous = barrier(2);
    h.interceptWrites(async input => {
      const value = input.next.value as { state?: unknown };
      if (input.key.startsWith('pairing.request.') && value.state === 'claimed') await rendezvous();
    });
    const results = await Promise.all([
      claim(h, created.code, { operationId: 'claim_a', jkt: JKT }),
      claim(h, created.code, { operationId: 'claim_b', jkt: OTHER_JKT }),
    ]);
    expect(results.filter(result => result.kind === 'claimed')).toHaveLength(1);
    expect(results.filter(result => result.kind === 'refused')).toHaveLength(1);
  });

  it('returns the same 256-bit receipt only to the identical winning retry', async () => {
    const h = harness();
    const created = await issue(h);
    const first = await claim(h, created.code);
    expect(first).toMatchObject({ kind: 'claimed', requestHandle: created.requestHandle });
    if (first.kind !== 'claimed') throw new Error('claim failed');
    expect(first.receipt).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await claim(h, created.code)).toEqual(first);
    expect(await claim(h, created.code, { operationId: 'claim_other' })).toEqual({ kind: 'refused' });
    expect(await claim(h, created.code, { jkt: OTHER_JKT })).toEqual({ kind: 'refused' });
  });

  it('recovers the identical winning receipt after approval, denial, or claimed-request expiry', async () => {
    for (const decision of ['approve', 'deny'] as const) {
      const h = harness();
      const { created, result: winner } = await claimed(h);
      const inspected = await h.pairing.inspect({ ownerId: OWNER, requestHandle: created.requestHandle });
      if (inspected.kind !== 'found' || !inspected.projection.claim) throw new Error('inspect failed');
      await h.pairing.decide({
        ownerId: OWNER,
        requestHandle: created.requestHandle,
        revision: inspected.revision,
        claimFingerprint: inspected.projection.claim.fingerprint,
        decision,
        operationId: `${decision}_after_lost_claim`,
      });
      expect(await claim(h, created.code)).toEqual(winner);
    }

    const expired = harness();
    const { created, result: winner } = await claimed(expired);
    expired.setNow(T0 + 5 * 60_000);
    expect(await expired.pairing.inspect({ ownerId: OWNER, requestHandle: created.requestHandle }))
      .toMatchObject({ kind: 'found', projection: { state: 'expired' } });
    expect(await claim(expired, created.code)).toEqual(winner);
  });

  it('collapses absent, expired, and already-used codes into the same refusal', async () => {
    const h = harness();
    const created = await issue(h);
    const absent = h.policy.deriveCreate({ ...createInput, operationId: 'never_created' }).code;
    expect(await claim(h, absent)).toEqual({ kind: 'refused' });

    h.setNow(T0 + 5 * 60_000);
    expect(await claim(h, created.code)).toEqual({ kind: 'refused' });
    const expired = await h.pairing.inspect({ ownerId: OWNER, requestHandle: created.requestHandle });
    expect(expired).toMatchObject({ kind: 'found', projection: { state: 'expired' } });

    const fresh = harness();
    const used = await claimed(fresh);
    expect(await claim(fresh, used.created.code, { operationId: 'loser' })).toEqual({ kind: 'refused' });
  });

  it('recovers the winner and receipt after an ambiguous claim write', async () => {
    const h = harness();
    const created = await issue(h);
    h.inject('compareAndSet', 'lose_response');
    const first = await claim(h, created.code);
    expect(first.kind).toBe('claimed');
    expect(await claim(h, created.code)).toEqual(first);
  });

  it('cannot revive expiration when a pre-deadline claim races an expiry transition', async () => {
    const h = harness();
    const created = await issue(h);
    let raced = false;
    h.interceptWrites(async input => {
      const value = input.next.value as { state?: unknown };
      if (!raced && value.state === 'claimed') {
        raced = true;
        h.setNow(T0 + 5 * 60_000);
        await h.pairing.inspect({ ownerId: OWNER, requestHandle: created.requestHandle });
      }
    });
    expect(await claim(h, created.code)).toEqual({ kind: 'refused' });
    expect(await h.pairing.inspect({ ownerId: OWNER, requestHandle: created.requestHandle }))
      .toMatchObject({ kind: 'found', projection: { state: 'expired' } });
  });
});

describe('PairingStore owner projection and decision', () => {
  it('authorizes exact owners and retains safe claimed, denied, approved, and expired projections', async () => {
    const deniedHarness = harness();
    const deniedClaim = await claimed(deniedHarness);
    expect(await deniedHarness.pairing.inspect({ ownerId: OTHER_OWNER, requestHandle: deniedClaim.created.requestHandle }))
      .toEqual({ kind: 'forbidden' });
    const inspected = await deniedHarness.pairing.inspect({ ownerId: OWNER, requestHandle: deniedClaim.created.requestHandle });
    expect(inspected).toMatchObject({ kind: 'found', projection: { state: 'claimed', claim: { verification: 'connector_verified' } } });
    if (inspected.kind !== 'found' || !inspected.projection.claim) throw new Error('inspect failed');
    const denied = await deniedHarness.pairing.decide({
      ownerId: OWNER,
      requestHandle: deniedClaim.created.requestHandle,
      revision: inspected.revision,
      claimFingerprint: inspected.projection.claim.fingerprint,
      decision: 'deny',
      operationId: 'deny_1',
    });
    expect(denied).toMatchObject({ kind: 'decided', projection: { state: 'denied' } });
    if (denied.kind !== 'decided') throw new Error('deny failed');
    expect(await deniedHarness.pairing.inspect({ ownerId: OWNER, requestHandle: deniedClaim.created.requestHandle }))
      .toMatchObject({ kind: 'found', projection: denied.projection, revision: denied.revision });

    const approvedHarness = harness();
    const approvedClaim = await claimed(approvedHarness);
    expect(await approve(approvedHarness, approvedClaim.created.requestHandle))
      .toMatchObject({ kind: 'decided', projection: { state: 'approved' } });

    const expiredHarness = harness();
    const expiredRequest = await issue(expiredHarness);
    expiredHarness.setNow(T0 + 5 * 60_000);
    expect(await expiredHarness.pairing.inspect({ ownerId: OWNER, requestHandle: expiredRequest.requestHandle }))
      .toMatchObject({ kind: 'found', projection: { state: 'expired' } });
  });

  it('requires the displayed revision and fingerprint without changing state on stale input', async () => {
    const h = harness();
    const { created } = await claimed(h);
    const inspected = await h.pairing.inspect({ ownerId: OWNER, requestHandle: created.requestHandle });
    if (inspected.kind !== 'found' || !inspected.projection.claim) throw new Error('inspect failed');
    const base = {
      ownerId: OWNER,
      requestHandle: created.requestHandle,
      revision: inspected.revision,
      claimFingerprint: inspected.projection.claim.fingerprint,
      decision: 'approve' as const,
      operationId: 'approve_1',
    };
    expect(await h.pairing.decide({ ...base, revision: 'stale_revision' })).toEqual({ kind: 'stale' });
    expect(await h.pairing.decide({ ...base, claimFingerprint: 'x'.repeat(43) })).toEqual({ kind: 'stale' });
    expect(await h.pairing.inspect({ ownerId: OWNER, requestHandle: created.requestHandle }))
      .toMatchObject({ kind: 'found', projection: { state: 'claimed' } });
  });

  it('reconciles an identical lost decision response and conflicts with the opposite decision', async () => {
    const h = harness();
    const { created } = await claimed(h);
    const inspected = await h.pairing.inspect({ ownerId: OWNER, requestHandle: created.requestHandle });
    if (inspected.kind !== 'found' || !inspected.projection.claim) throw new Error('inspect failed');
    const decision = {
      ownerId: OWNER,
      requestHandle: created.requestHandle,
      revision: inspected.revision,
      claimFingerprint: inspected.projection.claim.fingerprint,
      decision: 'approve' as const,
      operationId: 'decision_1',
    };
    h.inject('compareAndSet', 'lose_response');
    const first = await h.pairing.decide(decision);
    expect(first).toMatchObject({ kind: 'decided', projection: { state: 'approved' } });
    expect(await h.pairing.decide(decision)).toEqual(first);
    expect(await h.pairing.decide({ ...decision, decision: 'deny' })).toEqual({ kind: 'conflict' });
  });

  it('lets expiry beat a stale approval CAS and never revives the request', async () => {
    const h = harness();
    const { created } = await claimed(h);
    const inspected = await h.pairing.inspect({ ownerId: OWNER, requestHandle: created.requestHandle });
    if (inspected.kind !== 'found' || !inspected.projection.claim) throw new Error('inspect failed');
    let raced = false;
    h.interceptWrites(async input => {
      const value = input.next.value as { state?: unknown };
      if (!raced && value.state === 'approved') {
        raced = true;
        h.setNow(T0 + 5 * 60_000);
        await h.pairing.inspect({ ownerId: OWNER, requestHandle: created.requestHandle });
      }
    });
    expect(await h.pairing.decide({
      ownerId: OWNER,
      requestHandle: created.requestHandle,
      revision: inspected.revision,
      claimFingerprint: inspected.projection.claim.fingerprint,
      decision: 'approve',
      operationId: 'approve_race',
    })).toEqual({ kind: 'expired' });
  });

  it('linearizes simultaneous approval and denial as one terminal decision', async () => {
    const h = harness();
    const { created } = await claimed(h);
    const inspected = await h.pairing.inspect({ ownerId: OWNER, requestHandle: created.requestHandle });
    if (inspected.kind !== 'found' || !inspected.projection.claim) throw new Error('inspect failed');
    const rendezvous = barrier(2);
    h.interceptWrites(async input => {
      const value = input.next.value as { state?: unknown };
      if (value.state === 'approved' || value.state === 'denied') await rendezvous();
    });
    const base = {
      ownerId: OWNER,
      requestHandle: created.requestHandle,
      revision: inspected.revision,
      claimFingerprint: inspected.projection.claim.fingerprint,
    };
    const outcomes = await Promise.all([
      h.pairing.decide({ ...base, decision: 'approve', operationId: 'approve_race' }),
      h.pairing.decide({ ...base, decision: 'deny', operationId: 'deny_race' }),
    ]);
    expect(outcomes.filter(outcome => outcome.kind === 'decided')).toHaveLength(1);
    expect(outcomes.filter(outcome => outcome.kind === 'conflict')).toHaveLength(1);
  });
});

describe('PairingStore approved result and internal grant redemption', () => {
  it('creates no grant before approval and returns pending only to receipt + key possession', async () => {
    const h = harness();
    const { created, result: winner } = await claimed(h);
    expect(await h.pairing.result({
      requestHandle: created.requestHandle,
      receipt: winner.receipt,
      operationId: 'result_1',
      jkt: JKT,
    })).toEqual({ kind: 'result', value: { v: 1, state: 'pending' } });
    expect([...h.records.keys()].filter(key => key.startsWith('pairing.grant.'))).toHaveLength(0);
    expect(await h.pairing.result({
      requestHandle: created.requestHandle,
      receipt: 'r'.repeat(43),
      operationId: 'result_bad',
      jkt: JKT,
    })).toEqual({ kind: 'invalid' });
  });

  it('derives one 256-bit grant from approval, recovers it on retry, and never reissues it after 60 seconds', async () => {
    const h = harness();
    const { created, result: winner } = await claimed(h);
    expect((await approve(h, created.requestHandle)).kind).toBe('decided');
    const input = { requestHandle: created.requestHandle, receipt: winner.receipt, operationId: 'result_1', jkt: JKT };
    const first = await h.pairing.result(input);
    expect(first).toMatchObject({ kind: 'result', value: { v: 1, state: 'approved' } });
    if (first.kind !== 'result' || first.value.state !== 'approved') throw new Error('result failed');
    expect(first.value.grant).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(first.value.grant, 'base64url')).toHaveLength(32);
    expect(await h.pairing.result(input)).toEqual(first);
    expect(await h.pairing.result({ ...input, operationId: 'result_other' })).toEqual({ kind: 'invalid' });
    expect([...h.records.keys()].filter(key => key.startsWith('pairing.grant.'))).toHaveLength(1);

    h.setNow(Date.parse(first.value.expiresAt));
    expect(await h.pairing.result(input)).toEqual({ kind: 'result', value: { v: 1, state: 'expired' } });
    expect([...h.records.keys()].filter(key => key.startsWith('pairing.grant.'))).toHaveLength(1);
  });

  it('recovers grant creation after a lost write response and reports denial without creating one', async () => {
    const approved = harness();
    const approvedClaim = await claimed(approved);
    await approve(approved, approvedClaim.created.requestHandle);
    approved.inject('compareAndSet', 'lose_response');
    expect(await approved.pairing.result({
      requestHandle: approvedClaim.created.requestHandle,
      receipt: approvedClaim.result.receipt,
      operationId: 'result_lost',
      jkt: JKT,
    })).toMatchObject({ kind: 'result', value: { state: 'approved' } });

    const denied = harness();
    const deniedClaim = await claimed(denied);
    const inspected = await denied.pairing.inspect({ ownerId: OWNER, requestHandle: deniedClaim.created.requestHandle });
    if (inspected.kind !== 'found' || !inspected.projection.claim) throw new Error('inspect failed');
    await denied.pairing.decide({
      ownerId: OWNER,
      requestHandle: deniedClaim.created.requestHandle,
      revision: inspected.revision,
      claimFingerprint: inspected.projection.claim.fingerprint,
      decision: 'deny',
      operationId: 'deny_1',
    });
    expect(await denied.pairing.result({
      requestHandle: deniedClaim.created.requestHandle,
      receipt: deniedClaim.result.receipt,
      operationId: 'result_denied',
      jkt: JKT,
    })).toMatchObject({ kind: 'result', value: { state: 'denied' } });
    expect([...denied.records.keys()].filter(key => key.startsWith('pairing.grant.'))).toHaveLength(0);
  });

  it('expires an issued grant when persistence reaches its exact lifetime boundary', async () => {
    const h = harness();
    const { created, result: winner } = await claimed(h);
    await approve(h, created.requestHandle);
    h.interceptWrites(input => {
      const value = input.next.value as { recordType?: unknown; state?: unknown; binding?: { expiresAt?: unknown } };
      if (value.recordType === 'pairing_grant' && value.state === 'unspent' && typeof value.binding?.expiresAt === 'string') {
        h.setNow(Date.parse(value.binding.expiresAt));
      }
    });

    expect(await h.pairing.result({
      requestHandle: created.requestHandle,
      receipt: winner.receipt,
      operationId: 'result_boundary',
      jkt: JKT,
    })).toEqual({ kind: 'result', value: { v: 1, state: 'expired' } });
    expect([...h.records.values()].find(record => record.key.startsWith('pairing.grant.'))?.value)
      .toMatchObject({ state: 'expired' });
  });

  it('persists the exact immutable approval/denial binding without raw receipt', async () => {
    for (const decision of ['approve', 'deny'] as const) {
      const h = harness();
      const { created, result: winner } = await claimed(h);
      const inspected = await h.pairing.inspect({ ownerId: OWNER, requestHandle: created.requestHandle });
      if (inspected.kind !== 'found' || !inspected.projection.claim) throw new Error('inspect failed');
      await h.pairing.decide({
        ownerId: OWNER,
        requestHandle: created.requestHandle,
        revision: inspected.revision,
        claimFingerprint: inspected.projection.claim.fingerprint,
        decision,
        operationId: `${decision}_binding`,
      });
      const snapshot = JSON.stringify([...h.records]);
      for (const expected of [OWNER, CHANNEL, createInput.origin, createInput.descriptorId, JKT, DEVICE, 'thread_1', inspected.projection.claim.fingerprint]) {
        expect(snapshot).toContain(expected);
      }
      expect(snapshot).not.toContain(winner.receipt);
    }
  });

  it('allows one bound-key redeem winner and reconciles only that operation after response loss', async () => {
    const h = harness();
    const { created, result: winner } = await claimed(h);
    await approve(h, created.requestHandle);
    const result = await h.pairing.result({ requestHandle: created.requestHandle, receipt: winner.receipt, operationId: 'result_1', jkt: JKT });
    if (result.kind !== 'result' || result.value.state !== 'approved') throw new Error('result failed');

    expect(await h.pairing.grantPort.redeem({ grant: result.value.grant, operationId: 'redeem_wrong_key', jkt: OTHER_JKT, ...BOUND }))
      .toEqual({ kind: 'invalid_grant' });
    for (const wrong of [
      { session: { ...BOUND.session, sessionId: 'thread_2' } },
      { session: { ...BOUND.session, generation: 4 } },
      { deviceId: 'device_2' },
    ]) {
      expect(await h.pairing.grantPort.redeem({ grant: result.value.grant, operationId: 'redeem_wrong_binding', jkt: JKT, ...BOUND, ...wrong }))
        .toEqual({ kind: 'invalid_grant' });
    }
    h.inject('compareAndSet', 'lose_response');
    const redeemed = await h.pairing.grantPort.redeem({ grant: result.value.grant, operationId: 'redeem_1', jkt: JKT, ...BOUND });
    expect(redeemed).toMatchObject({ kind: 'redeemed', authorization: { ownerId: OWNER, channelId: CHANNEL, jkt: JKT } });
    expect(await h.pairing.grantPort.redeem({ grant: result.value.grant, operationId: 'redeem_1', jkt: JKT, ...BOUND })).toEqual(redeemed);
    expect(await h.pairing.grantPort.redeem({ grant: result.value.grant, operationId: 'redeem_2', jkt: JKT, ...BOUND }))
      .toEqual({ kind: 'invalid_grant' });
    expect(await h.pairing.result({
      requestHandle: created.requestHandle,
      receipt: winner.receipt,
      operationId: 'result_1',
      jkt: JKT,
    })).toEqual({ kind: 'result', value: { v: 1, state: 'expired' } });
  });

  it('gives exactly one of two synchronized grant spends the bounded authorization', async () => {
    const h = harness();
    const { created, result: winner } = await claimed(h);
    await approve(h, created.requestHandle);
    const result = await h.pairing.result({ requestHandle: created.requestHandle, receipt: winner.receipt, operationId: 'result_1', jkt: JKT });
    if (result.kind !== 'result' || result.value.state !== 'approved') throw new Error('result failed');
    const rendezvous = barrier(2);
    h.interceptWrites(async input => {
      const value = input.next.value as { state?: unknown };
      if (input.key.startsWith('pairing.grant.') && value.state === 'spent') await rendezvous();
    });
    const outcomes = await Promise.all([
      h.pairing.grantPort.redeem({ grant: result.value.grant, operationId: 'redeem_a', jkt: JKT, ...BOUND }),
      h.pairing.grantPort.redeem({ grant: result.value.grant, operationId: 'redeem_b', jkt: JKT, ...BOUND }),
    ]);
    expect(outcomes.filter(outcome => outcome.kind === 'redeemed')).toHaveLength(1);
    expect(outcomes.filter(outcome => outcome.kind === 'invalid_grant')).toHaveLength(1);
    const authorization = outcomes.find(outcome => outcome.kind === 'redeemed');
    expect((authorization as { authorization: PairingBootstrapAuthorization }).authorization).not.toHaveProperty('grant');
  });
});

describe('PairingStore DPoP replay and secrecy', () => {
  it('preserves a claimed replay identity while the old namespace key is retained during rotation', async () => {
    const backing = fakeControlStore();
    const replay = { jkt: JKT, jti: 'proof_before_rotation', expiresAt: new Date(T0 + 60_000).toISOString() };
    const beforeRotation = createPairingStore({
      store: backing.store,
      policy: createPairingPolicy(keyring('key-1', [{ id: 'key-1', key: key(1) }])),
      clock: () => T0,
    });
    const duringRotation = createPairingStore({
      store: backing.store,
      policy: createPairingPolicy(keyring('key-2', [
        { id: 'key-2', key: key(2) },
        { id: 'key-1', key: key(1) },
      ])),
      clock: () => T0,
    });

    expect(await beforeRotation.claimProofReplay(replay)).toEqual({ kind: 'claimed' });
    expect(await duringRotation.claimProofReplay(replay)).toEqual({ kind: 'replayed' });
    expect([...backing.records.keys()].filter(recordKey => recordKey.startsWith('pairing.replay.'))).toHaveLength(1);
  });

  it('atomically claims an expiring (jkt,jti) replay record and fails closed', async () => {
    const h = harness();
    const replay = { jkt: JKT, jti: 'proof_1', expiresAt: new Date(T0 + 60_000).toISOString() };
    const rendezvous = barrier(2);
    h.interceptWrites(async input => {
      if (input.key.startsWith('pairing.replay.')) await rendezvous();
    });
    const results = await Promise.all([h.pairing.claimProofReplay(replay), h.pairing.claimProofReplay(replay)]);
    expect(results.filter(result => result.kind === 'claimed')).toHaveLength(1);
    expect(results.filter(result => result.kind === 'replayed')).toHaveLength(1);

    const failed = harness();
    failed.inject('compareAndSet', 'throw');
    expect(await failed.pairing.claimProofReplay(replay)).toEqual({ kind: 'unavailable' });
  });

  it('maps replay write-identity randomness failures to unavailable', async () => {
    const h = harness({ random: () => { throw new Error('entropy provider leaked proof=secret'); } });
    expect(await h.pairing.claimProofReplay({
      jkt: JKT,
      jti: 'proof_random_failure',
      expiresAt: new Date(T0 + 60_000).toISOString(),
    })).toEqual({ kind: 'unavailable' });
  });

  it('never places raw code, receipt, or grant in fake-store keys, values, operation diagnostics, or errors', async () => {
    const h = harness();
    const { created, result: winner } = await claimed(h);
    await approve(h, created.requestHandle);
    const result = await h.pairing.result({ requestHandle: created.requestHandle, receipt: winner.receipt, operationId: 'result_1', jkt: JKT });
    if (result.kind !== 'result' || result.value.state !== 'approved') throw new Error('result failed');
    await h.pairing.grantPort.redeem({ grant: result.value.grant, operationId: 'redeem_1', jkt: JKT, ...BOUND });
    const snapshot = JSON.stringify({
      records: [...h.records],
      operations: [...h.operations],
      diagnostics: h.diagnostics,
    });
    for (const secret of [created.code, winner.receipt, result.value.grant]) expect(snapshot).not.toContain(secret);
    for (const record of h.records.values()) expect(record.expiresAt).toBeNull();
  });
});

describe('PairingStore persisted-record validation', () => {
  it.each([
    ['approved request carrying deny', (value: Record<string, JsonValue>) => {
      (value.decision as Record<string, JsonValue>).kind = 'deny';
    }],
    ['denied request carrying approve', (value: Record<string, JsonValue>) => {
      value.state = 'denied';
      (value.decision as Record<string, JsonValue>).kind = 'approve';
    }],
    ['decision fingerprint differing from claim', (value: Record<string, JsonValue>) => {
      (value.decision as Record<string, JsonValue>).fingerprint = 'x'.repeat(43);
    }],
    ['claim not strictly after creation', (value: Record<string, JsonValue>) => {
      (value.claim as Record<string, JsonValue>).claimedAt = value.createdAt as string;
    }],
    ['decision before claim', (value: Record<string, JsonValue>) => {
      const claimedAt = Date.parse((value.claim as Record<string, JsonValue>).claimedAt as string);
      (value.decision as Record<string, JsonValue>).decidedAt = new Date(claimedAt - 1).toISOString();
    }],
    ['decision at request expiry', (value: Record<string, JsonValue>) => {
      (value.decision as Record<string, JsonValue>).decidedAt = value.expiresAt as string;
    }],
    ['issued state retaining a claim', (value: Record<string, JsonValue>) => {
      value.state = 'issued';
      value.decision = null;
    }],
  ] as const)('fails closed for corrupt request: %s', async (_name, corrupt) => {
    const h = harness();
    const { created } = await claimed(h);
    await approve(h, created.requestHandle);
    const entry = [...h.records].find(([recordKey]) => recordKey.startsWith('pairing.request.'));
    if (!entry) throw new Error('request record missing');
    const [recordKey, record] = entry;
    const value = structuredClone(record.value) as Record<string, JsonValue>;
    corrupt(value);
    h.records.set(recordKey, { ...record, revision: 'corrupt-request', value });
    expect(await h.pairing.inspect({ ownerId: OWNER, requestHandle: created.requestHandle })).toEqual({ kind: 'unavailable' });
  });

  it.each([
    ['top-level request handle differs from binding', (value: Record<string, JsonValue>) => {
      value.requestHandle = `pair_${'z'.repeat(43)}`;
    }],
    ['grant expires at approval', (value: Record<string, JsonValue>) => {
      const binding = value.binding as Record<string, JsonValue>;
      binding.expiresAt = binding.approvedAt as string;
    }],
    ['grant lifetime is not exactly sixty seconds', (value: Record<string, JsonValue>) => {
      const binding = value.binding as Record<string, JsonValue>;
      binding.expiresAt = new Date(Date.parse(binding.approvedAt as string) + 59_000).toISOString();
    }],
  ] as const)('fails closed for corrupt grant: %s', async (_name, corrupt) => {
    const h = harness();
    const { created, result: winner } = await claimed(h);
    await approve(h, created.requestHandle);
    const issued = await h.pairing.result({ requestHandle: created.requestHandle, receipt: winner.receipt, operationId: 'issue', jkt: JKT });
    if (issued.kind !== 'result' || issued.value.state !== 'approved') throw new Error('grant issue failed');
    const entry = [...h.records].find(([recordKey]) => recordKey.startsWith('pairing.grant.'));
    if (!entry) throw new Error('grant record missing');
    const [recordKey, record] = entry;
    const value = structuredClone(record.value) as Record<string, JsonValue>;
    corrupt(value);
    h.records.set(recordKey, { ...record, revision: 'corrupt-grant', value });
    expect(await h.pairing.grantPort.redeem({ grant: issued.value.grant, operationId: 'redeem', jkt: JKT, ...BOUND }))
      .toEqual({ kind: 'unavailable' });
  });
});

class MemoryBlobs implements BlobsStoreLike {
  private readonly entries = new Map<string, { data: unknown; etag: string }>();
  private revision = 0;

  async getWithMetadata(key: string) {
    const entry = this.entries.get(key);
    return entry ? structuredClone(entry) : null;
  }

  async setJSON(key: string, data: unknown, options: { onlyIfMatch?: string; onlyIfNew?: boolean } = {}) {
    const current = this.entries.get(key);
    const allowed = options.onlyIfNew ? current === undefined : options.onlyIfMatch !== undefined ? current?.etag === options.onlyIfMatch : true;
    if (!allowed) return { modified: false };
    const etag = `blob-r${++this.revision}`;
    this.entries.set(key, { data: structuredClone(data), etag });
    return { modified: true, etag };
  }
}

describe('PairingStore real ControlStore adapter chain', () => {
  it('runs create, claim, approve, issue, and redeem through the production adapter', async () => {
    let now = T0;
    const store = createControlStore({ records: new MemoryBlobs(), operations: new MemoryBlobs(), clock: () => now });
    const pairing: PairingStore = createPairingStore({ store, policy: createPairingPolicy(keyring()), clock: () => now });
    const created = await pairing.create(createInput);
    if (created.kind !== 'created') throw new Error('create failed');
    const winner = await pairing.claim(claimInput({ code: created.code }));
    if (winner.kind !== 'claimed') throw new Error('claim failed');
    const inspected = await pairing.inspect({ ownerId: OWNER, requestHandle: created.requestHandle });
    if (inspected.kind !== 'found' || !inspected.projection.claim) throw new Error('inspect failed');
    expect((await pairing.decide({
      ownerId: OWNER,
      requestHandle: created.requestHandle,
      revision: inspected.revision,
      claimFingerprint: inspected.projection.claim.fingerprint,
      decision: 'approve',
      operationId: 'approve_1',
    })).kind).toBe('decided');
    const result = await pairing.result({ requestHandle: created.requestHandle, receipt: winner.receipt, operationId: 'result_1', jkt: JKT });
    if (result.kind !== 'result' || result.value.state !== 'approved') throw new Error('result failed');
    expect((await pairing.grantPort.redeem({ grant: result.value.grant, operationId: 'redeem_1', jkt: JKT, ...BOUND })).kind).toBe('redeemed');
    expect(await pairing.result({
      requestHandle: created.requestHandle,
      receipt: winner.receipt,
      operationId: 'result_1',
      jkt: JKT,
    })).toEqual({ kind: 'result', value: { v: 1, state: 'expired' } });
    now += 60_000;
  });

  it('allows a replay key to be reclaimed only after its physical TTL is logically expired', async () => {
    let now = T0;
    const store = createControlStore({ records: new MemoryBlobs(), operations: new MemoryBlobs(), clock: () => now });
    const pairing = createPairingStore({ store, policy: createPairingPolicy(keyring()), clock: () => now });
    const first = { jkt: JKT, jti: 'proof_reusable_after_window', expiresAt: new Date(now + 60_000).toISOString() };
    expect(await pairing.claimProofReplay(first)).toEqual({ kind: 'claimed' });
    expect(await pairing.claimProofReplay(first)).toEqual({ kind: 'replayed' });
    now += 60_000;
    expect(await pairing.claimProofReplay({ ...first, expiresAt: new Date(now + 60_000).toISOString() })).toEqual({ kind: 'claimed' });
  });
});
