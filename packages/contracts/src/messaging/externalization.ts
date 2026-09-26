// Conversion journal and history-transfer step ports for make-external. This file is
// the seam between the conversion service (journal) and the history export (transfer):
// each builds against these types and `externalization.fake`, and neither
// imports the other.

import {
  type Decoded, type Reader, array, decodeWith, elementPath, fail, identifier, literal, object, safeInteger, version,
} from './decode';
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
  /**
   * How many chunks the caller has seen acknowledged (chunks `0..afterChunk-1`), so a
   * resumed step starts at the first unreconciled one. The transfer's persisted
   * acknowledgements stay authoritative; a caller claiming more than they record is refused.
   */
  afterChunk: number;
}>;

export type HistoryTransferProgress = Readonly<{
  v: 1;
  conversionId: string;
  operationId: string;
  outcome: 'more' | 'converged' | 'drain_required';
  /** Count of acknowledged chunks, `0..lastAckChunk-1`; equals `chunkCount` once every sealed chunk is acknowledged. */
  lastAckChunk: number;
  chunkCount: number;
  /**
   * Digest of the manifest over every chunk sealed so far. After a `final_drain` step
   * converges it names the manifest the destination holds, and the importer verifies
   * the archive against it.
   */
  manifestDigest: string;
}>;

/**
 * `forbidden`: the signed-in owner, the journaled operation or the destination channel
 * is not the one the transfer is bound to. `source_changed`: an already sealed range of
 * the source log no longer reproduces its digests. `ceiling_exceeded` is the finite
 * blocked result of a paused drain; the source channel has been resumed.
 */
export type HistoryTransferRejection =
  | 'not_found' | 'wrong_state' | 'operation_mismatch' | 'ceiling_exceeded' | 'forbidden' | 'invalid_request' | 'source_changed';

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

// Start-fresh conversion: what the human confirmed, per-agent status, and the ports
// the conversion service drives. Khala never binds an agent on the human's behalf:
// every selected agent joins the destination through its own channel-access request,
// the human's grant of that exact request and the activation readiness of that
// request. The resulting destination binding stays conversion-paused until the link
// commit releases it.

export type ConversionVisibility = 'public' | 'private' | 'secret';

/** An omitted visibility choice is never widened. */
export const DEFAULT_CONVERSION_VISIBILITY: ConversionVisibility = 'secret';

/** The exact verified identity the human selected; a later session or generation is another agent. */
export type ConversionAgentIdentity = Readonly<{
  participantId: string;
  harness: string;
  sessionId: string;
  generation: number;
}>;

/** What the human asked for. `agents` names participants of the source channel. */
export type ConversionStart = Readonly<{
  v: 1;
  conversionId: string;
  operationId: string;
  sourceChannelId: string;
  historyMode: HistoryMode;
  visibility: ConversionVisibility;
  agents: readonly string[];
}>;

/** Immutable once journaled. `sourceRevision` is the channel revision the human confirmed. */
export type ConversionSnapshot = Readonly<{
  v: 1;
  historyMode: HistoryMode;
  sourceChannelId: string;
  sourceRevision: number;
  title: string | null;
  visibility: ConversionVisibility;
  /** Joined human participants at snapshot time; they follow through their own accounts. */
  humans: readonly string[];
  /** The selected agents in participant order, each with its exact active session. */
  agents: readonly ConversionAgentIdentity[];
}>;

export const CONVERSION_AGENT_STATUSES = ['verifying', 'requested', 'ready', 'blocked', 'skipped'] as const;

export type ConversionAgentStatus = typeof CONVERSION_AGENT_STATUSES[number];

/**
 * Why an agent cannot proceed until the human re-invites or skips it.
 * `stale_session`: the session or generation is no longer the selected one.
 */
export const CONVERSION_AGENT_BLOCKS = ['stale_session', 'revoked', 'unsupported', 'denied', 'expired', 'request_failed'] as const;

export type ConversionAgentBlock = typeof CONVERSION_AGENT_BLOCKS[number];

export type ConversionAgentState = Readonly<{
  participantId: string;
  status: ConversionAgentStatus;
  /** The channel-access request of the current attempt; null until the destination exists. */
  requestHandle: string | null;
  block: ConversionAgentBlock | null;
  /** Re-invite count; every attempt makes a new individual request. */
  attempt: number;
  /** Set only after the link commit released this agent's conversion pause. */
  released: boolean;
}>;

/** Session re-verification against the exact selected identity. */
export type ConversionSessionCheck = 'current' | 'stale_session' | 'revoked' | 'unsupported' | 'unavailable';

export interface ConversionSessionPort {
  verify(agent: ConversionAgentIdentity, options?: CallOptions): Promise<ConversionSessionCheck>;
}

export type HostedChannelCreate = Readonly<{
  /** Deterministic per conversion; a retry or a reconciliation names the same destination. */
  idempotencyKey: string;
  title: string | null;
  visibility: ConversionVisibility;
}>;

export type HostedChannelCreated = Readonly<{ idempotencyKey: string; destinationChannelId: string; visibility: ConversionVisibility }>;

/** Authenticated hosted channel creation, called as the signed-in human. */
export interface HostedChannelPort {
  create(input: HostedChannelCreate, options?: CallOptions): Promise<OperationResult<HostedChannelCreated, 'forbidden' | 'operation_mismatch'>>;
  /** After a lost create response: the channel that key created, or null when it created none. */
  reconcile(input: Readonly<{ idempotencyKey: string }>, options?: CallOptions): Promise<OperationResult<HostedChannelCreated | null, 'forbidden'>>;
}

export type ConversionAccessRequest = Readonly<{
  /** Deterministic per conversion, agent and attempt. */
  operationId: string;
  destinationChannelId: string;
  agent: ConversionAgentIdentity;
}>;

/**
 * Where one access request stands. `ready` is the activation readiness of that exact
 * request: its destination binding exists and is conversion-paused. `blocked` ends
 * this attempt.
 */
export type ConversionAccessReadiness =
  | Readonly<{ kind: 'pending_owner' | 'granted' | 'ready' }>
  | Readonly<{ kind: 'blocked'; block: ConversionAgentBlock }>
  | Readonly<{ kind: 'unavailable' }>;

export type ConversionGrantRejection = 'not_found' | 'denied' | 'expired' | 'revoked' | 'operation_mismatch';

/** The shared channel-access journal, inbox and activation, as a conversion consumes them. */
export interface ConversionAccessPort {
  /** Makes one individual journal request for one agent; idempotent by `operationId`. */
  request(
    input: ConversionAccessRequest, options?: CallOptions,
  ): Promise<OperationResult<Readonly<{ requestHandle: string }>, 'forbidden' | 'operation_mismatch'>>;
  /** The human's grant of one exact request; idempotent by `operationId`. */
  grant(
    input: Readonly<{ requestHandle: string; operationId: string }>, options?: CallOptions,
  ): Promise<OperationResult<Readonly<{ requestHandle: string }>, ConversionGrantRejection>>;
  readiness(requestHandle: string, options?: CallOptions): Promise<ConversionAccessReadiness>;
}

/** Releases the conversion pause of one ready destination binding. Idempotent by `operationId`. */
export interface ConversionBindingPort {
  release(
    input: Readonly<{ requestHandle: string; destinationChannelId: string; operationId: string }>, options?: CallOptions,
  ): Promise<'released' | 'unavailable'>;
}

const START_KEYS = ['v', 'conversionId', 'operationId', 'sourceChannelId', 'historyMode', 'agents'] as const;

/** An omitted `visibility` decodes as `secret`; every other field is required. */
export function decodeConversionStart(input: unknown): Decoded<ConversionStart> {
  return decodeWith(() => {
    const chosen = typeof input === 'object' && input !== null && Object.hasOwn(input, 'visibility');
    const r = object(input, '', chosen ? [...START_KEYS, 'visibility'] : START_KEYS);
    const visibility: ConversionVisibility = chosen
      ? literal(r.field('visibility'), r.at('visibility'), ['public', 'private', 'secret'])
      : DEFAULT_CONVERSION_VISIBILITY;
    const agents = array(r.field('agents'), r.at('agents'))
      .map((value, index) => identifier(value, elementPath(r.at('agents'), index)));
    if (new Set(agents).size !== agents.length) fail(r.at('agents'), 'invalid_value');
    return {
      v: version(r.field('v'), r.at('v')),
      ...ids(r),
      sourceChannelId: identifier(r.field('sourceChannelId'), r.at('sourceChannelId')),
      historyMode: historyMode(r),
      visibility,
      agents,
    };
  });
}
