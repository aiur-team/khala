// Owner-local read model for connector receipt facts. The connector ledger is the
// authority; this store keeps immutable copies so the channel timeline can show
// evidence after the inbox cursor has moved on. A fact is written once: a repeat must
// compare equal, and anything else is a conflict the projection refuses to overwrite.

import type { DatabaseSync } from 'node:sqlite';
import {
  type DeliveryReceiptTransport, type EventId, type ReceiptId, type RoomId, decodeDeliveryReceiptTransport,
} from '@khala/contracts/delivery/index';
import type { ParticipantId } from '@khala/contracts/messaging/index';
import { StoreError } from './errors';
import type { InternalStoreHandle } from './open';

/** The checkpoint row for the one connector ledger an owner-local store projects. */
export const CONNECTOR_RECEIPT_SOURCE = 'connector';

/** One immutable fact as the connector outbox projection hands it over. */
export type ProjectedReceipt = Readonly<{
  receipt: DeliveryReceiptTransport;
  evidenceRef: string;
  ledgerRevision: number;
  events: readonly Readonly<{ channelId: RoomId; eventId: EventId }>[];
}>;

export type ProjectionWriteResult = Readonly<{ kind: 'stored' | 'duplicate' | 'conflict' }>;

/** Structurally the connector's `ReceiptReadModel` port; the composition root wires them. */
export interface ReceiptReadModel {
  projectReceipt(fact: ProjectedReceipt): Promise<ProjectionWriteResult>;
  readCheckpoint(): Promise<number>;
  commitCheckpoint(ledgerRevision: number): Promise<void>;
}

export type ChannelReceiptFact = Readonly<{
  receipt: DeliveryReceiptTransport;
  evidenceRef: string;
  /** This channel's events the release carried, with their timeline sequence when stored here. */
  events: readonly Readonly<{ eventId: EventId; sequence: number | null }>[];
}>;

/** Every fact sharing one evidence reference came from one batch acknowledgement. */
export type ReceiptEvidenceGroup = Readonly<{ evidenceRef: string; receiptIds: readonly ReceiptId[] }>;

export type ChannelReceiptsResult =
  | Readonly<{ kind: 'done'; facts: readonly ChannelReceiptFact[]; groups: readonly ReceiptEvidenceGroup[] }>
  | Readonly<{ kind: 'rejected'; code: 'not_found' | 'not_joined' | 'invalid_input' }>
  | Readonly<{ kind: 'unavailable' }>;

export interface InternalReceiptReadModel extends ReceiptReadModel {
  /** Receipt facts for a channel the participant has joined, in canonical kind order. */
  channelReceipts(input: Readonly<{ channelId: RoomId; participantId: ParticipantId }>): ChannelReceiptsResult;
}

type FactRow = Readonly<{
  receipt_id: string;
  evidence_ref: string | null;
  ledger_revision: number;
  receipt: string;
}>;

const isIdentifier = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && !value.includes('\0');
const isRevision = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1;

/** Decoding rebuilds the receipt field by field, so the JSON is canonical and closed. */
function canonicalReceipt(input: unknown): Readonly<{ receipt: DeliveryReceiptTransport; json: string }> | null {
  const decoded = decodeDeliveryReceiptTransport(input);
  return decoded.ok ? { receipt: decoded.value, json: JSON.stringify(decoded.value) } : null;
}

function storedReceipt(json: string): DeliveryReceiptTransport {
  let value: unknown;
  try { value = JSON.parse(json); } catch { throw new StoreError('corrupt'); }
  const canonical = canonicalReceipt(value);
  if (!canonical || canonical.json !== json) throw new StoreError('corrupt');
  return canonical.receipt;
}

function factEvents(db: DatabaseSync, receiptId: string) {
  return db.prepare('SELECT channel_id, event_id FROM receipt_fact_events WHERE receipt_id = ? ORDER BY position')
    .all(receiptId) as unknown as Array<{ channel_id: string; event_id: string }>;
}

function validFact(fact: ProjectedReceipt): string | null {
  if (fact === null || typeof fact !== 'object' || !isIdentifier(fact.evidenceRef) || !isRevision(fact.ledgerRevision)
    || !Array.isArray(fact.events) || fact.events.length === 0
    || !fact.events.every(event => isIdentifier(event?.channelId) && isIdentifier(event?.eventId))) return null;
  const canonical = canonicalReceipt(fact.receipt);
  // The outbox copy of the evidence reference must match the receipt's own.
  if (!canonical || (canonical.receipt.evidenceRef !== null && canonical.receipt.evidenceRef !== fact.evidenceRef)) return null;
  return canonical.json;
}

/** Canonical, non-semantic order: kind code, then timestamp and receipt ID as tie-breakers. */
function canonicalOrder(a: ChannelReceiptFact, b: ChannelReceiptFact): number {
  const key = (fact: ChannelReceiptFact) => [fact.receipt.kind, fact.receipt.observedAt, fact.receipt.receiptId];
  const [left, right] = [key(a), key(b)];
  for (let index = 0; index < left.length; index += 1) {
    if (left[index]! < right[index]!) return -1;
    if (left[index]! > right[index]!) return 1;
  }
  return 0;
}

export function createReceiptReadModel(handle: InternalStoreHandle): InternalReceiptReadModel {
  function project(fact: ProjectedReceipt): ProjectionWriteResult {
    const json = validFact(fact);
    if (json === null) return { kind: 'conflict' };
    const receipt = fact.receipt;
    return handle.transaction(db => {
      const existing = db.prepare('SELECT * FROM receipt_facts WHERE receipt_id = ?')
        .get(receipt.receiptId) as FactRow | undefined;
      if (existing) {
        const events = factEvents(db, receipt.receiptId);
        const same = existing.receipt === json && existing.evidence_ref === fact.evidenceRef
          && existing.ledger_revision === fact.ledgerRevision && events.length === fact.events.length
          && events.every((event, index) => event.channel_id === fact.events[index]!.channelId
            && event.event_id === fact.events[index]!.eventId);
        return same ? { kind: 'duplicate' } as const : { kind: 'conflict' } as const;
      }
      db.prepare(`
        INSERT INTO receipt_facts (
          receipt_id, release_id, binding_id, generation, kind, source, observed_at, evidence_ref, ledger_revision, receipt
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        receipt.receiptId, receipt.releaseId, receipt.bindingId, receipt.generation, receipt.kind, receipt.source,
        receipt.observedAt, fact.evidenceRef, fact.ledgerRevision, json,
      );
      const insertEvent = db.prepare(`
        INSERT INTO receipt_fact_events (receipt_id, position, channel_id, event_id) VALUES (?, ?, ?, ?)
      `);
      fact.events.forEach((event, position) => insertEvent.run(receipt.receiptId, position, event.channelId, event.eventId));
      return { kind: 'stored' } as const;
    });
  }

  return {
    async projectReceipt(fact) {
      return project(fact);
    },

    async readCheckpoint() {
      return handle.read(db => {
        const row = db.prepare('SELECT ledger_revision FROM receipt_projection_checkpoints WHERE source = ?')
          .get(CONNECTOR_RECEIPT_SOURCE) as { ledger_revision: number } | undefined;
        return row?.ledger_revision ?? 0;
      });
    },

    async commitCheckpoint(ledgerRevision) {
      if (!isRevision(ledgerRevision)) throw new StoreError('transaction_aborted');
      handle.transaction(db => {
        db.prepare(`
          INSERT INTO receipt_projection_checkpoints (source, ledger_revision) VALUES (?, ?)
          ON CONFLICT (source) DO UPDATE SET ledger_revision = max(ledger_revision, excluded.ledger_revision)
        `).run(CONNECTOR_RECEIPT_SOURCE, ledgerRevision);
      });
    },

    channelReceipts(input) {
      if (!isIdentifier(input.channelId) || !isIdentifier(input.participantId)) {
        return { kind: 'rejected', code: 'invalid_input' };
      }
      try {
        return handle.read(db => {
          if (!db.prepare('SELECT 1 FROM channels WHERE channel_id = ?').get(input.channelId)) {
            return { kind: 'rejected', code: 'not_found' } as const;
          }
          const membership = db.prepare('SELECT membership FROM memberships WHERE channel_id = ? AND participant_id = ?')
            .get(input.channelId, input.participantId) as { membership: string } | undefined;
          if (membership?.membership !== 'joined') return { kind: 'rejected', code: 'not_joined' } as const;
          const rows = db.prepare(`
            SELECT f.receipt_id, f.evidence_ref, f.receipt, fe.event_id, e.sequence
            FROM receipt_fact_events fe
            JOIN receipt_facts f ON f.receipt_id = fe.receipt_id
            LEFT JOIN events e ON e.event_id = fe.event_id AND e.channel_id = fe.channel_id
            WHERE fe.channel_id = ?
            ORDER BY f.receipt_id, fe.position
          `).all(input.channelId) as unknown as Array<{
            receipt_id: string; evidence_ref: string; receipt: string; event_id: string; sequence: number | null;
          }>;
          const facts = new Map<string, { receipt: DeliveryReceiptTransport; evidenceRef: string; events: Array<{ eventId: EventId; sequence: number | null }> }>();
          for (const row of rows) {
            let fact = facts.get(row.receipt_id);
            if (!fact) {
              fact = { receipt: storedReceipt(row.receipt), evidenceRef: row.evidence_ref, events: [] };
              facts.set(row.receipt_id, fact);
            }
            fact.events.push({ eventId: row.event_id as EventId, sequence: row.sequence });
          }
          const ordered = [...facts.values()].sort(canonicalOrder);
          const groups = new Map<string, ReceiptId[]>();
          for (const fact of ordered) {
            groups.set(fact.evidenceRef, [...(groups.get(fact.evidenceRef) ?? []), fact.receipt.receiptId]);
          }
          return {
            kind: 'done',
            facts: ordered,
            groups: [...groups].map(([evidenceRef, receiptIds]) => ({ evidenceRef, receiptIds })),
          } as const;
        });
      } catch { return { kind: 'unavailable' }; }
    },
  };
}
