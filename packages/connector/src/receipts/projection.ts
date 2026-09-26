// Drains the connector's durable receipt outbox into an owner-local read model and a
// content-free structured agent-log observation. The connector ledger stays the
// authority: the projection only copies immutable facts forward and keeps its own
// checkpoint, so it resumes after a restart without asking the inbox to replay anything.
//
// Per ledger revision the order is fixed: read-model write, then log observation, then
// checkpoint. A crash anywhere before the checkpoint re-drains that revision; the read
// model compares the repeat equal and the log line is byte-identical.

import type {
  BindingId, DeliveryReceiptTransport, EventId, ReceiptId, ReleaseId, RoomId,
} from '@khala/contracts/delivery/index';
import type { OutboxEntry } from '../storage/acknowledgements';

/** The outbox half of `AcknowledgementRecorder`; pages by ledger revision, oldest first. */
export interface ReceiptOutboxSource {
  readReceiptOutbox(input?: { afterRevision?: number; limit?: number }): Promise<readonly OutboxEntry[]>;
}

/** One immutable fact as the read model stores it. */
export type ProjectedReceipt = Readonly<{
  receipt: DeliveryReceiptTransport;
  evidenceRef: string;
  ledgerRevision: number;
  events: readonly Readonly<{ channelId: RoomId; eventId: EventId }>[];
}>;

export type ProjectionWriteResult =
  | Readonly<{ kind: 'stored' | 'duplicate' }>
  /** A different fact already holds this receipt ID; the projection stops rather than overwrite it. */
  | Readonly<{ kind: 'conflict' }>;

/** The owner-local read model. It owns the checkpoint as well as the facts. */
export interface ReceiptReadModel {
  projectReceipt(fact: ProjectedReceipt): Promise<ProjectionWriteResult>;
  readCheckpoint(): Promise<number>;
  /** Monotonic; committing a revision at or below the current one is a no-op. */
  commitCheckpoint(ledgerRevision: number): Promise<void>;
}

export const RECEIPT_OBSERVATION_EVENT = 'khala.receipt.observed';

/**
 * The structured agent-log record. Every field is an identifier, a closed vocabulary
 * value or a timestamp, so it cannot carry message content or a batch token.
 */
export type ReceiptObservation = Readonly<{
  v: 1;
  event: typeof RECEIPT_OBSERVATION_EVENT;
  receiptId: ReceiptId;
  releaseId: ReleaseId;
  bindingId: BindingId;
  generation: number;
  kind: DeliveryReceiptTransport['kind'];
  source: DeliveryReceiptTransport['source'];
  observedAt: string;
  evidenceRef: string;
  ledgerRevision: number;
  events: readonly Readonly<{ channelId: RoomId; eventId: EventId }>[];
}>;

export interface ReceiptObservationLog {
  /** Durably records one observation. Delivery is at least once; repeats are identical. */
  record(observation: ReceiptObservation): Promise<void>;
}

export type DrainResult =
  | Readonly<{ kind: 'drained'; checkpoint: number; projected: number }>
  /** Fail closed: the checkpoint stays before the conflicting revision. */
  | Readonly<{ kind: 'conflict'; checkpoint: number; receiptId: ReceiptId }>;

export interface ReceiptProjector {
  /** Projects every outbox entry after the checkpoint. Concurrent calls share one run. */
  drain(): Promise<DrainResult>;
}

/** Largest page the connector outbox serves; one acknowledgement always fits in it. */
export const PROJECTION_PAGE = 100;

export function projectedReceipt(entry: OutboxEntry): ProjectedReceipt {
  return {
    receipt: entry.receipt,
    evidenceRef: entry.evidenceRef,
    ledgerRevision: entry.ledgerRevision,
    events: entry.events.map(event => ({ channelId: event.roomId, eventId: event.eventId })),
  };
}

/** Builds the observation property by property, so no other receipt field can leak in. */
export function receiptObservation(fact: ProjectedReceipt): ReceiptObservation {
  const { receipt } = fact;
  return {
    v: 1,
    event: RECEIPT_OBSERVATION_EVENT,
    receiptId: receipt.receiptId,
    releaseId: receipt.releaseId,
    bindingId: receipt.bindingId,
    generation: receipt.generation,
    kind: receipt.kind,
    source: receipt.source,
    observedAt: receipt.observedAt,
    evidenceRef: fact.evidenceRef,
    ledgerRevision: fact.ledgerRevision,
    events: fact.events.map(event => ({ channelId: event.channelId, eventId: event.eventId })),
  };
}

/**
 * Keeps only whole revisions. `readReceiptOutbox` pages by row, so a full page may end
 * part way through one acknowledgement; checkpointing that revision would skip the rest.
 */
function wholeRevisions(page: readonly OutboxEntry[], limit: number): readonly OutboxEntry[] {
  if (page.length < limit) return page;
  const last = page[page.length - 1]!.ledgerRevision;
  const whole = page.filter(entry => entry.ledgerRevision !== last);
  // One acknowledgement names at most 64 releases, so a page always holds a whole one.
  if (whole.length === 0) throw new Error('receipt outbox revision exceeds one projection page');
  return whole;
}

export function createReceiptProjector(input: Readonly<{
  outbox: ReceiptOutboxSource;
  readModel: ReceiptReadModel;
  log: ReceiptObservationLog;
  pageSize?: number;
}>): ReceiptProjector {
  const limit = input.pageSize ?? PROJECTION_PAGE;
  let running: Promise<DrainResult> | null = null;

  async function run(): Promise<DrainResult> {
    let checkpoint = await input.readModel.readCheckpoint();
    let projected = 0;
    for (;;) {
      const page = wholeRevisions(await input.outbox.readReceiptOutbox({ afterRevision: checkpoint, limit }), limit);
      if (page.length === 0) return { kind: 'drained', checkpoint, projected };
      for (let start = 0; start < page.length;) {
        const revision = page[start]!.ledgerRevision;
        let end = start;
        while (end < page.length && page[end]!.ledgerRevision === revision) end += 1;
        for (const entry of page.slice(start, end)) {
          if (entry.receipt.evidenceRef !== null && entry.receipt.evidenceRef !== entry.evidenceRef) {
            return { kind: 'conflict', checkpoint, receiptId: entry.receipt.receiptId };
          }
          const fact = projectedReceipt(entry);
          const written = await input.readModel.projectReceipt(fact);
          if (written.kind === 'conflict') return { kind: 'conflict', checkpoint, receiptId: entry.receipt.receiptId };
          await input.log.record(receiptObservation(fact));
          if (written.kind === 'stored') projected += 1;
        }
        await input.readModel.commitCheckpoint(revision);
        checkpoint = revision;
        start = end;
      }
    }
  }

  return {
    drain() {
      running ??= run().finally(() => { running = null; });
      return running;
    },
  };
}
