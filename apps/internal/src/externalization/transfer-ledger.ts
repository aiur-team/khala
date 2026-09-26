import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  type Decoded, type Reader, array, decodeWith, fail, identifier, literal, nullable, object, safeInteger, utcTimestamp, version,
} from '@khala/contracts/messaging/decode';

// Durable acknowledgements for one history transfer per conversion. The ledger holds
// identifiers, sequence bounds and digests only: never a message body, author label or
// sealed chunk. A resumed transfer re-reads the source range and proves it reproduces
// the recorded digest before re-sending anything.

export const HISTORY_TRANSFER_LEDGER_FILE = 'history-transfer.sqlite';

export type TransferStepKey = Readonly<{ phase: 'copy' | 'catch_up' | 'final_drain'; round: number }>;

/** One sealed chunk: its source range, its digest and, once acknowledged, the destination's part ID. */
export type SealedChunkRef = Readonly<{
  index: number;
  recordCount: number;
  firstSequence: number;
  lastSequence: number;
  chunkDigest: string;
  partId: string | null;
}>;

export type TransferLedgerState = Readonly<{
  v: 1;
  conversionId: string;
  operationId: string;
  archiveId: string;
  importedAt: string;
  sourceChannelId: string;
  destinationRoomId: string;
  ownerId: string;
  participantId: string;
  /** Highest source sequence sealed into a chunk; 0 before any. */
  sealedThrough: number;
  /** Source channel revision observed when `sealedThrough` was read. */
  sourceRevision: string;
  chunks: readonly SealedChunkRef[];
  /** The step whose chunks are sealed but not yet all acknowledged. */
  pending: TransferStepKey | null;
  /** The last finished step and what it reported. */
  completed: (TransferStepKey & Readonly<{ outcome: 'more' | 'converged' | 'drain_required' }>) | null;
  /** Wall-clock milliseconds when the paused drain first started; bounds every retry. */
  drainStartedAt: number | null;
  /** Chunk count when the drain first started; every chunk from here on counts against `maxDrainChunks`. */
  drainFromChunk: number | null;
  manifest: Readonly<{ digest: string; partId: string | null }> | null;
  /** A drain that exceeded its ceiling; the transfer stays blocked and never restarts. */
  blocked: boolean;
}>;

export type TransferLedgerRead =
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'found'; state: TransferLedgerState; revision: number }>;

export interface HistoryTransferLedger {
  read(conversionId: string): TransferLedgerRead;
  /** Compare-and-set on the row revision; `expected` null creates the row. */
  write(state: TransferLedgerState, expected: number | null): Readonly<{ kind: 'written'; revision: number } | { kind: 'conflict' }>;
  close(): void;
}

export class TransferLedgerError extends Error {
  constructor(readonly code: 'unsafe_path' | 'corrupt') {
    super(code);
  }
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS history_transfers (
  conversion_id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  state TEXT NOT NULL
) STRICT;
`;

const step = (r: Reader): TransferStepKey => ({
  phase: literal(r.field('phase'), r.at('phase'), ['copy', 'catch_up', 'final_drain']),
  round: safeInteger(r.field('round'), r.at('round')),
});

function readChunk(input: unknown, at: string): SealedChunkRef {
  const r = object(input, at, ['index', 'recordCount', 'firstSequence', 'lastSequence', 'chunkDigest', 'partId']);
  return {
    index: safeInteger(r.field('index'), r.at('index')),
    recordCount: safeInteger(r.field('recordCount'), r.at('recordCount')),
    firstSequence: safeInteger(r.field('firstSequence'), r.at('firstSequence')),
    lastSequence: safeInteger(r.field('lastSequence'), r.at('lastSequence')),
    chunkDigest: identifier(r.field('chunkDigest'), r.at('chunkDigest')),
    partId: nullable(r.field('partId'), value => identifier(value, r.at('partId'))),
  };
}

export function decodeTransferLedgerState(input: unknown): Decoded<TransferLedgerState> {
  return decodeWith(() => {
    const r = object(input, '', [
      'v', 'conversionId', 'operationId', 'archiveId', 'importedAt', 'sourceChannelId', 'destinationRoomId', 'ownerId',
      'participantId', 'sealedThrough', 'sourceRevision', 'chunks', 'pending', 'completed', 'drainStartedAt', 'drainFromChunk', 'manifest', 'blocked',
    ]);
    const id = (key: string) => identifier(r.field(key), r.at(key));
    return {
      v: version(r.field('v'), r.at('v')),
      conversionId: id('conversionId'),
      operationId: id('operationId'),
      archiveId: id('archiveId'),
      importedAt: utcTimestamp(r.field('importedAt'), r.at('importedAt')),
      sourceChannelId: id('sourceChannelId'),
      destinationRoomId: id('destinationRoomId'),
      ownerId: id('ownerId'),
      participantId: id('participantId'),
      sealedThrough: safeInteger(r.field('sealedThrough'), r.at('sealedThrough')),
      sourceRevision: id('sourceRevision'),
      chunks: array(r.field('chunks'), r.at('chunks')).map((value, index) => readChunk(value, `${r.at('chunks')}[${index}]`)),
      pending: nullable(r.field('pending'), value => step(object(value, r.at('pending'), ['phase', 'round']))),
      completed: nullable(r.field('completed'), value => {
        const c = object(value, r.at('completed'), ['phase', 'round', 'outcome']);
        return { ...step(c), outcome: literal(c.field('outcome'), c.at('outcome'), ['more', 'converged', 'drain_required']) };
      }),
      drainStartedAt: nullable(r.field('drainStartedAt'), value => safeInteger(value, r.at('drainStartedAt'))),
      drainFromChunk: nullable(r.field('drainFromChunk'), value => safeInteger(value, r.at('drainFromChunk'))),
      manifest: nullable(r.field('manifest'), value => {
        const m = object(value, r.at('manifest'), ['digest', 'partId']);
        return {
          digest: identifier(m.field('digest'), m.at('digest')),
          partId: nullable(m.field('partId'), part => identifier(part, m.at('partId'))),
        };
      }),
      blocked: typeof r.field('blocked') === 'boolean' ? r.field('blocked') as boolean : fail(r.at('blocked'), 'wrong_type'),
    };
  });
}

function assertPrivateDirectory(directory: string): void {
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(directory);
  } catch {
    throw new TransferLedgerError('unsafe_path');
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : null;
  if (!stats.isDirectory() || (stats.mode & 0o077) !== 0 || (uid !== null && stats.uid !== uid)) {
    throw new TransferLedgerError('unsafe_path');
  }
}

/**
 * Opens the ledger inside an owner-private (0700) directory. The database file is
 * created 0600 before SQLite opens it, so SQLite's journal inherits the same mode.
 */
export function openHistoryTransferLedger(directory: string): HistoryTransferLedger {
  assertPrivateDirectory(directory);
  const file = path.join(directory, HISTORY_TRANSFER_LEDGER_FILE);
  try {
    fs.closeSync(fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new TransferLedgerError('unsafe_path');
  }
  const stats = fs.lstatSync(file);
  if (!stats.isFile() || stats.nlink !== 1 || (stats.mode & 0o777) !== 0o600) throw new TransferLedgerError('unsafe_path');
  const db = new DatabaseSync(file, { allowExtension: false });
  db.exec('PRAGMA synchronous = FULL');
  db.exec(SCHEMA_SQL);
  const select = db.prepare('SELECT revision, state FROM history_transfers WHERE conversion_id = ?');
  const insert = db.prepare('INSERT OR IGNORE INTO history_transfers (conversion_id, revision, state) VALUES (?, 1, ?)');
  const update = db.prepare('UPDATE history_transfers SET revision = revision + 1, state = ? WHERE conversion_id = ? AND revision = ?');

  return {
    read(conversionId) {
      const row = select.get(conversionId) as { revision: number; state: string } | undefined;
      if (row === undefined) return { kind: 'absent' };
      const decoded = decodeTransferLedgerState(JSON.parse(row.state));
      if (!decoded.ok || decoded.value.conversionId !== conversionId) throw new TransferLedgerError('corrupt');
      return { kind: 'found', state: decoded.value, revision: Number(row.revision) };
    },
    write(state, expected) {
      const json = JSON.stringify(state);
      if (expected === null) {
        return insert.run(state.conversionId, json).changes === 1 ? { kind: 'written', revision: 1 } : { kind: 'conflict' };
      }
      return update.run(json, state.conversionId, expected).changes === 1
        ? { kind: 'written', revision: expected + 1 } : { kind: 'conflict' };
    },
    close() {
      db.close();
    },
  };
}
