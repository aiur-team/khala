// One-time grant issuer for the channel-access exchange. A grant is 256
// random bits returned exactly once for sealing; storage keeps only a
// purpose-separated SHA-256 hash, its bound tuple and a short expiry. Redemption
// (used by `channel-access-activation`) is bound to the same tuple and consumes
// the operation by compare-and-set, so at most one grant per operation is ever
// redeemed, even if a crashed exchange minted an unsealed one first.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type {
  AuthorizedChannelRef,
  CallOptions,
  ControlStore,
  DeviceId,
  OwnerId,
  StableAgentPrincipal,
  TrustedClock,
} from '@khala/contracts/messaging/index';

export type ExchangeGrantBinding = Readonly<{
  operationId: string;
  requester: StableAgentPrincipal;
  origin: string;
  sessionGeneration: number;
  deviceId: DeviceId;
  proofKeyThumbprint: string;
  ownerId: OwnerId;
  channelRef: AuthorizedChannelRef;
}>;

export type ExchangeGrantRedemption = Readonly<{
  grant: string;
  operationId: string;
  requester: StableAgentPrincipal;
  origin: string;
  sessionGeneration: number;
  deviceId: DeviceId;
  proofKeyThumbprint: string;
}>;

export type ExchangeGrantRedeemResult =
  | Readonly<{ kind: 'redeemed'; binding: ExchangeGrantBinding }>
  | Readonly<{ kind: 'rejected'; code: 'invalid_grant' | 'expired' | 'grant_replayed' }>
  | Readonly<{ kind: 'unavailable' }>;

export type ExchangeGrantIssuer = Readonly<{
  mint(
    input: Readonly<{ binding: ExchangeGrantBinding; expiresAt: string }>,
    options?: CallOptions,
  ): Promise<Readonly<{ kind: 'minted'; grant: string }> | Readonly<{ kind: 'unavailable' }>>;
  redeem(input: ExchangeGrantRedemption, options?: CallOptions): Promise<ExchangeGrantRedeemResult>;
  /**
   * Read-only: the bound tuple of a grant this exact tuple already redeemed. It lets a
   * consumer that crashed after `redeem` finish the same activation; it never consumes.
   */
  consumed(input: ExchangeGrantRedemption, options?: CallOptions): Promise<ExchangeGrantConsumedResult>;
}>;

export type ExchangeGrantConsumedResult =
  | Readonly<{ kind: 'consumed'; binding: ExchangeGrantBinding }>
  | Readonly<{ kind: 'rejected'; code: 'invalid_grant' | 'not_consumed' }>
  | Readonly<{ kind: 'unavailable' }>;

const GRANT_PREFIX = 'cagrant_';
const GRANT = /^cagrant_[A-Za-z0-9_-]{43}$/;
const BINDING_FIELDS = [
  'operationId', 'requester', 'origin', 'sessionGeneration', 'deviceId', 'proofKeyThumbprint', 'ownerId', 'channelRef',
] as const;

export function createExchangeGrantIssuer(deps: Readonly<{
  store: ControlStore;
  clock: TrustedClock;
  random?: (bytes: number) => Uint8Array;
}>): ExchangeGrantIssuer {
  const random = deps.random ?? ((bytes: number) => new Uint8Array(randomBytes(bytes)));

  async function mint(
    input: Readonly<{ binding: ExchangeGrantBinding; expiresAt: string }>,
    options?: CallOptions,
  ): Promise<Readonly<{ kind: 'minted'; grant: string }> | Readonly<{ kind: 'unavailable' }>> {
    if (deps.clock() >= Date.parse(input.expiresAt)) return { kind: 'unavailable' };
    const bytes = random(32);
    if (bytes.byteLength !== 32) return { kind: 'unavailable' };
    const grant = `${GRANT_PREFIX}${Buffer.from(bytes).toString('base64url')}`;
    const key = grantKey(grant);
    const result = await safe(() => deps.store.compareAndSet({
      key,
      expectedRevision: null,
      operationId: `${key}#mint`,
      next: { value: { v: 1, binding: { ...input.binding }, expiresAt: input.expiresAt }, expiresAt: input.expiresAt },
    }, options));
    if (result?.kind === 'applied') return { kind: 'minted', grant };
    if (result?.kind === 'outcome_unknown') {
      const resolved = await safe(() => deps.store.resolve({ key, operationId: `${key}#mint` }, options));
      if (resolved?.kind === 'applied') return { kind: 'minted', grant };
    }
    return { kind: 'unavailable' };
  }

  /** The stored grant for this exact bound tuple, or why it is not one. */
  async function presented(input: ExchangeGrantRedemption, options?: CallOptions): Promise<
    | Readonly<{ kind: 'found'; key: string; stored: Readonly<{ binding: ExchangeGrantBinding; expiresAt: string }> }>
    | Readonly<{ kind: 'invalid_grant' }>
    | Readonly<{ kind: 'unavailable' }>
  > {
    if (!GRANT.test(input.grant)) return { kind: 'invalid_grant' };
    const key = grantKey(input.grant);
    const read = await safe(() => deps.store.read(key, options));
    if (read === null || read.kind === 'unavailable') return { kind: 'unavailable' };
    if (read.kind === 'absent') return { kind: 'invalid_grant' };
    const stored = readStoredGrant(read.record.value);
    if (stored === null) return { kind: 'unavailable' };
    const binding = stored.binding;
    if (binding.operationId !== input.operationId || binding.requester !== input.requester
      || binding.origin !== input.origin || binding.sessionGeneration !== input.sessionGeneration
      || binding.deviceId !== input.deviceId || !safeEqual(binding.proofKeyThumbprint, input.proofKeyThumbprint)) {
      return { kind: 'invalid_grant' };
    }
    return { kind: 'found', key, stored };
  }

  async function redeem(input: ExchangeGrantRedemption, options?: CallOptions): Promise<ExchangeGrantRedeemResult> {
    const found = await presented(input, options);
    if (found.kind === 'unavailable') return found;
    if (found.kind === 'invalid_grant') return { kind: 'rejected', code: 'invalid_grant' };
    const { key, stored } = found;
    const binding = stored.binding;
    if (deps.clock() >= Date.parse(stored.expiresAt)) return { kind: 'rejected', code: 'expired' };
    const consumed = consumedKey(binding);
    // Unique per attempt: an identical second presentation must conflict, not replay the first write.
    const operationId = `${consumed}#${Buffer.from(random(16)).toString('base64url')}`;
    const result = await safe(() => deps.store.compareAndSet({
      key: consumed,
      expectedRevision: null,
      operationId,
      next: { value: { v: 1, grantKey: key }, expiresAt: null },
    }, options));
    if (result === null || result.kind === 'unavailable') return { kind: 'unavailable' };
    // A second presentation is a replay even for the same operation, as in bootstrap redemption.
    if (result.kind === 'conflict' || result.kind === 'operation_mismatch') return { kind: 'rejected', code: 'grant_replayed' };
    if (result.kind === 'outcome_unknown') {
      const resolved = await safe(() => deps.store.resolve({ key: consumed, operationId }, options));
      if (resolved?.kind !== 'applied') return { kind: 'unavailable' };
    }
    return { kind: 'redeemed', binding };
  }

  async function consumedBy(input: ExchangeGrantRedemption, options?: CallOptions): Promise<ExchangeGrantConsumedResult> {
    const found = await presented(input, options);
    if (found.kind === 'unavailable') return found;
    if (found.kind === 'invalid_grant') return { kind: 'rejected', code: 'invalid_grant' };
    const read = await safe(() => deps.store.read(consumedKey(found.stored.binding), options));
    if (read === null || read.kind === 'unavailable') return { kind: 'unavailable' };
    // Consumed by this grant, not merely by another grant for the same operation.
    const record = read.kind === 'record' ? read.record.value as { grantKey?: unknown } | null : null;
    if (record?.grantKey !== found.key) return { kind: 'rejected', code: 'not_consumed' };
    return { kind: 'consumed', binding: found.stored.binding };
  }

  return Object.freeze({ mint, redeem, consumed: consumedBy });
}

function grantKey(grant: string): string {
  return `channel-access-grant/${createHash('sha256').update('khala.channel-access.grant.v1\0').update(grant).digest('hex')}`;
}

function consumedKey(binding: ExchangeGrantBinding): string {
  const digest = createHash('sha256')
    .update('khala.channel-access.grant-consumed.v1\0')
    .update(JSON.stringify([binding.requester, binding.origin, binding.operationId]))
    .digest('hex');
  return `channel-access-grant-consumed/${digest}`;
}

function readStoredGrant(value: unknown): Readonly<{ binding: ExchangeGrantBinding; expiresAt: string }> | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as { v?: unknown; binding?: unknown; expiresAt?: unknown };
  if (record.v !== 1 || typeof record.expiresAt !== 'string' || Number.isNaN(Date.parse(record.expiresAt))) return null;
  const binding = record.binding as Record<string, unknown> | null;
  if (typeof binding !== 'object' || binding === null || Object.keys(binding).length !== BINDING_FIELDS.length) return null;
  for (const field of BINDING_FIELDS) {
    const expected = field === 'sessionGeneration' ? 'number' : 'string';
    if (typeof binding[field] !== expected) return null;
  }
  return { binding: binding as unknown as ExchangeGrantBinding, expiresAt: record.expiresAt };
}

async function safe<T>(operation: () => Promise<T>): Promise<T | null> {
  try {
    return await operation();
  } catch {
    return null;
  }
}

function safeEqual(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
