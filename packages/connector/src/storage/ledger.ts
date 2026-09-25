// The owner connector's application ledger: pending review items, replay cursors,
// recipient bindings, the approval command journal, releases and delivery receipts.
//
// Consumers (KHA-121/130/133/134/135) get a transaction-scoped port, not SQL. A
// transaction callback is synchronous local SQLite work only: no SDK, network, model
// or harness call can happen inside it, and a callback that returns a promise is
// rolled back. Errors roll the whole transaction back. When a commit's outcome is
// uncertain, reopen and read back the operation identity instead of retrying blind.

import type { DatabaseSync } from 'node:sqlite';
import {
  type ApprovalCommand, type ApprovalResult, type BindingId, type CommandId, type DeliveryLimits, type DeliveryReceiptTransport, type EventId,
  type EventRef, type OwnerId, type ReleaseId, type ReleasedJob, type RoomId, type SessionBinding,
  type UnverifiedReleasedJob, decodeApprovalCommand, decodeApprovalResult, decodeDeliveryReceiptTransport, decodeEventRef,
  decodeReleasedJob, decodeSessionBinding, sameEventRef, sameSessionBinding, verifyReleasedJob,
} from '@khala/contracts/delivery/index';
import { decodeWith, identifier, utcTimestamp, utf8Length } from '@khala/contracts/delivery/decode';
import {
  type DeviceId, type UnavailableEventRef, type UnavailableReason, UNAVAILABLE_REASONS, decodeUnavailableEventRef,
} from '@khala/contracts/messaging/index';
import { StorageError, toStorageError } from './errors';
import { assertEpoch } from './leases';
import { insertPayload, payloadExists, payloadReferences, readPayload, sha256Digest } from './payloads';

/** Local uniqueness is the event and its immutable recipient, never content alone. */
export type PendingKey = Readonly<{
  roomId: RoomId;
  eventId: EventId;
  recipientBindingId: BindingId;
  recipientGeneration: number;
}>;

export type PersistConflictCode =
  /** The same event identity arrived again with a different content digest. */
  | 'event_digest_mismatch'
  /** Same identity and digest, different attribution. */
  | 'event_ref_mismatch'
  /** The plaintext does not hash to the reference's content digest. */
  | 'content_digest_mismatch';

/** Why an event cannot be recorded for its recipient at all. Nothing is stored. */
export type RecipientBlockCode =
  /** No binding with this ID, or the key names a generation the ledger has not seen. */
  | 'binding_unknown'
  /** The key names a generation older than the binding's current one. */
  | 'stale_generation'
  /** The binding, at any generation, or its device is durably revoked. */
  | 'revoked';

export type PersistResult =
  /** `replaced`: a decrypted event took the place of its unavailable placeholder. */
  | Readonly<{ kind: 'inserted' | 'duplicate' | 'replaced' }>
  /** Quarantined: the stream's cursor stays blocked until the owner resolves it. */
  | Readonly<{ kind: 'conflict'; code: PersistConflictCode }>
  /**
   * The same conflict was already quarantined and the owner resolved it. Nothing is
   * stored and the stored record is unchanged; the cursor may move past this event.
   */
  | Readonly<{ kind: 'conflict_resolved'; code: PersistConflictCode }>
  | Readonly<{ kind: 'blocked'; code: RecipientBlockCode }>;

/** Placeholders never replace a decrypted record, so there is no `replaced` here. */
export type UnavailableResult = Exclude<PersistResult, Readonly<{ kind: 'inserted' | 'duplicate' | 'replaced' }>>
  | Readonly<{ kind: 'inserted' | 'duplicate' }>;

export type CursorResult =
  | Readonly<{ kind: 'committed'; revision: number }>
  | Readonly<{ kind: 'conflict'; code: 'stale_revision'; revision: number }>
  /** A conflict quarantined on this stream must be resolved before it may advance. */
  | Readonly<{ kind: 'blocked'; code: 'quarantine_unresolved' }>;

/** Immutable event reference, exact content bytes and recipient, stored together. */
export type PendingRecord = Readonly<{
  key: PendingKey;
  event: EventRef;
  content: Uint8Array;
  receivedAt: string;
  ledgerRevision: number;
}>;

/**
 * One idempotent approval: owner + command ID, the digest of its canonical input and
 * the committed result, so a retry replays the result and a changed input is refused.
 */
export type CommandRecord = Readonly<{
  ownerId: OwnerId;
  commandId: CommandId;
  inputDigest: string;
  /** Exact approval input. Null only for a command migrated from the v1 schema. */
  command: ApprovalCommand | null;
  result: ApprovalResult;
}>;

export type BindingResult =
  | Readonly<{ kind: 'inserted' | 'advanced' | 'duplicate' }>
  | Readonly<{ kind: 'conflict'; code: 'stale_generation' | 'binding_mismatch' | 'revoked' }>;

export type ReleaseConflictCode =
  | 'idempotency_conflict'
  /** The command record is not the approval, or not the owner, the job names. */
  | 'command_mismatch'
  | 'stale_ledger'
  | 'invalid_command_result'
  | 'stale_binding'
  /** The job's binding, at any generation, or its device is durably revoked. */
  | 'revoked'
  | 'pending_missing'
  | 'stale_content'
  /** A selected pending item already belongs to another release. */
  | 'already_released'
  | 'payload_digest_mismatch'
  | 'limit_exceeded'
  | 'release_conflict';

export type ReleaseResult =
  | Readonly<{ kind: 'committed' | 'duplicate' }>
  | Readonly<{ kind: 'conflict'; code: ReleaseConflictCode }>;

export type ReceiptResult =
  /** The canonical fact as stored, never a value regenerated from retry context. */
  | Readonly<{ kind: 'recorded' | 'duplicate'; receipt: DeliveryReceiptTransport }>
  /**
   * `unknown_release` and `correlation_mismatch` are still recorded for
   * reconciliation; `receipt_conflict` (same ID, different fact) is not.
   */
  | Readonly<{ kind: 'conflict'; code: 'receipt_conflict' | 'unknown_release' | 'correlation_mismatch' }>;

export type StoredRelease = Readonly<{
  ownerId: OwnerId;
  commandId: CommandId;
  job: UnverifiedReleasedJob;
  ledgerRevision: number;
}>;

export type ReceiptCorrelation = 'correlated' | 'unknown_release' | 'correlation_mismatch';

export type StoredReceipt = Readonly<{ receipt: DeliveryReceiptTransport; correlation: ReceiptCorrelation }>;

/**
 * A durable revocation. A revoked binding is blocked at every generation, including
 * later ones: it is never re-armed or revived, and re-bootstrap mints a new binding ID.
 * `generation` records the generation current when it was revoked. A revoked device
 * blocks every binding that delivers through it.
 */
export type RevocationRecord = Readonly<{
  operationId: string;
  generation: number;
  revokedAt: string;
}> & (
  | Readonly<{ targetKind: 'binding'; targetId: BindingId }>
  | Readonly<{ targetKind: 'device'; targetId: DeviceId }>
);

export type RevocationResult = Readonly<{ kind: 'recorded' | 'duplicate' }>;

/** An event held as unavailable for review; never approvable, never model-visible. */
export type PlaceholderRecord = Readonly<{
  key: PendingKey;
  ref: UnavailableEventRef;
  reason: UnavailableReason;
  receivedAt: string;
  ledgerRevision: number;
}>;

export type ApprovalSnapshot = Readonly<{
  kind: 'snapshot';
  binding: SessionBinding;
  /** Records for the binding's current generation, in selection order; absent ones are omitted. */
  pending: readonly PendingRecord[];
  ledgerRevision: number;
}>;

export interface LedgerTx {
  /**
   * One consistent snapshot for pure approval evaluation (KHA-119). `revoked` when the
   * binding or its device is revoked; `null` for an unknown binding.
   */
  readApprovalSnapshot(input: { bindingId: BindingId; selection: readonly EventRef[] }):
    ApprovalSnapshot | Readonly<{ kind: 'revoked' }> | null;
  readBinding(bindingId: BindingId): SessionBinding | null;
  /** Records a binding or advances it to a later generation; never rewinds. */
  putBinding(binding: SessionBinding): BindingResult;
  /** Records a revocation once; repeating it is `duplicate`. Revocations are never removed. */
  putRevocation(input: RevocationRecord): RevocationResult;
  /** Unreplaced placeholders for the binding's current generation. */
  readPlaceholders(bindingId: BindingId): readonly PlaceholderRecord[];
  readCommand(ownerId: OwnerId, commandId: CommandId): CommandRecord | null;
  /** Writes the command outcome, release payload and released job together, or nothing. */
  putRelease(input: {
    command: CommandRecord;
    job: ReleasedJob;
    payload: Uint8Array;
    expectedLedgerRevision: number;
  }): ReleaseResult;
  readRelease(releaseId: ReleaseId): StoredRelease | null;
  appendReceipt(input: { receipt: DeliveryReceiptTransport }): ReceiptResult;
  /** Every receipt recorded for the release, with how it correlated when it was recorded. */
  readReceipts(releaseId: ReleaseId): readonly StoredReceipt[];
  /** Live references to a payload handle; retention (KHA-130) owns deletion policy. */
  readPayloadReferences(payloadRef: string): Readonly<{ pending: number; releases: number }>;
  ledgerRevision(): number;
}

export interface ConnectorLedger {
  transaction<T>(run: (tx: LedgerTx) => T): Promise<T>;
}

export type LedgerContext = Readonly<{
  db: DatabaseSync;
  epoch: number;
  limits: DeliveryLimits;
}>;

// ---------------------------------------------------------------------------------
// Transactions

let depth = 0;

/**
 * Runs `run` in one IMMEDIATE transaction after re-checking the open epoch. The
 * callback must be synchronous. SQLite failures surface as StorageError; anything the
 * callback throws propagates unchanged after rollback. `canCommit` is asked last: a
 * callback that caught a failed operation and carried on commits nothing.
 */
export function runTransaction<T>(ctx: LedgerContext, run: () => T, canCommit: () => boolean = () => true): T {
  if (depth > 0) throw new StorageError('nested_transaction');
  const { db } = ctx;
  try {
    db.exec('BEGIN IMMEDIATE');
  } catch (error) {
    throw toStorageError(error);
  }
  depth += 1;
  try {
    assertEpoch(db, ctx.epoch);
    const result = run();
    if (typeof (result as { then?: unknown } | null)?.then === 'function') throw new StorageError('async_transaction');
    // SQLite rolls some failures (for example SQLITE_FULL) back on its own. If the
    // callback caught that error and carried on, nothing it did may commit.
    if (!db.isTransaction || !canCommit()) throw new StorageError('transaction_aborted');
    db.exec('COMMIT');
    return result;
  } catch (error) {
    if (db.isTransaction) {
      try { db.exec('ROLLBACK'); } catch { /* the connection reports the original failure */ }
    }
    throw (error as { errcode?: unknown } | null)?.errcode !== undefined ? toStorageError(error) : error;
  } finally {
    depth -= 1;
  }
}

function readRevision(db: DatabaseSync): number {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'ledger_revision'").get() as { value: string };
  return Number(row.value);
}

/** @internal Shared by storage adapters that must invalidate approval snapshots. */
export function bumpRevision(db: DatabaseSync): number {
  const next = readRevision(db) + 1;
  db.prepare("UPDATE meta SET value = ? WHERE key = 'ledger_revision'").run(String(next));
  return next;
}

function parseOrCorrupt<T>(json: string, decode: (input: unknown) => { ok: boolean; value?: T }): T {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new StorageError('corrupt');
  }
  const decoded = decode(value);
  if (!decoded.ok) throw new StorageError('corrupt');
  return decoded.value as T;
}

/** Stores only contract-valid values, in the decoder's canonical field order. */
function canonical<T>(value: unknown, decode: (input: unknown) => { ok: boolean; value?: T }): T {
  const decoded = decode(value);
  if (!decoded.ok) throw new StorageError('invalid_input');
  return decoded.value as T;
}

// ---------------------------------------------------------------------------------
// Input bounds. Every caller-supplied string is bounded before it reaches SQLite.

/** Largest opaque replay cursor accepted; SDK sync tokens are far smaller. */
export const MAX_CURSOR_BYTES = 8 * 1024;
/** Largest page `readQuarantine` returns. */
export const MAX_QUARANTINE_PAGE = 100;

function checked<T>(read: () => T): T {
  const decoded = decodeWith(read);
  if (!decoded.ok) throw new StorageError(decoded.code === 'limit_exceeded' ? 'limit_exceeded' : 'invalid_input');
  return decoded.value;
}

/** A nonempty identifier of at most MAX_IDENTIFIER_BYTES, as protocol IDs are. */
export function requireIdentifier(value: unknown): string {
  return checked(() => identifier(value, ''));
}

/** A real UTC instant in the contracts' `YYYY-MM-DDTHH:MM:SSZ` form. */
export function requireTimestamp(value: unknown): string {
  return checked(() => utcTimestamp(value, ''));
}

export function requireCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new StorageError('invalid_input');
  return value;
}

function requireCursor(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new StorageError('invalid_input');
  if (value.length > MAX_CURSOR_BYTES || utf8Length(value) > MAX_CURSOR_BYTES) throw new StorageError('limit_exceeded');
  return value;
}

function requireKey(key: PendingKey, roomId: string, eventId: string): void {
  if (key === null || typeof key !== 'object' || key.roomId !== roomId || key.eventId !== eventId) {
    throw new StorageError('invalid_input');
  }
  requireIdentifier(key.recipientBindingId);
  requireCount(key.recipientGeneration);
}

// ---------------------------------------------------------------------------------
// Pending items, quarantine and cursors (used by ConnectorStorage)

type PendingRow = {
  room_id: string;
  event_id: string;
  binding_id: string;
  generation: number;
  event_ref: string;
  payload_ref: string;
  received_at: string;
  ledger_revision: number;
};

function toPendingRecord(db: DatabaseSync, row: PendingRow): PendingRecord {
  const content = readPayload(db, row.payload_ref);
  if (content === null) throw new StorageError('corrupt');
  return {
    key: {
      roomId: row.room_id as RoomId,
      eventId: row.event_id as EventId,
      recipientBindingId: row.binding_id as BindingId,
      recipientGeneration: row.generation,
    },
    event: parseOrCorrupt(row.event_ref, decodeEventRef),
    content,
    receivedAt: row.received_at,
    ledgerRevision: row.ledger_revision,
  };
}

function readBindingRow(db: DatabaseSync, bindingId: string): SessionBinding | null {
  const row = db.prepare('SELECT binding FROM bindings WHERE binding_id = ?').get(bindingId) as { binding: string } | undefined;
  return row ? parseOrCorrupt(row.binding, decodeSessionBinding) : null;
}

/**
 * True when the binding, at any generation, or the device it delivers through is
 * revoked. Binding revocation is terminal for the binding ID: re-bootstrap mints a new one.
 */
function isRevoked(db: DatabaseSync, bindingId: string, deviceId: string): boolean {
  return db.prepare(`SELECT 1 FROM revocations WHERE (target_kind = 'binding' AND target_id = ?)
    OR (target_kind = 'device' AND target_id = ?) LIMIT 1`).get(bindingId, deviceId) !== undefined;
}

/** Events are recorded only for a known, current, unrevoked recipient generation. */
function recipientBlock(db: DatabaseSync, key: PendingKey): RecipientBlockCode | null {
  const binding = readBindingRow(db, key.recipientBindingId);
  if (binding === null || key.recipientGeneration > binding.generation) return 'binding_unknown';
  if (isRevoked(db, binding.bindingId, binding.deviceId)) return 'revoked';
  if (key.recipientGeneration < binding.generation) return 'stale_generation';
  return null;
}

/**
 * Records a conflict once per stream and bumps the ledger revision only when it is new.
 * Replaying the same conflicting event neither grows the table nor invalidates open
 * snapshots. A replay of a conflict the owner already resolved is `conflict_resolved`,
 * which lets that stream's cursor move past it without adopting anything.
 */
function quarantine(
  db: DatabaseSync,
  streamId: string,
  key: PendingKey,
  code: PersistConflictCode,
  digest: string | null,
  at: string,
): Readonly<{ kind: 'conflict' | 'conflict_resolved'; code: PersistConflictCode }> {
  const seen = db.prepare(`SELECT resolved_at FROM quarantine WHERE stream_id = ? AND room_id = ? AND event_id = ?
    AND binding_id = ? AND generation = ? AND code = ? AND observed_digest IS ? ORDER BY resolved_at IS NULL DESC LIMIT 1`)
    .get(streamId, key.roomId, key.eventId, key.recipientBindingId, key.recipientGeneration, code, digest) as
    | { resolved_at: string | null }
    | undefined;
  if (seen !== undefined) return { kind: seen.resolved_at === null ? 'conflict' : 'conflict_resolved', code };
  db.prepare(`INSERT INTO quarantine (stream_id, room_id, event_id, binding_id, generation, code, observed_digest, observed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(streamId, key.roomId, key.eventId, key.recipientBindingId, key.recipientGeneration, code, digest, at);
  bumpRevision(db);
  return { kind: 'conflict', code };
}

/** Room, event and attribution agree; a placeholder has no digest to compare. */
function sameAttribution(a: UnavailableEventRef | EventRef, b: UnavailableEventRef | EventRef): boolean {
  return a.v === b.v && a.roomId === b.roomId && a.eventId === b.eventId
    && a.authorParticipantId === b.authorParticipantId && a.authorDeviceId === b.authorDeviceId;
}

function readPlaceholderRef(db: DatabaseSync, key: PendingKey): { ref: UnavailableEventRef; replaced: boolean } | null {
  const row = db.prepare(`SELECT event_ref, replaced_revision FROM unavailable WHERE room_id = ? AND event_id = ?
    AND binding_id = ? AND generation = ?`).get(key.roomId, key.eventId, key.recipientBindingId, key.recipientGeneration) as
    | { event_ref: string; replaced_revision: number | null }
    | undefined;
  if (!row) return null;
  return { ref: parseOrCorrupt(row.event_ref, decodeUnavailableEventRef), replaced: row.replaced_revision !== null };
}

function pendingExists(db: DatabaseSync, key: PendingKey): boolean {
  return db.prepare('SELECT 1 FROM pending WHERE room_id = ? AND event_id = ? AND binding_id = ? AND generation = ?')
    .get(key.roomId, key.eventId, key.recipientBindingId, key.recipientGeneration) !== undefined;
}

export type PersistInput = {
  key: PendingKey;
  event: EventRef;
  plaintext: Uint8Array;
  receivedAt: string;
  /** The replay stream that observed the event; a conflict blocks only this stream's cursor. */
  streamId: string;
};

export function persistPending(ctx: LedgerContext, input: PersistInput, newPayloadRef: () => string): PersistResult {
  const { key, plaintext } = input;
  const event = canonical(input.event, decodeEventRef);
  requireKey(key, event.roomId, event.eventId);
  const receivedAt = requireTimestamp(input.receivedAt);
  const streamId = requireIdentifier(input.streamId);
  if (!(plaintext instanceof Uint8Array)) throw new StorageError('invalid_input');
  const { db } = ctx;
  return runTransaction(ctx, () => {
    const blocked = recipientBlock(db, key);
    if (blocked !== null) return { kind: 'blocked', code: blocked } as const;

    const observed = sha256Digest(plaintext);
    if (observed !== event.contentDigest) return quarantine(db, streamId, key, 'content_digest_mismatch', observed, receivedAt);

    // Any stored copy of this event, for any recipient, must be the same immutable
    // reference. Approved content is never overwritten.
    const stored = db.prepare('SELECT event_ref FROM pending WHERE room_id = ? AND event_id = ?')
      .all(key.roomId, key.eventId) as { event_ref: string }[];
    for (const row of stored) {
      const existing = parseOrCorrupt(row.event_ref, decodeEventRef);
      if (sameEventRef(existing, event)) continue;
      const code = existing.contentDigest !== event.contentDigest ? 'event_digest_mismatch' : 'event_ref_mismatch';
      return quarantine(db, streamId, key, code, event.contentDigest, receivedAt);
    }
    if (pendingExists(db, key)) return { kind: 'duplicate' } as const;

    // A placeholder for this exact key is replaced only by the same event with the same
    // attribution, whose content was just verified against its digest.
    const placeholder = readPlaceholderRef(db, key);
    if (placeholder !== null && !sameAttribution(placeholder.ref, event)) {
      return quarantine(db, streamId, key, 'event_ref_mismatch', event.contentDigest, receivedAt);
    }

    const payloadRef = newPayloadRef();
    insertPayload(db, payloadRef, plaintext);
    const revision = bumpRevision(db);
    db.prepare(`INSERT INTO pending (room_id, event_id, binding_id, generation, event_ref, content_digest, payload_ref,
      received_at, ledger_revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      key.roomId, key.eventId, key.recipientBindingId, key.recipientGeneration, JSON.stringify(event),
      event.contentDigest, payloadRef, receivedAt, revision,
    );
    if (placeholder === null) return { kind: 'inserted' } as const;
    db.prepare(`UPDATE unavailable SET replaced_revision = ? WHERE room_id = ? AND event_id = ? AND binding_id = ?
      AND generation = ?`).run(revision, key.roomId, key.eventId, key.recipientBindingId, key.recipientGeneration);
    return { kind: 'replaced' } as const;
  });
}

export type UnavailableInput = {
  key: PendingKey;
  ref: UnavailableEventRef;
  reason: UnavailableReason;
  receivedAt: string;
  streamId: string;
};

/**
 * Durably records an event that could not be decrypted or authenticated, keyed like a
 * pending item, so the stream's cursor can move past it without losing it. A decrypted
 * record for the same key always wins: a placeholder never replaces or downgrades it.
 */
export function persistUnavailable(ctx: LedgerContext, input: UnavailableInput): UnavailableResult {
  const ref = canonical(input.ref, decodeUnavailableEventRef);
  const { key } = input;
  requireKey(key, ref.roomId, ref.eventId);
  if (!UNAVAILABLE_REASONS.includes(input.reason)) throw new StorageError('invalid_input');
  const receivedAt = requireTimestamp(input.receivedAt);
  const streamId = requireIdentifier(input.streamId);
  const { db } = ctx;
  return runTransaction(ctx, () => {
    const blocked = recipientBlock(db, key);
    if (blocked !== null) return { kind: 'blocked', code: blocked } as const;

    const stored = db.prepare('SELECT event_ref FROM pending WHERE room_id = ? AND event_id = ?')
      .all(key.roomId, key.eventId) as { event_ref: string }[];
    for (const row of stored) {
      if (sameAttribution(parseOrCorrupt(row.event_ref, decodeEventRef), ref)) continue;
      return quarantine(db, streamId, key, 'event_ref_mismatch', null, receivedAt);
    }
    if (pendingExists(db, key)) return { kind: 'duplicate' } as const;

    const placeholder = readPlaceholderRef(db, key);
    if (placeholder !== null) {
      return sameAttribution(placeholder.ref, ref)
        ? { kind: 'duplicate' } as const
        : quarantine(db, streamId, key, 'event_ref_mismatch', null, receivedAt);
    }
    const revision = bumpRevision(db);
    db.prepare(`INSERT INTO unavailable (room_id, event_id, binding_id, generation, event_ref, reason, received_at,
      ledger_revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      key.roomId, key.eventId, key.recipientBindingId, key.recipientGeneration, JSON.stringify(ref), input.reason,
      receivedAt, revision,
    );
    return { kind: 'inserted' } as const;
  });
}

/** A quarantined conflict. It carries identities and digests only, never content. */
export type QuarantineEntry = Readonly<{
  id: number;
  streamId: string;
  key: PendingKey;
  code: PersistConflictCode;
  /** Null when the conflicting observation was an unavailable placeholder. */
  observedDigest: string | null;
  observedAt: string;
  resolvedAt: string | null;
}>;

/** One page of entries with `id > afterId`, oldest first. */
export function readQuarantine(db: DatabaseSync, input: { afterId?: number; limit?: number } = {}): readonly QuarantineEntry[] {
  const afterId = requireCount(input.afterId ?? 0);
  const limit = requireCount(input.limit ?? MAX_QUARANTINE_PAGE);
  if (limit === 0 || limit > MAX_QUARANTINE_PAGE) throw new StorageError('limit_exceeded');
  const rows = db.prepare('SELECT * FROM quarantine WHERE id > ? ORDER BY id LIMIT ?').all(afterId, limit) as {
    id: number; stream_id: string; room_id: string; event_id: string; binding_id: string; generation: number; code: string;
    observed_digest: string | null; observed_at: string; resolved_at: string | null;
  }[];
  return rows.map(row => ({
    id: row.id,
    streamId: row.stream_id,
    key: {
      roomId: row.room_id as RoomId,
      eventId: row.event_id as EventId,
      recipientBindingId: row.binding_id as BindingId,
      recipientGeneration: row.generation,
    },
    code: row.code as PersistConflictCode,
    observedDigest: row.observed_digest,
    observedAt: row.observed_at,
    resolvedAt: row.resolved_at,
  }));
}

/**
 * The owner acknowledges a conflict. The originally stored record always stays as it
 * is; resolving never adopts the conflicting content. A later replay of the same
 * conflict answers `conflict_resolved`, so the stream's cursor can move on.
 */
export function resolveQuarantine(
  ctx: LedgerContext,
  input: { id: number; resolvedAt: string },
): Readonly<{ kind: 'resolved' | 'already_resolved' }> | Readonly<{ kind: 'conflict'; code: 'unknown_entry' }> {
  const id = requireCount(input.id);
  const resolvedAt = requireTimestamp(input.resolvedAt);
  const { db } = ctx;
  return runTransaction(ctx, () => {
    const row = db.prepare('SELECT resolved_at FROM quarantine WHERE id = ?').get(id) as
      | { resolved_at: string | null }
      | undefined;
    if (row === undefined) return { kind: 'conflict', code: 'unknown_entry' } as const;
    if (row.resolved_at !== null) return { kind: 'already_resolved' } as const;
    db.prepare('UPDATE quarantine SET resolved_at = ? WHERE id = ?').run(resolvedAt, id);
    bumpRevision(db);
    return { kind: 'resolved' } as const;
  });
}

export function readCursor(db: DatabaseSync, streamId: string): { revision: number; opaqueCursor: string } | null {
  const row = db.prepare('SELECT revision, opaque_cursor FROM cursors WHERE stream_id = ?').get(requireIdentifier(streamId)) as
    | { revision: number; opaque_cursor: string }
    | undefined;
  return row ? { revision: row.revision, opaqueCursor: row.opaque_cursor } : null;
}

/** Compare-and-set; an absent cursor has revision 0. */
export function commitCursor(
  ctx: LedgerContext,
  input: { streamId: string; expectedRevision: number; opaqueCursor: string },
): CursorResult {
  const streamId = requireIdentifier(input.streamId);
  const expectedRevision = requireCount(input.expectedRevision);
  const opaqueCursor = requireCursor(input.opaqueCursor);
  const { db } = ctx;
  return runTransaction(ctx, () => {
    const unresolved = db.prepare('SELECT 1 FROM quarantine WHERE stream_id = ? AND resolved_at IS NULL LIMIT 1').get(streamId);
    if (unresolved !== undefined) return { kind: 'blocked', code: 'quarantine_unresolved' } as const;
    const current = readCursor(db, streamId)?.revision ?? 0;
    if (current !== expectedRevision) return { kind: 'conflict', code: 'stale_revision', revision: current } as const;
    const revision = current + 1;
    db.prepare(`INSERT INTO cursors (stream_id, revision, opaque_cursor) VALUES (?, ?, ?)
      ON CONFLICT (stream_id) DO UPDATE SET revision = excluded.revision, opaque_cursor = excluded.opaque_cursor`)
      .run(streamId, revision, opaqueCursor);
    return { kind: 'committed', revision } as const;
  });
}

/**
 * Released payload bytes, only while a release references the handle and its binding
 * and device are unrevoked. A revoked recipient's payload is `revoked`, never delivered.
 */
export function readReleasedPayload(ctx: LedgerContext, payloadRef: string): Uint8Array {
  const { db } = ctx;
  requireIdentifier(payloadRef);
  const row = db.prepare('SELECT job FROM releases WHERE payload_ref = ?').get(payloadRef) as { job: string } | undefined;
  if (row !== undefined) {
    const { binding } = parseOrCorrupt(row.job, input => decodeReleasedJob(input, ctx.limits));
    if (isRevoked(db, binding.bindingId, binding.deviceId)) throw new StorageError('revoked');
  }
  const bytes = row === undefined ? null : readPayload(db, payloadRef);
  if (bytes === null) throw new StorageError('payload_unavailable');
  return bytes;
}

// ---------------------------------------------------------------------------------
// Transaction-scoped port

/**
 * The port handed to a transaction callback. Once any method throws, the transaction
 * can no longer commit, even if the callback catches the error and returns normally.
 */
export function createLedgerTx(ctx: LedgerContext, isLive: () => boolean): { tx: LedgerTx; failed: () => boolean } {
  const { db, limits } = ctx;
  let failed = false;
  const live = () => {
    if (!isLive()) throw new StorageError('closed');
    if (!db.isTransaction) throw new StorageError('transaction_aborted');
  };
  const guarded = <A extends unknown[], R>(method: (...args: A) => R) => (...args: A): R => {
    try {
      live();
      return method(...args);
    } catch (error) {
      failed = true;
      throw error;
    }
  };

  const readBinding = (bindingId: BindingId): SessionBinding | null => readBindingRow(db, bindingId);

  const readPendingAt = (event: EventRef, binding: SessionBinding): PendingRecord | null => {
    const row = db.prepare(`SELECT * FROM pending WHERE room_id = ? AND event_id = ? AND binding_id = ? AND generation = ?`)
      .get(event.roomId, event.eventId, binding.bindingId, binding.generation) as PendingRow | undefined;
    return row ? toPendingRecord(db, row) : null;
  };

  const readCommand = (ownerId: OwnerId, commandId: CommandId): CommandRecord | null => {
    const row = db.prepare(`SELECT input_digest, approval_command, result FROM commands
      WHERE owner_id = ? AND command_id = ?`).get(ownerId, commandId) as
      | { input_digest: string; approval_command: string | null; result: string }
      | undefined;
    if (!row) return null;
    const result = parseOrCorrupt<ApprovalResult>(row.result, input => decodeApprovalResult(input, limits));
    const command = row.approval_command === null
      ? null
      : parseOrCorrupt<ApprovalCommand>(row.approval_command, input => decodeApprovalCommand(input, limits));
    if (command !== null && command.commandId !== commandId) throw new StorageError('corrupt');
    return { ownerId, commandId, inputDigest: row.input_digest, command, result };
  };

  const readRelease = (releaseId: ReleaseId): StoredRelease | null => {
    const row = db.prepare('SELECT owner_id, command_id, job, ledger_revision FROM releases WHERE release_id = ?')
      .get(releaseId) as { owner_id: string; command_id: string; job: string; ledger_revision: number } | undefined;
    if (!row) return null;
    return {
      ownerId: row.owner_id as OwnerId,
      commandId: row.command_id as CommandId,
      job: parseOrCorrupt(row.job, input => decodeReleasedJob(input, limits)),
      ledgerRevision: row.ledger_revision,
    };
  };

  const bindingRevoked = (binding: SessionBinding) => isRevoked(db, binding.bindingId, binding.deviceId);

  const tx: LedgerTx = {
    readApprovalSnapshot: guarded(({ bindingId, selection }: { bindingId: BindingId; selection: readonly EventRef[] }) => {
      const binding = readBinding(bindingId);
      if (binding === null) return null;
      if (bindingRevoked(binding)) return { kind: 'revoked' } as const;
      const pending = selection.flatMap(event => {
        const record = readPendingAt(event, binding);
        return record ? [record] : [];
      });
      return { kind: 'snapshot', binding, pending, ledgerRevision: readRevision(db) } as const;
    }),

    readBinding: guarded((bindingId: BindingId) => readBinding(bindingId)),

    putBinding: guarded((input: SessionBinding): BindingResult => {
      const binding = canonical(input, decodeSessionBinding);
      const stored = readBinding(binding.bindingId);
      if (stored !== null && sameSessionBinding(stored, binding)) return { kind: 'duplicate' };
      // A revoked binding ID is never rebound or re-armed, and nothing binds to a revoked device.
      if (isRevoked(db, binding.bindingId, binding.deviceId)) return { kind: 'conflict', code: 'revoked' };
      if (stored !== null) {
        if (binding.generation <= stored.generation) {
          return { kind: 'conflict', code: binding.generation < stored.generation ? 'stale_generation' : 'binding_mismatch' };
        }
        // A new generation may move the session or device, never the owner or agent.
        if (binding.ownerId !== stored.ownerId || binding.agentParticipantId !== stored.agentParticipantId) {
          return { kind: 'conflict', code: 'binding_mismatch' };
        }
      }
      db.prepare(`INSERT INTO bindings (binding_id, generation, binding) VALUES (?, ?, ?)
        ON CONFLICT (binding_id) DO UPDATE SET generation = excluded.generation, binding = excluded.binding`)
        .run(binding.bindingId, binding.generation, JSON.stringify(binding));
      bumpRevision(db);
      return { kind: stored === null ? 'inserted' : 'advanced' };
    }),

    putRevocation: guarded((input: RevocationRecord): RevocationResult => {
      if (input === null || typeof input !== 'object' || !['binding', 'device'].includes(input.targetKind)) {
        throw new StorageError('invalid_input');
      }
      const targetId = requireIdentifier(input.targetId);
      const generation = requireCount(input.generation);
      const operationId = requireIdentifier(input.operationId);
      const revokedAt = requireTimestamp(input.revokedAt);
      const seen = db.prepare('SELECT 1 FROM revocations WHERE target_kind = ? AND target_id = ? AND generation = ?')
        .get(input.targetKind, targetId, generation);
      if (seen !== undefined) return { kind: 'duplicate' };
      const revision = bumpRevision(db);
      db.prepare(`INSERT INTO revocations (target_kind, target_id, generation, operation_id, revoked_at, ledger_revision)
        VALUES (?, ?, ?, ?, ?, ?)`).run(input.targetKind, targetId, generation, operationId, revokedAt, revision);
      return { kind: 'recorded' };
    }),

    readPlaceholders: guarded((bindingId: BindingId): readonly PlaceholderRecord[] => {
      const binding = readBinding(bindingId);
      if (binding === null) return [];
      const rows = db.prepare(`SELECT * FROM unavailable WHERE binding_id = ? AND generation = ? AND replaced_revision IS NULL
        ORDER BY ledger_revision`).all(binding.bindingId, binding.generation) as {
        room_id: string; event_id: string; binding_id: string; generation: number; event_ref: string; reason: string;
        received_at: string; ledger_revision: number;
      }[];
      return rows.map(row => ({
        key: {
          roomId: row.room_id as RoomId,
          eventId: row.event_id as EventId,
          recipientBindingId: row.binding_id as BindingId,
          recipientGeneration: row.generation,
        },
        ref: parseOrCorrupt(row.event_ref, decodeUnavailableEventRef),
        reason: row.reason as UnavailableReason,
        receivedAt: row.received_at,
        ledgerRevision: row.ledger_revision,
      }));
    }),

    readCommand: guarded((ownerId: OwnerId, commandId: CommandId) => readCommand(ownerId, commandId)),

    putRelease: guarded(({ command, job: input, payload, expectedLedgerRevision }: Parameters<LedgerTx['putRelease']>[0]): ReleaseResult => {
      const job = canonical(input, value => decodeReleasedJob(value, limits));
      const result = canonical(command.result, value => decodeApprovalResult(value, limits));
      const approval = command.command === null
        ? null
        : canonical(command.command, value => decodeApprovalCommand(value, limits));
      if (!/^sha256:[0-9a-f]{64}$/.test(command.inputDigest) || !(payload instanceof Uint8Array)
        || approval === null || approval.commandId !== command.commandId) {
        throw new StorageError('invalid_input');
      }
      // A retry of the same command replays its committed outcome, whatever release ID
      // the retry minted; the same command ID with different input is refused.
      const existing = readCommand(command.ownerId, command.commandId);
      if (existing !== null) {
        return existing.inputDigest === command.inputDigest ? { kind: 'duplicate' } : { kind: 'conflict', code: 'idempotency_conflict' };
      }
      if (command.commandId !== job.approval.commandId || command.ownerId !== job.binding.ownerId
        || !verifyReleasedJob(job, approval).ok) {
        return { kind: 'conflict', code: 'command_mismatch' };
      }
      // Revocation outranks every other answer: a revoked recipient is never released to.
      if (isRevoked(db, job.binding.bindingId, job.binding.deviceId)) {
        return { kind: 'conflict', code: 'revoked' };
      }
      const binding = readBinding(job.binding.bindingId);
      if (readRevision(db) !== expectedLedgerRevision) return { kind: 'conflict', code: 'stale_ledger' };

      if (!result.ok || result.releaseIds.length !== 1 || result.releaseIds[0] !== job.releaseId) {
        return { kind: 'conflict', code: 'invalid_command_result' };
      }
      if (binding === null || !sameSessionBinding(binding, job.binding)) return { kind: 'conflict', code: 'stale_binding' };
      for (const event of job.events) {
        const record = readPendingAt(event, binding);
        if (record === null) return { kind: 'conflict', code: 'pending_missing' };
        if (!sameEventRef(record.event, event)) return { kind: 'conflict', code: 'stale_content' };
        const taken = db.prepare(`SELECT 1 FROM release_items WHERE room_id = ? AND event_id = ? AND binding_id = ?
          AND generation = ?`).get(event.roomId, event.eventId, binding.bindingId, binding.generation);
        if (taken !== undefined) return { kind: 'conflict', code: 'already_released' };
      }
      if (payload.byteLength > limits.maxPayloadBytes) return { kind: 'conflict', code: 'limit_exceeded' };
      if (sha256Digest(payload) !== job.payloadDigest) return { kind: 'conflict', code: 'payload_digest_mismatch' };
      if (readRelease(job.releaseId) !== null || payloadExists(db, job.payloadRef)) {
        return { kind: 'conflict', code: 'release_conflict' };
      }

      const revision = bumpRevision(db);
      db.prepare(`INSERT INTO commands (owner_id, command_id, input_digest, approval_command, result)
        VALUES (?, ?, ?, ?, ?)`).run(
        command.ownerId, command.commandId, command.inputDigest, JSON.stringify(approval), JSON.stringify(result),
      );
      insertPayload(db, job.payloadRef, payload);
      db.prepare(`INSERT INTO releases (release_id, owner_id, command_id, payload_ref, job, ledger_revision)
        VALUES (?, ?, ?, ?, ?, ?)`).run(job.releaseId, command.ownerId, command.commandId, job.payloadRef, JSON.stringify(job), revision);
      const claim = db.prepare(`INSERT INTO release_items (room_id, event_id, binding_id, generation, release_id)
        VALUES (?, ?, ?, ?, ?)`);
      for (const event of job.events) claim.run(event.roomId, event.eventId, binding.bindingId, binding.generation, job.releaseId);
      return { kind: 'committed' };
    }),

    readRelease: guarded((releaseId: ReleaseId) => readRelease(releaseId)),

    appendReceipt: guarded(({ receipt: input }: { receipt: DeliveryReceiptTransport }): ReceiptResult => {
      const receipt = canonical(input, decodeDeliveryReceiptTransport);
      const stored = db.prepare('SELECT receipt FROM receipts WHERE receipt_id = ?').get(receipt.receiptId) as
        | { receipt: string }
        | undefined;
      const json = JSON.stringify(receipt);
      if (stored !== undefined) {
        return stored.receipt === json
          ? { kind: 'duplicate', receipt: parseOrCorrupt(stored.receipt, decodeDeliveryReceiptTransport) }
          : { kind: 'conflict', code: 'receipt_conflict' };
      }
      const release = readRelease(receipt.releaseId);
      const correlation: ReceiptCorrelation = release === null
        ? 'unknown_release'
        : release.job.binding.bindingId !== receipt.bindingId || release.job.binding.generation !== receipt.generation
          ? 'correlation_mismatch'
          : 'correlated';
      const revision = bumpRevision(db);
      db.prepare('INSERT INTO receipts (receipt_id, release_id, correlation, receipt, ledger_revision) VALUES (?, ?, ?, ?, ?)')
        .run(receipt.receiptId, receipt.releaseId, correlation, json, revision);
      return correlation === 'correlated' ? { kind: 'recorded', receipt } : { kind: 'conflict', code: correlation };
    }),

    readReceipts: guarded((releaseId: ReleaseId): readonly StoredReceipt[] => {
      const rows = db.prepare('SELECT receipt, correlation FROM receipts WHERE release_id = ? ORDER BY ledger_revision')
        .all(releaseId) as { receipt: string; correlation: string }[];
      return rows.map(row => ({
        receipt: parseOrCorrupt(row.receipt, decodeDeliveryReceiptTransport),
        correlation: row.correlation as ReceiptCorrelation,
      }));
    }),

    readPayloadReferences: guarded((payloadRef: string) => payloadReferences(db, payloadRef)),

    ledgerRevision: guarded(() => readRevision(db)),
  };
  return { tx, failed: () => failed };
}
