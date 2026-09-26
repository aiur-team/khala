import type { DatabaseSync } from 'node:sqlite';
import type { CallOptions, ChannelRejection, OperationResult, RoomId } from '@khala/contracts/messaging/index';
import { ok, outcomeUnknown, rejected, unavailable } from '@khala/contracts/messaging/outcomes';
import {
  type ConversionJournalPort, type ConversionRecord, type HistoryTransferPort, type HistoryTransferProgress,
  type HistoryTransferRejection, type HistoryTransferStep, decodeHistoryTransferStep,
} from '@khala/contracts/messaging/externalization';
import {
  type ImportedHistoryActor, type ImportedHistoryChunk, type ImportedHistoryLimits, type ImportedHistoryManifest,
  type ImportedHistoryRecordInput, decodeImportedHistoryLimits, digestImportedHistoryManifest, encodeImportedHistoryChunk,
  sealImportedHistory,
} from '@khala/contracts/messaging/imported-history';
import { MAX_HISTORY_CATCH_UP_ROUNDS } from '@khala/contracts/messaging/make-external';
import { decodeCanonical } from '../store/channel-store';
import type { InternalStoreHandle } from '../store/open';
import type { HistoryTransferLedger, SealedChunkRef, TransferLedgerState, TransferStepKey } from './transfer-ledger';

// Checkpointed transfer of an internal channel's history into its external channel.
//
// The copy seals a snapshot of the SQLite log. Up to three catch-up rounds then seal
// whatever was appended meanwhile, each starting from the last sequence already sealed,
// never from the snapshot revision: an active channel keeps moving, and comparing
// against the first revision would abort it forever. When the backlog still exceeds
// one maximum-sized chunk after the third round the step reports `drain_required`,
// and only a human-confirmed paused drain, bounded by a finite ceiling, finishes it.
//
// Every write is authorized against the signed-in conversion owner, the journaled
// operation and the bound destination channel. Acknowledgements are persisted per
// chunk, so a resumed or replayed step re-sends nothing already acknowledged, and a
// lost acknowledgement is reconciled from the destination rather than re-sent.

export const MAX_CATCH_UP_ROUNDS = MAX_HISTORY_CATCH_UP_ROUNDS;

/** Facts the conversion owns: which internal channel, which external channel, whose conversion. */
export type ConversionTarget = Readonly<{
  sourceChannelId: string;
  destinationRoomId: RoomId;
  owner: ImportedHistoryActor;
}>;

/** Pauses and resumes writes to the internal channel. Both calls are idempotent. */
export interface SourceWriteGate {
  pause(channelId: string, options?: CallOptions): Promise<'paused' | 'unavailable'>;
  resume(channelId: string, options?: CallOptions): Promise<'resumed' | 'unavailable'>;
}

/**
 * Bounds of the paused drain. The drain may seal at most `maxDrainChunks` and must
 * finish within `drainDeadlineMs` of first pausing the source, across every retry.
 */
export type HistoryDrainCeiling = Readonly<{ maxDrainChunks: number; drainDeadlineMs: number }>;

/** Structured progress for operators. Identifiers and counts only; never a body or author label. */
export type HistoryExportLogEntry = Readonly<{
  event: 'chunk_acknowledged' | 'manifest_acknowledged' | 'step_completed' | 'drain_blocked' | 'source_resumed';
  conversionId: string;
  phase?: TransferStepKey['phase'];
  round?: number;
  index?: number;
  reconciled?: boolean;
  outcome?: HistoryTransferProgress['outcome'];
}>;

/** One archive write: a sealed chunk, or the manifest that closes the archive. */
export type ArchivePart =
  | Readonly<{ kind: 'chunk'; archiveId: string; index: number; chunk: ImportedHistoryChunk }>
  | Readonly<{ kind: 'manifest'; archiveId: string; manifest: ImportedHistoryManifest }>;

/**
 * Writes one archive part to the destination through its end-to-end encryption, at most
 * once: a part already accepted is reconciled, not re-sent. The composition root wires
 * `deliverImportedPart` over the external channel's imported-history transport.
 */
export type ArchivePartSink = (
  roomId: RoomId, part: ArchivePart, options?: CallOptions,
) => Promise<OperationResult<Readonly<{ partId: string; reconciled: boolean }>, ChannelRejection>>;

export type HistoryExportDeps = Readonly<{
  source: InternalStoreHandle;
  journal: ConversionJournalPort;
  ledger: HistoryTransferLedger;
  deliver: ArchivePartSink;
  gate: SourceWriteGate;
  /** The signed-in owner's participant, or null when nobody is signed in. */
  session: () => ImportedHistoryActor | null;
  target: (conversionId: string, options?: CallOptions) => Promise<ConversionTarget | null>;
  limits: ImportedHistoryLimits;
  ceiling: HistoryDrainCeiling;
  now: () => number;
  log?: (entry: HistoryExportLogEntry) => void;
}>;

type Result = OperationResult<HistoryTransferProgress, HistoryTransferRejection>;
type Refusal = OperationResult<never, HistoryTransferRejection>;
type Ledgered = Readonly<{ state: TransferLedgerState; revision: number | null }>;

class Stop {
  constructor(readonly result: Refusal) {}
}

const stop = (result: Refusal): never => {
  throw new Stop(result);
};

type SourceRow = Readonly<{
  sequence: number;
  event_id: string;
  received_at: string;
  canonical_payload: Uint8Array;
  content_digest: string;
  display_name: string;
  kind: 'human' | 'agent';
}>;

type SourceRead = Readonly<{ revision: string; latestSequence: number; records: readonly ImportedHistoryRecordInput[] }>;

/**
 * One synchronous read of the source log: its revision, its newest sequence and the
 * records in `(after, through]`, in sequence order. Nothing is staged on disk.
 */
function readSource(handle: InternalStoreHandle, channelId: string, after: number, through: number | null): SourceRead | null {
  return handle.read((db: DatabaseSync) => {
    const channel = db.prepare(`
      SELECT c.revision, (SELECT MAX(sequence) FROM events e WHERE e.channel_id = c.channel_id) AS latest
      FROM channels c WHERE c.channel_id = ?
    `).get(channelId) as { revision: number; latest: number | null } | undefined;
    if (channel === undefined) return null;
    const latestSequence = channel.latest === null ? 0 : Number(channel.latest);
    const upper = through ?? latestSequence;
    const rows = db.prepare(`
      SELECT e.sequence, e.event_id, e.received_at, e.canonical_payload, e.content_digest, p.display_name, p.kind
      FROM events e JOIN participants p ON p.participant_id = e.author_participant_id
      WHERE e.channel_id = ? AND e.sequence > ? AND e.sequence <= ?
      ORDER BY e.sequence
    `).all(channelId, after, upper) as unknown as SourceRow[];
    const records: ImportedHistoryRecordInput[] = [];
    for (const row of rows) {
      const content = decodeCanonical(row.canonical_payload, row.content_digest);
      if (content === null) return null;
      records.push({
        sourceRecordId: row.event_id,
        sequence: Number(row.sequence),
        originalAuthor: { label: row.display_name, kind: row.kind },
        originalSentAt: row.received_at,
        body: content.body,
      });
    }
    return { revision: String(channel.revision), latestSequence, records };
  });
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(bytes)));
  return `sha256:${Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Chunk indices grow across rounds, and a longer index adds bytes to the chunk
 * encoding. Sealing against a budget reduced by the widest index keeps every
 * re-indexed chunk inside `maxChunkBytes`.
 */
function sealingLimits(limits: ImportedHistoryLimits): ImportedHistoryLimits {
  const slack = String(limits.maxChunks).length;
  const decoded = decodeImportedHistoryLimits({ ...limits, maxChunkBytes: Math.max(1, limits.maxChunkBytes - slack) });
  if (!decoded.ok) throw new Error('imported-history limits cannot absorb index growth');
  return decoded.value;
}

/** Seals records into chunks numbered from `offset`; `null` when a record cannot fit any chunk. */
async function sealFrom(
  state: TransferLedgerState, records: readonly ImportedHistoryRecordInput[], offset: number, limits: ImportedHistoryLimits,
): Promise<readonly ImportedHistoryChunk[] | null> {
  if (records.length === 0) return [];
  const sealed = await sealImportedHistory({
    archiveId: state.archiveId,
    source: { channelId: state.sourceChannelId, revision: state.sourceRevision },
    importedBy: { ownerId: state.ownerId, participantId: state.participantId },
    importedAt: state.importedAt,
    records,
  }, sealingLimits(limits));
  if (!sealed.ok) return null;
  const chunks: ImportedHistoryChunk[] = [];
  for (const chunk of sealed.value.chunks) {
    const index = offset + chunk.index;
    chunks.push({ ...chunk, index, chunkDigest: await sha256(encodeImportedHistoryChunk({ ...chunk, index })) });
  }
  return chunks;
}

function manifestOf(state: TransferLedgerState): ImportedHistoryManifest {
  return {
    v: 1,
    archiveId: state.archiveId,
    source: { channelId: state.sourceChannelId, revision: state.sourceRevision },
    importedBy: { ownerId: state.ownerId, participantId: state.participantId } as ImportedHistoryActor,
    importedAt: state.importedAt,
    recordCount: state.chunks.reduce((sum, chunk) => sum + chunk.recordCount, 0),
    chunks: state.chunks.map(({ index, recordCount, firstSequence, lastSequence, chunkDigest }) => ({
      index, recordCount, firstSequence, lastSequence, chunkDigest,
    })),
  };
}

const acknowledged = (state: TransferLedgerState): number => {
  const first = state.chunks.findIndex(chunk => chunk.partId === null);
  return first === -1 ? state.chunks.length : first;
};

const sameStep = (a: TransferStepKey | null, b: TransferStepKey): boolean => a !== null && a.phase === b.phase && a.round === b.round;

/** The step that may run after `completed`, or null when the transfer is finished. */
function nextStep(completed: TransferLedgerState['completed']): TransferStepKey | null {
  if (completed === null) return { phase: 'copy', round: 0 };
  if (completed.phase === 'final_drain') return null;
  if (completed.outcome === 'more') return { phase: 'catch_up', round: completed.phase === 'copy' ? 1 : completed.round + 1 };
  return { phase: 'final_drain', round: 0 };
}

/** Journal state each step runs in; a drain that followed `drain_required` needs the human-confirmed state. */
function requiredState(key: TransferStepKey, completed: TransferLedgerState['completed']): ConversionRecord['state'] {
  if (key.phase === 'copy') return 'history_copying';
  if (key.phase === 'catch_up') return 'history_catching_up';
  return completed?.outcome === 'drain_required' ? 'drain_required' : 'history_catching_up';
}

function mapTransport(result: Exclude<OperationResult<unknown, string>, Readonly<{ kind: 'ok' }>>): Refusal {
  if (result.kind === 'rejected') {
    return rejected(result.code === 'forbidden' || result.code === 'not_joined' || result.code === 'not_found' ? 'forbidden' : 'invalid_request');
  }
  return result.kind === 'outcome_unknown' ? outcomeUnknown(result.operationId) : unavailable();
}

export function createHistoryExport(deps: HistoryExportDeps): HistoryTransferPort {
  const { maxDrainChunks, drainDeadlineMs } = deps.ceiling;
  // An unbounded ceiling would let a paused drain run forever.
  if (![maxDrainChunks, drainDeadlineMs].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new RangeError('history drain ceiling must be finite and positive');
  }
  const log = (entry: HistoryExportLogEntry) => deps.log?.(entry);

  function save(current: Ledgered, next: TransferLedgerState): Ledgered {
    const written = deps.ledger.write(next, current.revision);
    // Another writer moved the ledger; this step's view is stale, so it retries from the ledger.
    if (written.kind === 'conflict') stop(unavailable());
    return { state: next, revision: (written as { revision: number }).revision };
  }

  function progress(state: TransferLedgerState, outcome: HistoryTransferProgress['outcome'], digest: string): HistoryTransferProgress {
    return {
      v: 1, conversionId: state.conversionId, operationId: state.operationId, outcome,
      lastAckChunk: acknowledged(state), chunkCount: state.chunks.length, manifestDigest: digest,
    };
  }

  async function currentDigest(state: TransferLedgerState): Promise<string> {
    if (state.manifest !== null) return state.manifest.digest;
    const digest = await digestImportedHistoryManifest(manifestOf(state));
    if (!digest.ok) return stop(unavailable());
    return digest.value;
  }

  /** Re-reads each unacknowledged chunk's source range, proves it reproduces the sealed digest, and sends it. */
  async function sendPending(current: Ledgered, limits: ImportedHistoryLimits, deadline: number | null, options?: CallOptions): Promise<Ledgered> {
    let ledgered = current;
    for (const ref of ledgered.state.chunks) {
      if (ref.partId !== null) continue;
      if (deadline !== null && deps.now() > deadline) return stop(rejected('ceiling_exceeded'));
      const read = readSource(deps.source, ledgered.state.sourceChannelId, ref.firstSequence - 1, ref.lastSequence);
      if (read === null) return stop(rejected('source_changed'));
      const [chunk, extra] = await sealFrom(ledgered.state, read.records, ref.index, limits) ?? [];
      if (chunk === undefined || extra !== undefined || chunk.chunkDigest !== ref.chunkDigest) return stop(rejected('source_changed'));
      const part: ArchivePart = { kind: 'chunk', archiveId: ledgered.state.archiveId, index: ref.index, chunk };
      const sent = await deps.deliver(ledgered.state.destinationRoomId as RoomId, part, options);
      if (sent.kind !== 'ok') return stop(mapTransport(sent));
      const chunks = ledgered.state.chunks.map(entry => entry.index === ref.index ? { ...entry, partId: sent.value.partId } : entry);
      ledgered = save(ledgered, { ...ledgered.state, chunks });
      log({ event: 'chunk_acknowledged', conversionId: ledgered.state.conversionId, index: ref.index, reconciled: sent.value.reconciled });
    }
    return ledgered;
  }

  /** Seals the backlog after `sealedThrough` for `key` and records it pending; a resumed step reuses its seal. */
  async function sealBacklog(current: Ledgered, key: TransferStepKey): Promise<Ledgered> {
    if (sameStep(current.state.pending, key)) return current;
    const read = readSource(deps.source, current.state.sourceChannelId, current.state.sealedThrough, null);
    if (read === null) return stop(rejected('source_changed'));
    const base = { ...current.state, sourceRevision: read.revision };
    const chunks = await sealFrom(base, read.records, base.chunks.length, deps.limits);
    if (chunks === null || base.chunks.length + chunks.length > deps.limits.maxChunks) {
      return stop(rejected('ceiling_exceeded'));
    }
    const refs: SealedChunkRef[] = chunks.map(chunk => ({
      index: chunk.index, recordCount: chunk.records.length, firstSequence: chunk.records[0]!.sequence,
      lastSequence: chunk.records.at(-1)!.sequence, chunkDigest: chunk.chunkDigest, partId: null,
    }));
    return save(current, {
      ...base, chunks: [...base.chunks, ...refs], sealedThrough: Math.max(base.sealedThrough, read.latestSequence), pending: key,
    });
  }

  /** How many maximum-sized chunks the unsealed backlog needs right now. */
  async function backlogChunks(state: TransferLedgerState): Promise<number> {
    const read = readSource(deps.source, state.sourceChannelId, state.sealedThrough, null);
    if (read === null) return stop(rejected('source_changed'));
    const chunks = await sealFrom(state, read.records, state.chunks.length, deps.limits);
    return chunks === null ? Number.POSITIVE_INFINITY : chunks.length;
  }

  function complete(current: Ledgered, key: TransferStepKey, outcome: HistoryTransferProgress['outcome']): Ledgered {
    const next = save(current, { ...current.state, pending: null, completed: { ...key, outcome } });
    log({ event: 'step_completed', conversionId: next.state.conversionId, phase: key.phase, round: key.round, outcome });
    return next;
  }

  async function copyOrCatchUp(current: Ledgered, key: TransferStepKey, options?: CallOptions): Promise<Result> {
    let ledgered = current;
    if (key.phase === 'catch_up' && !sameStep(ledgered.state.pending, key) && await backlogChunks(ledgered.state) <= 1) {
      // The backlog fits one maximum-sized chunk: the final delta moves under the paused drain.
      ledgered = complete(ledgered, key, 'converged');
      return ok(progress(ledgered.state, 'converged', await currentDigest(ledgered.state)));
    }
    ledgered = await sealBacklog(ledgered, key);
    ledgered = await sendPending(ledgered, deps.limits, null, options);
    let outcome: HistoryTransferProgress['outcome'] = 'more';
    if (key.phase === 'catch_up' && key.round >= MAX_CATCH_UP_ROUNDS) {
      outcome = await backlogChunks(ledgered.state) <= 1 ? 'converged' : 'drain_required';
    }
    ledgered = complete(ledgered, key, outcome);
    return ok(progress(ledgered.state, outcome, await currentDigest(ledgered.state)));
  }

  async function block(conversionId: string, options?: CallOptions): Promise<Refusal> {
    // Re-read: the failed step may have persisted acknowledgements after its caller's snapshot.
    const found = deps.ledger.read(conversionId);
    if (found.kind !== 'found') return unavailable();
    let ledgered: Ledgered = { state: found.state, revision: found.revision };
    if (!ledgered.state.blocked) {
      ledgered = save(ledgered, { ...ledgered.state, blocked: true });
      log({ event: 'drain_blocked', conversionId: ledgered.state.conversionId });
    }
    // The blocked result is only truthful once the source is writable again.
    if (await deps.gate.resume(ledgered.state.sourceChannelId, options) !== 'resumed') return unavailable();
    log({ event: 'source_resumed', conversionId: ledgered.state.conversionId });
    return rejected('ceiling_exceeded');
  }

  /**
   * Seals everything after `sealedThrough` while the source is paused. Unlike a
   * catch-up, a retried drain re-reads the tail every time: a caller that resumed the
   * source after a failed attempt may have let messages in, and they must not be lost.
   */
  async function sealDrain(current: Ledgered, key: TransferStepKey): Promise<Ledgered> {
    const read = readSource(deps.source, current.state.sourceChannelId, current.state.sealedThrough, null);
    if (read === null) return stop(rejected('source_changed'));
    if (read.records.length === 0) return sameStep(current.state.pending, key) ? current : save(current, { ...current.state, pending: key });
    // The manifest already names the archive; messages written after it cannot join it.
    if (current.state.manifest !== null) return stop(rejected('source_changed'));
    const base = { ...current.state, sourceRevision: read.revision };
    const chunks = await sealFrom(base, read.records, base.chunks.length, deps.limits);
    const drained = base.chunks.length - base.drainFromChunk! + (chunks?.length ?? 0);
    if (chunks === null || drained > deps.ceiling.maxDrainChunks || base.chunks.length + chunks.length > deps.limits.maxChunks) {
      return stop(rejected('ceiling_exceeded'));
    }
    const refs: SealedChunkRef[] = chunks.map(chunk => ({
      index: chunk.index, recordCount: chunk.records.length, firstSequence: chunk.records[0]!.sequence,
      lastSequence: chunk.records.at(-1)!.sequence, chunkDigest: chunk.chunkDigest, partId: null,
    }));
    return save(current, {
      ...base, chunks: [...base.chunks, ...refs], sealedThrough: Math.max(base.sealedThrough, read.latestSequence), pending: key,
    });
  }

  async function drain(current: Ledgered, key: TransferStepKey, options?: CallOptions): Promise<Result> {
    let ledgered = current;
    if (await deps.gate.pause(ledgered.state.sourceChannelId, options) !== 'paused') return unavailable();
    if (ledgered.state.drainStartedAt === null) {
      ledgered = save(ledgered, { ...ledgered.state, drainStartedAt: deps.now(), drainFromChunk: ledgered.state.chunks.length });
    }
    const deadline = ledgered.state.drainStartedAt! + deps.ceiling.drainDeadlineMs;
    // Other failures leave the source paused: the caller retries, bounded by the persisted
    // deadline, or fails the conversion, which resumes the internal channel.
    try {
      if (deps.now() > deadline) stop(rejected('ceiling_exceeded'));
      ledgered = await sealDrain(ledgered, key);
      ledgered = await sendPending(ledgered, deps.limits, deadline, options);
    } catch (error) {
      if (error instanceof Stop && error.result.kind === 'rejected' && error.result.code === 'ceiling_exceeded') {
        return block(ledgered.state.conversionId, options);
      }
      if (error instanceof Stop && error.result.kind === 'rejected' && error.result.code === 'source_changed') {
        // No drain can finish this archive; hand the channel back before reporting it.
        if (await deps.gate.resume(ledgered.state.sourceChannelId, options) !== 'resumed') return unavailable();
        log({ event: 'source_resumed', conversionId: ledgered.state.conversionId });
      }
      throw error;
    }
    if (ledgered.state.manifest === null) {
      const digest = await digestImportedHistoryManifest(manifestOf(ledgered.state));
      if (!digest.ok) return unavailable();
      ledgered = save(ledgered, { ...ledgered.state, manifest: { digest: digest.value, partId: null } });
    }
    if (ledgered.state.manifest!.partId === null) {
      const part: ArchivePart = { kind: 'manifest', archiveId: ledgered.state.archiveId, manifest: manifestOf(ledgered.state) };
      const sent = await deps.deliver(ledgered.state.destinationRoomId as RoomId, part, options);
      if (sent.kind !== 'ok') return mapTransport(sent);
      ledgered = save(ledgered, { ...ledgered.state, manifest: { ...ledgered.state.manifest!, partId: sent.value.partId } });
      log({ event: 'manifest_acknowledged', conversionId: ledgered.state.conversionId, reconciled: sent.value.reconciled });
    }
    ledgered = complete(ledgered, key, 'converged');
    return ok(progress(ledgered.state, 'converged', ledgered.state.manifest!.digest));
  }

  async function authorize(step: HistoryTransferStep, options?: CallOptions): Promise<Readonly<{ record: ConversionRecord; target: ConversionTarget }>> {
    const read = await deps.journal.read(step.conversionId, options);
    if (read.kind === 'rejected') return stop(rejected('not_found'));
    if (read.kind !== 'ok') return stop(read.kind === 'unavailable' ? unavailable() : outcomeUnknown(read.operationId));
    const record = read.value;
    if (record.operationId !== step.operationId) return stop(rejected('operation_mismatch'));
    if (record.historyMode !== 'carry_history') return stop(rejected('wrong_state'));
    const target = await deps.target(step.conversionId, options);
    if (target === null) return stop(rejected('not_found'));
    const signedIn = deps.session();
    if (signedIn === null || signedIn.ownerId !== target.owner.ownerId || signedIn.participantId !== target.owner.participantId) {
      return stop(rejected('forbidden'));
    }
    return { record, target };
  }

  function bound(state: TransferLedgerState, step: HistoryTransferStep, target: ConversionTarget): boolean {
    return state.operationId === step.operationId && state.sourceChannelId === target.sourceChannelId
      && state.destinationRoomId === target.destinationRoomId && state.ownerId === target.owner.ownerId
      && state.participantId === target.owner.participantId;
  }

  async function run(input: HistoryTransferStep, options?: CallOptions): Promise<Result> {
    const decoded = decodeHistoryTransferStep(input);
    if (!decoded.ok) return rejected('invalid_request');
    const step = decoded.value;
    const { record, target } = await authorize(step, options);
    const key: TransferStepKey = { phase: step.phase, round: step.round };

    const found = deps.ledger.read(step.conversionId);
    let ledgered: Ledgered;
    if (found.kind === 'found') {
      if (!bound(found.state, step, target)) return rejected('forbidden');
      ledgered = { state: found.state, revision: found.revision };
    } else {
      if (!sameStep(nextStep(null), key)) return rejected('wrong_state');
      ledgered = {
        revision: null,
        state: {
          v: 1, conversionId: step.conversionId, operationId: step.operationId, archiveId: `history.${step.conversionId}`,
          importedAt: new Date(deps.now()).toISOString().replace(/\.\d{3}Z$/, 'Z'),
          sourceChannelId: target.sourceChannelId, destinationRoomId: target.destinationRoomId,
          ownerId: target.owner.ownerId, participantId: target.owner.participantId,
          sealedThrough: 0, sourceRevision: '0', chunks: [], pending: null, completed: null, drainStartedAt: null, drainFromChunk: null,
          manifest: null, blocked: false,
        },
      };
    }
    const { state } = ledgered;
    if (state.blocked) return block(state.conversionId, options);
    if (step.afterChunk > acknowledged(state)) return rejected('operation_mismatch');
    // A replay of the finished step reports what it reported, without touching the source or destination.
    if (sameStep(state.completed, key)) {
      return ok(progress(state, state.completed!.outcome, await currentDigest(state)));
    }
    if (!sameStep(nextStep(state.completed), key)) return rejected('wrong_state');
    if (record.state !== requiredState(key, state.completed)) return rejected('wrong_state');
    return key.phase === 'final_drain' ? drain(ledgered, key, options) : copyOrCatchUp(ledgered, key, options);
  }

  return {
    async step(input, options) {
      try {
        return await run(input, options);
      } catch (error) {
        if (error instanceof Stop) return error.result;
        throw error;
      }
    },
  };
}
