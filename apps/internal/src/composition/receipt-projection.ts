// Composes the connector receipt-outbox projection with the owner-local channel store
// and an NDJSON structured agent log. Each observation is one fsynced line, appended
// before the projection checkpoint moves, so a crash can repeat a line but never lose one.

import fs from 'node:fs';
import {
  type ReceiptObservation, type ReceiptObservationLog, type ReceiptOutboxSource, type ReceiptProjector,
  createReceiptProjector,
} from '@khala/connector/receipts/projection';
import type { AgentAcknowledgementPort } from '../server/channel-server';
import {
  type AgentAcknowledgementLedger, type AgentAcknowledgementLedgerOptions, createAgentAcknowledgementLedger,
} from '../store/acknowledgements';
import { createReceiptReadModel } from '../store/receipts';
import type { InternalStoreHandle } from '../store/open';

/** The only line shape written; rebuilt from the observation's own fields. */
export function encodeReceiptObservation(observation: ReceiptObservation): string {
  return `${JSON.stringify({
    v: observation.v,
    event: observation.event,
    receiptId: observation.receiptId,
    releaseId: observation.releaseId,
    bindingId: observation.bindingId,
    generation: observation.generation,
    kind: observation.kind,
    source: observation.source,
    observedAt: observation.observedAt,
    evidenceRef: observation.evidenceRef,
    ledgerRevision: observation.ledgerRevision,
    events: observation.events.map(event => ({ channelId: event.channelId, eventId: event.eventId })),
  })}\n`;
}

/** Appends to an owner-only NDJSON file and fsyncs before reporting the line recorded. */
export function createNdjsonReceiptLog(file: string): ReceiptObservationLog {
  return {
    async record(observation) {
      const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT
        | fs.constants.O_NOFOLLOW, 0o600);
      try {
        fs.writeSync(fd, encodeReceiptObservation(observation));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    },
  };
}

export function createInternalReceiptProjector(input: Readonly<{
  outbox: ReceiptOutboxSource;
  store: InternalStoreHandle;
  log: ReceiptObservationLog;
}>): ReceiptProjector {
  return createReceiptProjector({ outbox: input.outbox, readModel: createReceiptReadModel(input.store), log: input.log });
}

/** The owner's NDJSON receipt log, beside the channel store. */
export const RECEIPT_LOG_FILE = 'receipts.ndjson';

export type InternalReceipts = Readonly<{
  ledger: AgentAcknowledgementLedger;
  projector: ReceiptProjector;
  /** The server's acknowledgement route: commit to the ledger, then project it for the owner. */
  acknowledgements: AgentAcknowledgementPort;
}>;

/**
 * Internal mode's receipt writer and its projection. The acknowledgement ledger is the
 * authority; the projector copies it into the owner's read model and the structured log.
 */
export function composeInternalReceipts(input: Readonly<{
  store: InternalStoreHandle;
  logFile: string;
  ledger?: AgentAcknowledgementLedgerOptions;
}>): InternalReceipts {
  const ledger = createAgentAcknowledgementLedger(input.store, input.ledger);
  const projector = createInternalReceiptProjector({ outbox: ledger, store: input.store, log: createNdjsonReceiptLog(input.logFile) });
  return {
    ledger,
    projector,
    acknowledgements: {
      record: acknowledgement => ledger.recordBatchAcknowledgement(acknowledgement),
      async project() { await projector.drain(); },
    },
  };
}
