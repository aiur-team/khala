// Conversion journal and history-transfer step ports for make-external. This file is
// the seam between the conversion service (journal) and the history export (transfer):
// each builds against these types and `externalization.fake`, and neither
// imports the other.

import { type Decoded, type Reader, decodeWith, fail, identifier, literal, object, safeInteger, version } from './decode';
import type { CallOptions, OperationResult } from './outcomes';

export const CONVERSION_VERSION = 1;

export const CONVERSION_STATES = [
  'preparing', 'external_created', 'history_copying', 'history_catching_up', 'drain_required',
  'agents_pending', 'committing', 'activating', 'externalized', 'cancelled', 'failed',
] as const;

export type ConversionState = typeof CONVERSION_STATES[number];

/**
 * Every allowed transition; anything absent is invalid. `activating` moves only
 * forward, because after the link commit the internal channel never reopens.
 * `cancelled` and `failed` are only reachable before `committing` finishes, and a
 * failure before the link commit resumes the internal channel. Start-fresh skips the
 * history states by going from `external_created` straight to `agents_pending`.
 */
export const CONVERSION_TRANSITIONS: Readonly<Record<ConversionState, readonly ConversionState[]>> = {
  preparing: ['external_created', 'cancelled', 'failed'],
  external_created: ['history_copying', 'agents_pending', 'cancelled', 'failed'],
  history_copying: ['history_catching_up', 'cancelled', 'failed'],
  history_catching_up: ['drain_required', 'agents_pending', 'cancelled', 'failed'],
  drain_required: ['agents_pending', 'cancelled', 'failed'],
  agents_pending: ['committing', 'cancelled', 'failed'],
  committing: ['activating', 'failed'],
  activating: ['externalized'],
  externalized: [],
  cancelled: [],
  failed: [],
};

export const isAllowedTransition = (from: ConversionState, to: ConversionState): boolean =>
  CONVERSION_TRANSITIONS[from].includes(to);

export type HistoryMode = 'start_fresh' | 'carry_history';

export type ConversionRecord = Readonly<{
  v: 1;
  conversionId: string;
  /** Operation that created the conversion; replaying it returns this record. */
  operationId: string;
  historyMode: HistoryMode;
  state: ConversionState;
  /** Increments on every accepted transition; guards stale writers. */
  revision: number;
}>;

export type ConversionCreate = Readonly<{ v: 1; conversionId: string; operationId: string; historyMode: HistoryMode }>;

export type ConversionAdvance = Readonly<{
  v: 1;
  conversionId: string;
  operationId: string;
  expectedRevision: number;
  from: ConversionState;
  to: ConversionState;
}>;

export type ConversionJournalRejection = 'not_found' | 'stale_revision' | 'invalid_transition' | 'operation_mismatch';

export interface ConversionJournalPort {
  /** Idempotent by `operationId`; reusing the ID or the conversion ID with other input is a mismatch. */
  create(input: ConversionCreate, options?: CallOptions): Promise<OperationResult<ConversionRecord, 'operation_mismatch'>>;
  read(conversionId: string, options?: CallOptions): Promise<OperationResult<ConversionRecord, 'not_found'>>;
  /** Idempotent by `operationId`; a replay returns the record the first call produced. */
  advance(input: ConversionAdvance, options?: CallOptions): Promise<OperationResult<ConversionRecord, ConversionJournalRejection>>;
}

export type HistoryTransferPhase = 'copy' | 'catch_up' | 'final_drain';

export type HistoryTransferStep = Readonly<{
  v: 1;
  conversionId: string;
  operationId: string;
  phase: HistoryTransferPhase;
  /** Catch-up round, 0 for the initial copy; at most three catch-up rounds are attempted. */
  round: number;
  /** Last chunk already acknowledged, so a resumed step starts at the first unreconciled one. */
  afterChunk: number;
}>;

export type HistoryTransferProgress = Readonly<{
  v: 1;
  conversionId: string;
  operationId: string;
  outcome: 'more' | 'converged' | 'drain_required';
  lastAckChunk: number;
  chunkCount: number;
  manifestDigest: string;
}>;

export type HistoryTransferRejection = 'not_found' | 'wrong_state' | 'operation_mismatch' | 'ceiling_exceeded';

/** One resumable step of history transfer; the journal, not this port, owns state changes. */
export interface HistoryTransferPort {
  step(input: HistoryTransferStep, options?: CallOptions): Promise<OperationResult<HistoryTransferProgress, HistoryTransferRejection>>;
}

const state = (r: Reader, key: string) => literal(r.field(key), r.at(key), CONVERSION_STATES);
const historyMode = (r: Reader) => literal(r.field('historyMode'), r.at('historyMode'), ['start_fresh', 'carry_history']);
const ids = (r: Reader) => ({
  conversionId: identifier(r.field('conversionId'), r.at('conversionId')),
  operationId: identifier(r.field('operationId'), r.at('operationId')),
});

export function decodeConversionRecord(input: unknown): Decoded<ConversionRecord> {
  return decodeWith(() => {
    const r = object(input, '', ['v', 'conversionId', 'operationId', 'historyMode', 'state', 'revision']);
    return {
      v: version(r.field('v'), r.at('v')),
      ...ids(r),
      historyMode: historyMode(r),
      state: state(r, 'state'),
      revision: safeInteger(r.field('revision'), r.at('revision')),
    };
  });
}

export function decodeConversionCreate(input: unknown): Decoded<ConversionCreate> {
  return decodeWith(() => {
    const r = object(input, '', ['v', 'conversionId', 'operationId', 'historyMode']);
    return { v: version(r.field('v'), r.at('v')), ...ids(r), historyMode: historyMode(r) };
  });
}

/** A transition the state machine does not list fails here, at `to`. */
export function decodeConversionAdvance(input: unknown): Decoded<ConversionAdvance> {
  return decodeWith(() => {
    const r = object(input, '', ['v', 'conversionId', 'operationId', 'expectedRevision', 'from', 'to']);
    const from = state(r, 'from');
    const to = state(r, 'to');
    if (!isAllowedTransition(from, to)) fail(r.at('to'), 'invalid_value');
    return {
      v: version(r.field('v'), r.at('v')),
      ...ids(r),
      expectedRevision: safeInteger(r.field('expectedRevision'), r.at('expectedRevision')),
      from,
      to,
    };
  });
}

export function decodeHistoryTransferStep(input: unknown): Decoded<HistoryTransferStep> {
  return decodeWith(() => {
    const r = object(input, '', ['v', 'conversionId', 'operationId', 'phase', 'round', 'afterChunk']);
    return {
      v: version(r.field('v'), r.at('v')),
      ...ids(r),
      phase: literal(r.field('phase'), r.at('phase'), ['copy', 'catch_up', 'final_drain']),
      round: safeInteger(r.field('round'), r.at('round')),
      afterChunk: safeInteger(r.field('afterChunk'), r.at('afterChunk')),
    };
  });
}

export function decodeHistoryTransferProgress(input: unknown): Decoded<HistoryTransferProgress> {
  return decodeWith(() => {
    const r = object(input, '', ['v', 'conversionId', 'operationId', 'outcome', 'lastAckChunk', 'chunkCount', 'manifestDigest']);
    return {
      v: version(r.field('v'), r.at('v')),
      ...ids(r),
      outcome: literal(r.field('outcome'), r.at('outcome'), ['more', 'converged', 'drain_required']),
      lastAckChunk: safeInteger(r.field('lastAckChunk'), r.at('lastAckChunk')),
      chunkCount: safeInteger(r.field('chunkCount'), r.at('chunkCount')),
      manifestDigest: identifier(r.field('manifestDigest'), r.at('manifestDigest')),
    };
  });
}
