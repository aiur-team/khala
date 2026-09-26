import {
  type AuthorizedChannelRef,
  type ChannelAccessAuthorization,
  type CompareAndSetInput,
  type ControlRecord,
  type ControlStore,
  type DeviceId,
  type GrantExchangeRequest,
  type JsonValue,
  type OwnerId,
  type StableAgentPrincipal,
  type ValidatedGrantExchangeRequest,
  deriveOkpKeyThumbprint,
  sameJsonValue,
  validateGrantExchangeRequest,
} from '@khala/contracts/messaging/index';
import sodium from 'libsodium-wrappers';
import { describe, expect, it } from 'vitest';
import type {
  ChannelAdmissionProviderPort,
  ChannelAdmissionReconciliation,
  ChannelAdmissionRequest,
  ChannelAdmissionResult,
  GrantExchangeAuthorityInput,
  GrantExchangeAuthorityPort,
  GrantExchangeAuthorityResult,
  GrantIssuerPort,
} from './ports';

export const T0 = Date.parse('2026-09-25T12:00:00Z');
export const OWNER = 'owner_1' as OwnerId;
export const CHANNEL = 'channel_ref_1' as AuthorizedChannelRef;
export const REQUESTER = 'principal_1' as StableAgentPrincipal;
export const ORIGIN = 'https://khala.example';
export const FINGERPRINT = 'f'.repeat(43);
export const DEVICE = 'device_agent_1' as DeviceId;
export const DEADLINE = new Date(T0 + 3 * 24 * 60 * 60_000).toISOString();

/**
 * `claim_then_fail` models a per-key provider whose adapter claims the operation ID in a
 * ledger before writing the record (see `ControlStore`): the ID is spent, nothing lands.
 */
type Fault = 'unavailable' | 'throw' | 'lose_response' | 'claim_then_fail';

export function fakeControlStore() {
  const records = new Map<string, ControlRecord>();
  const operations = new Map<string, { key: string; next: CompareAndSetInput['next']; record: ControlRecord | null }>();
  const faults: Partial<Record<'read' | 'compareAndSet' | 'resolve', Fault[]>> = {};
  let revision = 0;
  let now = () => T0;
  const take = (operation: keyof typeof faults) => faults[operation]?.shift();
  const live = (record: ControlRecord | undefined) =>
    record && (record.expiresAt === null || now() < Date.parse(record.expiresAt)) ? record : undefined;
  const store: ControlStore = {
    async read<T extends JsonValue>(recordKey: string) {
      const fault = take('read');
      if (fault === 'throw') throw new Error('secret provider detail');
      if (fault) return { kind: 'unavailable' as const };
      const record = live(records.get(recordKey));
      return record ? { kind: 'record' as const, record: record as ControlRecord<T> } : { kind: 'absent' as const };
    },
    async compareAndSet<T extends JsonValue>(input: CompareAndSetInput<T>) {
      const fault = take('compareAndSet');
      if (fault === 'throw') throw new Error('secret provider detail');
      if (fault === 'unavailable') return { kind: 'unavailable' as const };
      const previous = operations.get(input.operationId);
      if (fault === 'claim_then_fail') {
        if (!previous) operations.set(input.operationId, { key: input.key, next: structuredClone(input.next), record: null });
        return { kind: 'unavailable' as const };
      }
      if (previous && previous.record === null) {
        if (previous.key !== input.key || previous.next.expiresAt !== input.next.expiresAt
          || !sameJsonValue(previous.next.value, input.next.value)) return { kind: 'operation_mismatch' as const };
        operations.delete(input.operationId);
      } else if (previous) {
        return previous.key === input.key
          && previous.next.expiresAt === input.next.expiresAt
          && sameJsonValue(previous.next.value, input.next.value)
          ? { kind: 'applied' as const, record: previous.record as ControlRecord<T> }
          : { kind: 'operation_mismatch' as const };
      }
      const current = live(records.get(input.key)) ?? null;
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
      return operation?.key === input.key && operation.record !== null
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
    useClock(clock: () => number) { now = clock; },
  };
}

export function authorization(overrides: Partial<ChannelAccessAuthorization> = {}): ChannelAccessAuthorization {
  return {
    v: 1,
    kind: 'access',
    authorizationRef: 'auth_ref_1',
    requestHandle: `careq_${'a'.repeat(43)}` as ChannelAccessAuthorization['requestHandle'],
    requestRevision: 'carev_3',
    operationId: 'op_access_1',
    ownerId: OWNER,
    requester: REQUESTER,
    origin: ORIGIN,
    sessionGeneration: 3,
    sessionFingerprint: FINGERPRINT,
    deadline: DEADLINE,
    channelRef: CHANNEL,
    ...overrides,
  } as ChannelAccessAuthorization;
}

export function fakeAuthority() {
  const calls: GrantExchangeAuthorityInput[] = [];
  const closes: string[] = [];
  const closeResults: ('closed' | 'unavailable')[] = [];
  const state: { next: (input: GrantExchangeAuthorityInput, call: number) => GrantExchangeAuthorityResult } = {
    next: input => ({ kind: 'authorized', authorization: authorization({ operationId: input.operationId }) }),
  };
  const port: GrantExchangeAuthorityPort = {
    async authorize(input) {
      calls.push(input);
      return state.next(input, calls.length);
    },
    async close(input) {
      closes.push(input.operationId);
      return closeResults.shift() ?? 'closed';
    },
  };
  return { port, calls, closes, closeResults, state };
}

export type ProviderBehavior = 'ok' | 'reject' | 'unavailable' | 'crash_before' | 'commit_then_lose' | 'unknown';

export function fakeProvider() {
  const applied = new Map<string, ChannelAdmissionRequest>();
  const admits: ChannelAdmissionRequest[] = [];
  const reconciles: ChannelAdmissionRequest[] = [];
  const behavior: { admit: ProviderBehavior[]; reconcile: ('proof' | 'unknown' | 'unavailable')[] } = {
    admit: [],
    reconcile: [],
  };
  const port: ChannelAdmissionProviderPort = {
    async admit(input): Promise<ChannelAdmissionResult> {
      admits.push(input);
      const mode = behavior.admit.shift() ?? 'ok';
      if (mode === 'crash_before') throw new Error('process crashed before invocation');
      if (mode === 'reject') return { kind: 'rejected' };
      if (mode === 'unavailable') return { kind: 'unavailable' };
      if (mode === 'unknown') return { kind: 'outcome_unknown' };
      const membership = applied.has(input.providerOperationId) ? 'already_joined' : 'joined';
      applied.set(input.providerOperationId, input);
      if (mode === 'commit_then_lose') throw new Error('response lost after commit');
      return { kind: 'admitted', membership };
    },
    async reconcile(input): Promise<ChannelAdmissionReconciliation> {
      reconciles.push(input);
      const mode = behavior.reconcile.shift() ?? 'proof';
      if (mode === 'unknown') return { kind: 'outcome_unknown' };
      if (mode === 'unavailable') return { kind: 'unavailable' };
      return applied.has(input.providerOperationId)
        ? { kind: 'admitted', membership: 'joined' }
        : { kind: 'not_applied' };
    },
  };
  return { port, applied, admits, reconciles, behavior };
}

export function fakeIssuer() {
  const minted: string[] = [];
  const bindings: Parameters<GrantIssuerPort['mint']>[0][] = [];
  const state = { unavailable: false };
  const port: GrantIssuerPort = {
    async mint(input) {
      if (state.unavailable) return { kind: 'unavailable' };
      await sodium.ready;
      const grant = `cagrant_${sodium.to_base64(sodium.randombytes_buf(32), sodium.base64_variants.URLSAFE_NO_PADDING)}`;
      minted.push(grant);
      bindings.push(input);
      return { kind: 'minted', grant };
    },
  };
  return { port, minted, bindings, state };
}

export type ConnectorKeys = Awaited<ReturnType<typeof connectorKeys>>;

export async function connectorKeys() {
  await sodium.ready;
  const encode = (bytes: Uint8Array) => sodium.to_base64(bytes, sodium.base64_variants.URLSAFE_NO_PADDING);
  const proofPublic = encode(sodium.crypto_sign_keypair().publicKey);
  const box = sodium.crypto_box_keypair();
  const proof = await deriveOkpKeyThumbprint({ algorithm: 'Ed25519', publicKey: proofPublic, thumbprint: '' });
  const encryption = await deriveOkpKeyThumbprint({ algorithm: 'X25519', publicKey: encode(box.publicKey), thumbprint: '' });
  if (!proof.ok || !encryption.ok) throw new Error('crypto unavailable');
  return {
    proofKey: { algorithm: 'Ed25519' as const, publicKey: proofPublic, thumbprint: proof.thumbprint },
    encryptionKey: { algorithm: 'X25519' as const, publicKey: encode(box.publicKey), thumbprint: encryption.thumbprint },
    box,
  };
}

export async function validatedRequest(
  keys: ConnectorKeys,
  overrides: Partial<GrantExchangeRequest> = {},
  nowMs = T0,
): Promise<ValidatedGrantExchangeRequest> {
  const request: GrantExchangeRequest = {
    v: 1,
    operationId: 'op_access_1',
    requester: REQUESTER,
    origin: ORIGIN,
    proofKey: keys.proofKey,
    encryptionKey: keys.encryptionKey,
    deviceId: DEVICE,
    sessionGeneration: 3,
    expiresAt: new Date(nowMs + 60_000).toISOString(),
    ...overrides,
  };
  const validated = await validateGrantExchangeRequest(request, {
    operationId: request.operationId,
    requester: request.requester,
    origin: request.origin,
    sessionGeneration: request.sessionGeneration,
    deviceId: request.deviceId,
    proofKeyThumbprint: request.proofKey.thumbprint,
    nowMs,
  });
  if (!validated.ok) throw new Error(`fixture request invalid: ${validated.reason}`);
  return validated.request;
}

export function openEnvelope(ciphertext: string, keys: ConnectorKeys): unknown {
  const bytes = sodium.from_base64(ciphertext, sodium.base64_variants.URLSAFE_NO_PADDING);
  return JSON.parse(sodium.to_string(sodium.crypto_box_seal_open(bytes, keys.box.publicKey, keys.box.privateKey)));
}

describe('grant exchange test doubles', () => {
  it('replays an identical store write and refuses a changed one', async () => {
    const backing = fakeControlStore();
    const next = { value: { a: 1 }, expiresAt: null };
    const first = await backing.store.compareAndSet({ key: 'k', expectedRevision: null, operationId: 'op', next });
    expect(await backing.store.compareAndSet({ key: 'k', expectedRevision: null, operationId: 'op', next })).toEqual(first);
    expect(await backing.store.compareAndSet({ key: 'k', expectedRevision: null, operationId: 'op', next: { value: { a: 2 }, expiresAt: null } }))
      .toEqual({ kind: 'operation_mismatch' });
  });
});
