// Records agent batch-token acknowledgements as content-free `agent_acknowledged`
// receipts. The recipient's inbox owns the batch token; it calls this port only after
// the next authenticated Khala call returned the exact token for its outstanding batch,
// and only advances its own cursor once this port has committed. The inbox cursor and
// this ledger are separate durability domains, so nothing here claims a cross-store
// transaction: a crash after commit replays the batch, and the replay returns the same
// immutable receipts.

import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  type BindingId, type DeliveryReceiptTransport, type DeliveryReceiptV2, type EventId, type ReceiptId, type ReleaseId,
  type RoomId, decodeDeliveryReceiptTransport, decodeReleasedJob,
} from '@khala/contracts/delivery/index';
import { StorageError } from './errors';
import {
  bumpRevision, isRevoked, readBindingRow, requireCount, requireIdentifier, requireTimestamp, runTransaction,
} from './ledger';
import { type ConnectorStorage, storageInternals } from './open';

/** Most releases one batch acknowledgement may name; inbox batches are far smaller. */
export const MAX_ACKNOWLEDGED_RELEASES = 64;
/** Largest page `readReceiptOutbox` returns. */
export const MAX_OUTBOX_PAGE = 100;

/**
 * The binding the authenticated transport resolved for the caller. It comes from a
 * server-held, binding-scoped credential, never from a field the caller supplied.
 */
export type AgentPrincipal = Readonly<{ bindingId: BindingId; generation: number }>;

export type AcknowledgementInput = Readonly<{
  principal: AgentPrincipal;
  /** The committed prefix of the acknowledged batch, in inbox order. */
  releaseIds: readonly ReleaseId[];
}>;

/**
 * Reuses the agent CLI's closed vocabulary. Unknown, stale, revoked and foreign callers
 * all see `binding_not_held`, so a refusal never tells a caller which one it was.
 */
export type AcknowledgementResult =
  | Readonly<{ kind: 'recorded' | 'duplicate'; evidenceRef: string; receipts: readonly DeliveryReceiptV2[] }>
  | Readonly<{ kind: 'refused'; code: 'binding_not_held' | 'invalid_input' }>;

/** Which channel event a receipt's release carried: identity only, never content or digest. */
export type ReceiptEventIdentity = Readonly<{ roomId: RoomId; eventId: EventId }>;

export type OutboxEntry = Readonly<{
  receipt: DeliveryReceiptTransport;
  evidenceRef: string;
  ledgerRevision: number;
  /** The release's events in release order, joined from the immutable released job. */
  events: readonly ReceiptEventIdentity[];
}>;

export interface AcknowledgementRecorder {
  /** Commits one receipt and one outbox entry per release, or nothing. */
  recordBatchAcknowledgement(input: AcknowledgementInput): Promise<AcknowledgementResult>;
  /** Outbox entries after `afterRevision`, oldest first; the projection owns checkpoints. */
  readReceiptOutbox(input?: { afterRevision?: number; limit?: number }): Promise<readonly OutboxEntry[]>;
}

export type AcknowledgementRecorderOptions = Readonly<{
  /** Commit-time clock; its value becomes the immutable `observedAt`. */
  now?: () => Date;
  /** Non-secret evidence reference shared by every receipt of one acknowledgement. */
  newEvidenceRef?: () => string;
}>;

/** The stable receipt ID from the contract's identity tuple; repeats always collide. */
export function agentAcknowledgementReceiptId(principal: AgentPrincipal, releaseId: ReleaseId): ReceiptId {
  const identity = JSON.stringify(['agent', principal.bindingId, principal.generation, releaseId, 'agent_acknowledged']);
  return `receipt_agent_${createHash('sha256').update(identity).digest('base64url')}` as ReceiptId;
}

/** What the recipient inbox sends for one acknowledgement; its binding is a claim only. */
export type ClaimedAcknowledgement = Readonly<{
  bindingId: string;
  generation: number;
  releaseIds: readonly string[];
}>;

/**
 * The authenticated-call boundary. `principal` is what the transport resolved from the
 * caller's credential (`null` when it could not authenticate one). A claim naming any
 * other binding or generation is refused before storage is consulted.
 */
export async function acceptBatchAcknowledgement(
  recorder: AcknowledgementRecorder,
  principal: AgentPrincipal | null,
  claimed: ClaimedAcknowledgement,
): Promise<AcknowledgementResult> {
  if (principal === null || claimed === null || typeof claimed !== 'object'
    || claimed.bindingId !== principal.bindingId || claimed.generation !== principal.generation) {
    return { kind: 'refused', code: 'binding_not_held' };
  }
  try {
    return await recorder.recordBatchAcknowledgement({ principal, releaseIds: claimed.releaseIds as readonly ReleaseId[] });
  } catch (error) {
    if (error instanceof StorageError && (error.code === 'invalid_input' || error.code === 'limit_exceeded')) {
      return { kind: 'refused', code: 'invalid_input' };
    }
    throw error;
  }
}

function context(storage: ConnectorStorage) {
  const internals = storageInternals.get(storage);
  if (!internals) throw new StorageError('closed');
  internals.assertUsable();
  return internals.ctx;
}

function parseReceipt(json: string): DeliveryReceiptTransport {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new StorageError('corrupt');
  }
  const decoded = decodeDeliveryReceiptTransport(value);
  if (!decoded.ok) throw new StorageError('corrupt');
  return decoded.value;
}

function validInput(input: AcknowledgementInput): AcknowledgementInput {
  if (input === null || typeof input !== 'object' || input.principal === null || typeof input.principal !== 'object'
    || !Array.isArray(input.releaseIds) || input.releaseIds.length === 0
    || input.releaseIds.length > MAX_ACKNOWLEDGED_RELEASES) throw new StorageError('invalid_input');
  const principal = {
    bindingId: requireIdentifier(input.principal.bindingId) as BindingId,
    generation: requireCount(input.principal.generation),
  };
  const releaseIds = input.releaseIds.map(releaseId => requireIdentifier(releaseId) as ReleaseId);
  if (new Set(releaseIds).size !== releaseIds.length) throw new StorageError('invalid_input');
  return { principal, releaseIds };
}

/** The exact current, unrevoked binding generation; checked before any idempotency lookup. */
function holdsBinding(db: DatabaseSync, principal: AgentPrincipal): boolean {
  const binding = readBindingRow(db, principal.bindingId);
  return binding !== null && binding.generation === principal.generation
    && !isRevoked(db, binding.bindingId, binding.deviceId);
}

type Limits = ReturnType<typeof context>['limits'];

function readJob(db: DatabaseSync, limits: Limits, releaseId: string) {
  const row = db.prepare('SELECT job FROM releases WHERE release_id = ?').get(releaseId) as { job: string } | undefined;
  if (row === undefined) return null;
  let value: unknown;
  try {
    value = JSON.parse(row.job);
  } catch {
    throw new StorageError('corrupt');
  }
  const job = decodeReleasedJob(value, limits);
  if (!job.ok) throw new StorageError('corrupt');
  return job.value;
}

/** The release was made available to exactly this binding generation. */
function releasedTo(db: DatabaseSync, limits: Limits, principal: AgentPrincipal, releaseId: ReleaseId) {
  const job = readJob(db, limits, releaseId);
  return job !== null && job.binding.bindingId === principal.bindingId && job.binding.generation === principal.generation;
}

export function createAcknowledgementRecorder(
  storage: ConnectorStorage,
  options: AcknowledgementRecorderOptions = {},
): AcknowledgementRecorder {
  const now = options.now ?? (() => new Date());
  const newEvidenceRef = options.newEvidenceRef ?? (() => `ack_${randomUUID()}`);

  return {
    async recordBatchAcknowledgement(raw) {
      const ctx = context(storage);
      const input = validInput(raw);
      const { db } = ctx;
      return runTransaction(ctx, (): AcknowledgementResult => {
        // Authorization and the revocation fence come first, so a revoked or foreign
        // caller cannot learn from a replay whether an acknowledgement already exists.
        if (!holdsBinding(db, input.principal)) return { kind: 'refused', code: 'binding_not_held' };
        for (const releaseId of input.releaseIds) {
          if (!releasedTo(db, ctx.limits, input.principal, releaseId)) return { kind: 'refused', code: 'invalid_input' };
        }

        const receiptIds = input.releaseIds.map(releaseId => agentAcknowledgementReceiptId(input.principal, releaseId));
        const stored = receiptIds.map(receiptId => {
          const row = db.prepare(`SELECT r.receipt, o.evidence_ref FROM receipts r
            LEFT JOIN receipt_outbox o ON o.receipt_id = r.receipt_id WHERE r.receipt_id = ?`).get(receiptId) as
            | { receipt: string; evidence_ref: string | null }
            | undefined;
          return row;
        });
        if (stored.every(row => row !== undefined)) {
          const receipts = stored.map(row => parseReceipt(row!.receipt));
          const evidenceRef = receipts[0]!.evidenceRef;
          if (evidenceRef === null || receipts.some(receipt => receipt.kind !== 'agent_acknowledged'
            || receipt.evidenceRef !== evidenceRef)
            || stored.some(row => row!.evidence_ref !== evidenceRef)) throw new StorageError('corrupt');
          return { kind: 'duplicate', evidenceRef, receipts: receipts as DeliveryReceiptV2[] };
        }
        // A batch is acknowledged whole. A partial overlap means another acknowledgement
        // claimed some of these releases, which a single inbox prefix cannot produce.
        if (stored.some(row => row !== undefined)) return { kind: 'refused', code: 'invalid_input' };

        const evidenceRef = requireIdentifier(newEvidenceRef());
        const observedAt = requireTimestamp(now().toISOString().replace(/\.\d{3}Z$/, 'Z'));
        const revision = bumpRevision(db);
        const receipts = input.releaseIds.map((releaseId, index): DeliveryReceiptV2 => ({
          v: 2,
          receiptId: receiptIds[index]!,
          releaseId,
          bindingId: input.principal.bindingId,
          generation: input.principal.generation,
          kind: 'agent_acknowledged',
          observedAt,
          source: 'agent',
          evidenceRef,
          errorCode: null,
        }));
        const insertReceipt = db.prepare(`INSERT INTO receipts (receipt_id, release_id, correlation, receipt, ledger_revision)
          VALUES (?, ?, 'correlated', ?, ?)`);
        const insertOutbox = db.prepare(`INSERT INTO receipt_outbox (receipt_id, evidence_ref, ledger_revision)
          VALUES (?, ?, ?)`);
        for (const receipt of receipts) {
          const decoded = decodeDeliveryReceiptTransport(receipt);
          if (!decoded.ok) throw new StorageError('invalid_input');
          insertReceipt.run(receipt.receiptId, receipt.releaseId, JSON.stringify(decoded.value), revision);
          insertOutbox.run(receipt.receiptId, evidenceRef, revision);
        }
        return { kind: 'recorded', evidenceRef, receipts };
      });
    },

    async readReceiptOutbox(page = {}) {
      const ctx = context(storage);
      const afterRevision = page.afterRevision === undefined ? 0 : requireCount(page.afterRevision);
      const limit = page.limit === undefined ? MAX_OUTBOX_PAGE : requireCount(page.limit);
      if (limit < 1 || limit > MAX_OUTBOX_PAGE) throw new StorageError('limit_exceeded');
      const rows = ctx.db.prepare(`SELECT r.receipt, o.evidence_ref, o.ledger_revision FROM receipt_outbox o
        JOIN receipts r ON r.receipt_id = o.receipt_id WHERE o.ledger_revision > ?
        ORDER BY o.ledger_revision, o.rowid LIMIT ?`).all(afterRevision, limit) as
        { receipt: string; evidence_ref: string; ledger_revision: number }[];
      return rows.map(row => {
        const receipt = parseReceipt(row.receipt);
        // A receipt row references its release, so a missing job is ledger corruption.
        const job = readJob(ctx.db, ctx.limits, receipt.releaseId);
        if (job === null) throw new StorageError('corrupt');
        return {
          receipt,
          evidenceRef: row.evidence_ref,
          ledgerRevision: row.ledger_revision,
          events: job.events.map(event => ({ roomId: event.roomId, eventId: event.eventId })),
        };
      });
    },
  };
}
