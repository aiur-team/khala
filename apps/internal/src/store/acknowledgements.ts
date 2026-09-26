// The internal agent-acknowledgement ledger: the authority for `agent_acknowledged`
// receipts in internal mode, where no connector ledger exists. The recipient's inbox owns
// the batch token; it reports an acknowledgement only after the agent's next authenticated
// Khala call returned the exact token for its outstanding batch, and it moves its cursor
// only once this ledger has committed. The ledger's outbox is drained by the same receipt
// projection that drains the connector outbox, into the owner's read model.
//
// A release is acknowledged only by the binding generation it was made for: the ledger
// recomputes each internal release ID from the held binding and the named event, and
// checks that event is one the binding's feed covers: after its activation's start, and
// not its own.

import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  type BindingId, type DeliveryReceiptTransport, type DeliveryReceiptV2, type EventId, type ReceiptId, type ReleaseId,
  type RoomId, decodeDeliveryReceiptTransport,
} from '@khala/contracts/delivery/index';
import { StoreError } from './errors';
import type { InternalStoreHandle } from './open';
import { internalReleaseId } from './release-id';

/** Most releases one batch acknowledgement may name; inbox batches are far smaller. */
export const MAX_ACKNOWLEDGED_RELEASES = 64;
/** Largest page `readReceiptOutbox` returns. */
export const MAX_OUTBOX_PAGE = 100;

/** The binding the authenticated transport resolved for the caller, never a field it supplied. */
export type AgentPrincipal = Readonly<{ bindingId: string; generation: number }>;

export type AcknowledgedRelease = Readonly<{ releaseId: string; eventIds: readonly string[] }>;

export type AgentAcknowledgementInput = Readonly<{
  principal: AgentPrincipal;
  channelId: string;
  /** The committed prefix of the acknowledged batch, in inbox order. */
  releases: readonly AcknowledgedRelease[];
}>;

/** Unknown, stale, revoked and foreign callers all see `binding_not_held`. */
export type AgentAcknowledgementResult =
  | Readonly<{ kind: 'recorded' | 'duplicate'; evidenceRef: string; receipts: readonly DeliveryReceiptV2[] }>
  | Readonly<{ kind: 'refused'; code: 'binding_not_held' | 'not_joined' | 'invalid_input' }>;

/** Structurally the connector's `OutboxEntry`, so the connector projection drains it unchanged. */
export type AcknowledgementOutboxEntry = Readonly<{
  receipt: DeliveryReceiptTransport;
  evidenceRef: string;
  ledgerRevision: number;
  events: readonly Readonly<{ roomId: RoomId; eventId: EventId }>[];
}>;

export interface AgentAcknowledgementLedger {
  /** Commits one receipt per release, or nothing. */
  recordBatchAcknowledgement(input: AgentAcknowledgementInput): AgentAcknowledgementResult;
  /** Entries after `afterRevision`, oldest first; the projection owns checkpoints. */
  readReceiptOutbox(input?: { afterRevision?: number; limit?: number }): Promise<readonly AcknowledgementOutboxEntry[]>;
}

export type AgentAcknowledgementLedgerOptions = Readonly<{
  /** Commit-time clock; its value becomes the immutable `observedAt`. */
  now?: () => Date;
  /** Non-secret evidence reference shared by every receipt of one acknowledgement. */
  newEvidenceRef?: () => string;
}>;

/** The connector's stable receipt ID for this identity tuple, so a repeat always collides. */
export function agentAcknowledgementReceiptId(principal: AgentPrincipal, releaseId: string): ReceiptId {
  const identity = JSON.stringify(['agent', principal.bindingId, principal.generation, releaseId, 'agent_acknowledged']);
  return `receipt_agent_${createHash('sha256').update(identity).digest('base64url')}` as ReceiptId;
}

const REFUSED_INPUT = { kind: 'refused', code: 'invalid_input' } as const;

const isIdentifier = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 256 && !value.includes('\0');

/** Internal releases each carry exactly one event; anything else was never released here. */
function validInput(input: AgentAcknowledgementInput): boolean {
  return input !== null && typeof input === 'object' && input.principal !== null && typeof input.principal === 'object'
    && isIdentifier(input.principal.bindingId) && Number.isSafeInteger(input.principal.generation)
    && input.principal.generation >= 0 && isIdentifier(input.channelId)
    && Array.isArray(input.releases) && input.releases.length > 0 && input.releases.length <= MAX_ACKNOWLEDGED_RELEASES
    && input.releases.every(release => release !== null && typeof release === 'object' && isIdentifier(release.releaseId)
      && Array.isArray(release.eventIds) && release.eventIds.length === 1 && isIdentifier(release.eventIds[0]))
    && new Set(input.releases.map(release => release.releaseId)).size === input.releases.length;
}

type BindingRow = Readonly<{ participant_id: string; status: string }>;

/** The participant of the exact current, unrevoked binding generation, or null. */
function heldParticipant(db: DatabaseSync, principal: AgentPrincipal): string | null {
  const row = db.prepare('SELECT participant_id, status FROM bindings WHERE binding_id = ? AND generation = ?')
    .get(principal.bindingId, principal.generation) as BindingRow | undefined;
  const latest = db.prepare('SELECT max(generation) AS generation FROM bindings WHERE binding_id = ?')
    .get(principal.bindingId) as { generation: number | null };
  return row !== undefined && row.status === 'active' && latest.generation === principal.generation ? row.participant_id : null;
}

function parseReceipt(json: string): DeliveryReceiptTransport {
  let value: unknown;
  try { value = JSON.parse(json); } catch { throw new StoreError('corrupt'); }
  const decoded = decodeDeliveryReceiptTransport(value);
  if (!decoded.ok) throw new StoreError('corrupt');
  return decoded.value;
}

type LedgerRow = Readonly<{
  receipt: string; evidence_ref: string; ledger_revision: number; channel_id: string; event_id: string;
}>;

export function createAgentAcknowledgementLedger(
  handle: InternalStoreHandle,
  options: AgentAcknowledgementLedgerOptions = {},
): AgentAcknowledgementLedger {
  const now = options.now ?? (() => new Date());
  const newEvidenceRef = options.newEvidenceRef ?? (() => `ack_${randomUUID()}`);

  return {
    recordBatchAcknowledgement(input) {
      if (!validInput(input)) return REFUSED_INPUT;
      const principal = { bindingId: input.principal.bindingId, generation: input.principal.generation };
      return handle.transaction((db): AgentAcknowledgementResult => {
        // Authorization comes first, so a stale or foreign caller cannot learn from a
        // replay whether an acknowledgement already exists.
        const participantId = heldParticipant(db, principal);
        if (participantId === null) return { kind: 'refused', code: 'binding_not_held' };
        const membership = db.prepare('SELECT membership FROM memberships WHERE channel_id = ? AND participant_id = ?')
          .get(input.channelId, participantId) as { membership: string } | undefined;
        if (membership?.membership !== 'joined') return { kind: 'refused', code: 'not_joined' };
        // As the release feed does: an admitted binding is never released what preceded its activation.
        const start = (db.prepare(`
          SELECT start_sequence FROM discovery_activations WHERE binding_id = ? AND generation = ? AND channel_id = ?
        `).get(principal.bindingId, principal.generation, input.channelId) as { start_sequence: number } | undefined)
          ?.start_sequence ?? 0;
        for (const release of input.releases) {
          const eventId = release.eventIds[0]!;
          const event = db.prepare('SELECT sequence, author_participant_id FROM events WHERE channel_id = ? AND event_id = ?')
            .get(input.channelId, eventId) as { sequence: number; author_participant_id: string } | undefined;
          // The binding's own events are never released to it.
          if (event === undefined || event.sequence <= start || event.author_participant_id === participantId
            || internalReleaseId(principal, eventId) !== release.releaseId) return REFUSED_INPUT;
        }

        const receiptIds = input.releases.map(release => agentAcknowledgementReceiptId(principal, release.releaseId));
        const stored = receiptIds.map(receiptId => db.prepare('SELECT receipt, evidence_ref FROM agent_acknowledgements WHERE receipt_id = ?')
          .get(receiptId) as { receipt: string; evidence_ref: string } | undefined);
        if (stored.every(row => row !== undefined)) {
          const evidenceRef = stored[0]!.evidence_ref;
          if (stored.some(row => row!.evidence_ref !== evidenceRef)) throw new StoreError('corrupt');
          return { kind: 'duplicate', evidenceRef, receipts: stored.map(row => parseReceipt(row!.receipt)) as DeliveryReceiptV2[] };
        }
        // A batch is acknowledged whole; a partial overlap is not a prefix one inbox produces.
        if (stored.some(row => row !== undefined)) return REFUSED_INPUT;

        const evidenceRef = newEvidenceRef();
        if (!isIdentifier(evidenceRef)) throw new StoreError('transaction_aborted');
        const observedAt = now().toISOString().replace(/\.\d{3}Z$/, 'Z');
        const revision = (db.prepare('SELECT coalesce(max(ledger_revision), 0) AS value FROM agent_acknowledgements')
          .get() as { value: number }).value + 1;
        const insert = db.prepare(`
          INSERT INTO agent_acknowledgements (
            receipt_id, release_id, binding_id, generation, channel_id, event_id, evidence_ref, ledger_revision, receipt
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const receipts = input.releases.map((release, index): DeliveryReceiptV2 => {
          const receipt: DeliveryReceiptV2 = {
            v: 2,
            receiptId: receiptIds[index]!,
            releaseId: release.releaseId as ReleaseId,
            bindingId: principal.bindingId as BindingId,
            generation: principal.generation,
            kind: 'agent_acknowledged',
            observedAt,
            source: 'agent',
            evidenceRef,
            errorCode: null,
          };
          const decoded = decodeDeliveryReceiptTransport(receipt);
          if (!decoded.ok) throw new StoreError('transaction_aborted');
          insert.run(
            receipt.receiptId, receipt.releaseId, receipt.bindingId, receipt.generation, input.channelId,
            release.eventIds[0]!, evidenceRef, revision, JSON.stringify(decoded.value),
          );
          return receipt;
        });
        return { kind: 'recorded', evidenceRef, receipts };
      });
    },

    async readReceiptOutbox(page = {}) {
      const afterRevision = page.afterRevision ?? 0;
      const limit = page.limit ?? MAX_OUTBOX_PAGE;
      if (!Number.isSafeInteger(afterRevision) || afterRevision < 0
        || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_OUTBOX_PAGE) throw new StoreError('transaction_aborted');
      const rows = handle.read(db => db.prepare(`
        SELECT receipt, evidence_ref, ledger_revision, channel_id, event_id FROM agent_acknowledgements
        WHERE ledger_revision > ? ORDER BY ledger_revision, rowid LIMIT ?
      `).all(afterRevision, limit) as unknown as LedgerRow[]);
      return rows.map(row => ({
        receipt: parseReceipt(row.receipt),
        evidenceRef: row.evidence_ref,
        ledgerRevision: row.ledger_revision,
        events: [{ roomId: row.channel_id as RoomId, eventId: row.event_id as EventId }],
      }));
    },
  };
}
