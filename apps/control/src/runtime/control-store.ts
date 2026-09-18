// Netlify Blobs adapter for the KHA-105 `ControlStore` port. Injected SDK store
// and clock; no network connection opens at module import. Two independently
// CAS'd blob keys per write: the caller's own `key` holds the record, and a
// same-scope `operations` ledger keyed by `operationId` lets the adapter
// detect an operation ID reused for different content — including across two
// different target keys — without claiming cross-key atomicity: each ledger
// claim and each record write is only ever atomic on its own key.

import {
  type CompareAndSetInput,
  type ControlRead,
  type ControlRecord,
  type ControlStore,
  type JsonValue,
  type ResolveResult,
  type TrustedClock,
  type WriteResult,
  isRecordLive,
  sameJsonValue,
} from '@khala/contracts/messaging/control-store';

/** The subset of the `@netlify/blobs` `Store` API this adapter depends on. */
export interface BlobsStoreLike {
  getWithMetadata(
    key: string,
    options?: { type: 'json' },
  ): Promise<{ data: unknown; etag?: string } | null>;
  setJSON(
    key: string,
    data: unknown,
    options?: { onlyIfMatch?: string; onlyIfNew?: boolean },
  ): Promise<{ modified: boolean; etag?: string }>;
}

export type ControlStoreDeps = Readonly<{
  records: BlobsStoreLike;
  operations: BlobsStoreLike;
  clock: TrustedClock;
}>;

type StoredEnvelope = Readonly<{ operationId: string; value: JsonValue; expiresAt: string | null }>;
type LedgerEntry = Readonly<{ key: string; digest: string }>;

/**
 * A definite rejection is a completed round trip where the provider itself
 * reported the request was rejected before any write could have committed —
 * an explicit 4xx (bad request, unauthorized, precondition failed, …) — safe
 * to call `unavailable`. A 5xx, a `BlobsInternalError`, or a network-level
 * throw with no status is genuinely ambiguous: the provider's own commit may
 * have already landed, so the request's fate cannot be proven either way and
 * it is always `outcome_unknown`, never guessed at.
 */
function isDefiniteRejection(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' && status >= 400 && status < 500;
}

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 64) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(item => isJsonValue(item, depth + 1));
  if (typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return Object.values(value).every(item => isJsonValue(item, depth + 1));
}

/** Structural validation only; the caller's own domain owns the value's schema. */
function decodeEnvelope(data: unknown): StoredEnvelope | null {
  if (typeof data !== 'object' || data === null) return null;
  const { operationId, value, expiresAt } = data as Record<string, unknown>;
  if (typeof operationId !== 'string' || operationId.length === 0) return null;
  if (expiresAt !== null && typeof expiresAt !== 'string') return null;
  if (!isJsonValue(value)) return null;
  return { operationId, value, expiresAt: expiresAt as string | null };
}

/** Recursively sorts object keys so two JSON-equal values always digest identically. */
function canonicalize(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, JsonValue> = {};
    for (const key of Object.keys(value).sort()) sorted[key] = canonicalize((value as Record<string, JsonValue>)[key] as JsonValue);
    return sorted;
  }
  return value;
}

function digestOf(value: JsonValue, expiresAt: string | null): string {
  return JSON.stringify([canonicalize(value), expiresAt]);
}

function toRecord<T extends JsonValue>(key: string, etag: string | undefined, envelope: StoredEnvelope): ControlRecord<T> {
  return { key, revision: etag ?? '', operationId: envelope.operationId, value: envelope.value as T, expiresAt: envelope.expiresAt };
}

function sameWrite<T extends JsonValue>(record: ControlRecord<T> | null, operationId: string, value: T, expiresAt: string | null): boolean {
  return record !== null && record.operationId === operationId && record.expiresAt === expiresAt && sameJsonValue(record.value, value);
}

export function createControlStore(deps: ControlStoreDeps): ControlStore {
  const { records, operations, clock } = deps;

  async function readLive<T extends JsonValue>(key: string): Promise<{
    raw: { data: unknown; etag?: string } | null;
    live: ControlRecord<T> | null;
    corrupt: boolean;
    /** The decoded envelope regardless of liveness — lets `resolve` see an expired-but-decodable record's operation ID. */
    envelope: StoredEnvelope | null;
  }> {
    const raw = await records.getWithMetadata(key, { type: 'json' });
    if (raw === null) return { raw: null, live: null, corrupt: false, envelope: null };
    const envelope = decodeEnvelope(raw.data);
    if (envelope === null) return { raw, live: null, corrupt: true, envelope: null };
    if (!isRecordLive({ expiresAt: envelope.expiresAt }, clock())) return { raw, live: null, corrupt: false, envelope };
    return { raw, live: toRecord<T>(key, raw.etag, envelope), corrupt: false, envelope };
  }

  type ClaimResult =
    | Readonly<{ kind: 'claimed'; retry: boolean }>
    | Readonly<{ kind: 'mismatch' }>
    | Readonly<{ kind: 'unknown' }>
    | Readonly<{ kind: 'unavailable' }>;

  /**
   * Claims `operationId` in the ledger for this exact `(key, digest)`. Claiming
   * is itself a single-key CAS, so two concurrent claims for the same
   * operationId can never both win — this is what makes cross-key operation ID
   * reuse detectable without a cross-key transaction.
   *
   * `retry: true` means the ledger already held this exact claim before this
   * call — i.e. an earlier invocation (of this or another process) reached the
   * claim step for this same operation and content. That earlier invocation's
   * own record write may have landed and later been legitimately superseded;
   * this call cannot disprove that, so its caller must not report a definite
   * `conflict` off the strength of this claim alone.
   */
  async function claimOperation(operationId: string, key: string, digest: string): Promise<ClaimResult> {
    try {
      const result = await operations.setJSON(operationId, { key, digest } satisfies LedgerEntry, { onlyIfNew: true });
      if (result.modified) return { kind: 'claimed', retry: false };
    } catch (error) {
      return { kind: isDefiniteRejection(error) ? 'unavailable' : 'unknown' };
    }
    let entry: { data: unknown } | null;
    try {
      entry = await operations.getWithMetadata(operationId, { type: 'json' });
    } catch {
      return { kind: 'unknown' };
    }
    if (entry === null) return { kind: 'unknown' };
    const decoded = entry.data as Partial<LedgerEntry> | null;
    return decoded && decoded.key === key && decoded.digest === digest ? { kind: 'claimed', retry: true } : { kind: 'mismatch' };
  }

  return {
    async read<T extends JsonValue>(key: string): Promise<ControlRead<T>> {
      try {
        const { live, corrupt } = await readLive<T>(key);
        if (live) return { kind: 'record', record: live };
        if (corrupt) return { kind: 'unavailable' };
        return { kind: 'absent' };
      } catch {
        return { kind: 'unavailable' };
      }
    },

    async compareAndSet<T extends JsonValue>(input: CompareAndSetInput<T>): Promise<WriteResult<T>> {
      const digest = digestOf(input.next.value, input.next.expiresAt);

      const claim = await claimOperation(input.operationId, input.key, digest);
      if (claim.kind === 'mismatch') return { kind: 'operation_mismatch' };
      if (claim.kind === 'unavailable') return { kind: 'unavailable' };
      if (claim.kind === 'unknown') return { kind: 'outcome_unknown', operationId: input.operationId };
      const isRetry = claim.retry;

      let before: { raw: { data: unknown; etag?: string } | null; live: ControlRecord<T> | null };
      try {
        before = await readLive<T>(input.key);
      } catch (error) {
        return isDefiniteRejection(error) ? { kind: 'unavailable' } : { kind: 'outcome_unknown', operationId: input.operationId };
      }
      if (sameWrite(before.live, input.operationId, input.next.value, input.next.expiresAt)) {
        return { kind: 'applied', record: before.live as ControlRecord<T> };
      }
      if ((before.live?.revision ?? null) !== input.expectedRevision) {
        // A prior invocation already claimed this exact (operationId, digest)
        // in the ledger, and the key no longer shows our write as current. An
        // earlier round trip for this same operation could have landed and
        // then been legitimately superseded before we ever got here — that
        // earlier effect can't be disproved, so this is unknown, not a fresh
        // conflict.
        if (isRetry) return { kind: 'outcome_unknown', operationId: input.operationId };
        return { kind: 'conflict', current: before.live };
      }

      const envelope: StoredEnvelope = { operationId: input.operationId, value: input.next.value, expiresAt: input.next.expiresAt };
      const conditions: { onlyIfMatch: string } | { onlyIfNew: true } =
        before.raw && before.raw.etag !== undefined ? { onlyIfMatch: before.raw.etag } : { onlyIfNew: true };
      let result: { modified: boolean; etag?: string };
      try {
        result = await records.setJSON(input.key, envelope, conditions);
      } catch (error) {
        return isDefiniteRejection(error) ? { kind: 'unavailable' } : { kind: 'outcome_unknown', operationId: input.operationId };
      }
      if (result.modified) return { kind: 'applied', record: toRecord<T>(input.key, result.etag, envelope) };

      // The precondition failed: someone else raced us (or our own claimed
      // write already landed and we're seeing our own record). Read back
      // rather than guessing — this is the lost-response-recovery path.
      let after: { live: ControlRecord<T> | null };
      try {
        after = await readLive<T>(input.key);
      } catch (error) {
        return isDefiniteRejection(error) ? { kind: 'unavailable' } : { kind: 'outcome_unknown', operationId: input.operationId };
      }
      if (sameWrite(after.live, input.operationId, input.next.value, input.next.expiresAt)) {
        return { kind: 'applied', record: after.live as ControlRecord<T> };
      }
      // Same reasoning as the earlier conflict check: a retried claim means an
      // earlier invocation's write could have landed and since been
      // superseded, which this readback cannot disprove.
      if (isRetry) return { kind: 'outcome_unknown', operationId: input.operationId };
      return { kind: 'conflict', current: after.live };
    },

    async resolve<T extends JsonValue>(input: Readonly<{ key: string; operationId: string }>): Promise<ResolveResult<T>> {
      let current: Awaited<ReturnType<typeof readLive<T>>>;
      try {
        current = await readLive<T>(input.key);
      } catch {
        return { kind: 'unavailable' };
      }
      if (current.live !== null) {
        if (current.live.operationId === input.operationId) return { kind: 'applied', record: current.live };
        return { kind: 'outcome_unknown', operationId: input.operationId };
      }
      if (current.corrupt) return { kind: 'unavailable' };
      // The record is physically present but logically expired: its bytes
      // still prove whether our operation landed before expiry did, so this
      // still counts as evidence rather than a flat "never happened".
      if (current.envelope !== null) {
        if (current.envelope.operationId === input.operationId) {
          return { kind: 'applied', record: toRecord<T>(input.key, current.raw?.etag, current.envelope) };
        }
        return { kind: 'outcome_unknown', operationId: input.operationId };
      }
      return { kind: 'not_applied' };
    },
  };
}
