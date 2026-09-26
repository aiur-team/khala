import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  CONVERSION_AGENT_BLOCKS, CONVERSION_AGENT_STATUSES, CONVERSION_VERSION, type ConversionAgentIdentity,
  type ConversionAgentState, type ConversionJournalPort, type ConversionJournalRejection, type ConversionRecord,
  type ConversionStart, type ConversionSnapshot, type ConversionState, type HostedChannelCreated, decodeConversionRecord,
  isAllowedTransition,
} from '@khala/contracts/messaging/externalization';
import {
  type Decoded, type Reader, array, decodeWith, elementPath, fail, identifier, literal, nullable, object, safeInteger, version,
} from '@khala/contracts/messaging/decode';
import { type OperationResult, ok, rejected, unavailable } from '@khala/contracts/messaging/outcomes';
import { type ChannelConversionLock, channelConversionKey, readChannelConversionLock } from '../store/conversion-lock';
import type { InternalStoreHandle } from '../store/open';

// Durable conversion journal inside the internal store. A conversion is one
// `control_records` row holding its record, the immutable snapshot the human
// confirmed, the destination once created, and every selected agent's status. The
// source channel's write state is a second row, changed in the same transaction as
// the conversion state it follows:
//
// - `committing` pauses source writes (the final write pause);
// - `activating` is the link commit: the source becomes read-only for good, discovery
//   stops treating it as eligible so every old listing reference stops resolving, and
//   the activation intent (every ready agent still to release) is already journaled;
// - `cancelled` and `failed`, reachable only before the link commit, unfreeze the source.
//
// Every write is idempotent by operation ID and guarded by the record revision.

const conversionKey = (conversionId: string): string => `conversion.v1.${conversionId}`;
const operationKey = (operationId: string): string => `conversion:${operationId}`;

export type ConversionEntry = Readonly<{
  v: 1;
  record: ConversionRecord;
  snapshot: ConversionSnapshot;
  destination: HostedChannelCreated | null;
  agents: readonly ConversionAgentState[];
}>;

export type ConversionStartRejection = 'not_found' | 'invalid_selection' | 'conflict' | 'operation_mismatch';

export type ConversionChange = Readonly<{
  conversionId: string;
  operationId: string;
  expectedRevision: number;
  /** When given, the state the caller believes current; a mismatch is `stale_revision`. */
  from?: ConversionState;
  /** Omitted: record the other fields without leaving the current state. */
  to?: ConversionState;
  destination?: HostedChannelCreated;
  agents?: readonly ConversionAgentState[];
}>;

export type ConversionChangeRejection = ConversionJournalRejection | 'invalid_change';

export interface ConversionJournal extends ConversionJournalPort {
  /** Snapshots the source channel and journals the conversion in one transaction. */
  start(input: ConversionStart): Promise<OperationResult<ConversionEntry, ConversionStartRejection>>;
  entry(conversionId: string): Promise<OperationResult<ConversionEntry, 'not_found'>>;
  change(input: ConversionChange): Promise<OperationResult<ConversionEntry, ConversionChangeRejection>>;
  sourceLock(channelId: string): Promise<OperationResult<ChannelConversionLock | null, never>>;
}

const identity = (r: Reader): ConversionAgentIdentity => ({
  participantId: identifier(r.field('participantId'), r.at('participantId')),
  harness: identifier(r.field('harness'), r.at('harness')),
  sessionId: identifier(r.field('sessionId'), r.at('sessionId')),
  generation: safeInteger(r.field('generation'), r.at('generation')),
});

function decodeEntry(input: unknown): Decoded<ConversionEntry> {
  return decodeWith(() => {
    const r = object(input, '', ['v', 'record', 'snapshot', 'destination', 'agents']);
    const record = decodeConversionRecord(r.field('record'));
    if (!record.ok) fail(r.at('record'), 'invalid_value');
    const s = object(r.field('snapshot'), r.at('snapshot'), [
      'v', 'historyMode', 'sourceChannelId', 'sourceRevision', 'title', 'visibility', 'humans', 'agents',
    ]);
    const snapshot: ConversionSnapshot = {
      v: version(s.field('v'), s.at('v')),
      historyMode: literal(s.field('historyMode'), s.at('historyMode'), ['start_fresh', 'carry_history']),
      sourceChannelId: identifier(s.field('sourceChannelId'), s.at('sourceChannelId')),
      sourceRevision: safeInteger(s.field('sourceRevision'), s.at('sourceRevision')),
      title: nullable(s.field('title'), value => typeof value === 'string' ? value : fail(s.at('title'), 'wrong_type')),
      visibility: literal(s.field('visibility'), s.at('visibility'), ['public', 'private', 'secret']),
      humans: array(s.field('humans'), s.at('humans')).map((value, index) => identifier(value, elementPath(s.at('humans'), index))),
      agents: array(s.field('agents'), s.at('agents'))
        .map((value, index) => identity(object(value, elementPath(s.at('agents'), index), ['participantId', 'harness', 'sessionId', 'generation']))),
    };
    const destination = nullable(r.field('destination'), value => {
      const d = object(value, r.at('destination'), ['idempotencyKey', 'destinationChannelId', 'visibility']);
      return {
        idempotencyKey: identifier(d.field('idempotencyKey'), d.at('idempotencyKey')),
        destinationChannelId: identifier(d.field('destinationChannelId'), d.at('destinationChannelId')),
        visibility: literal(d.field('visibility'), d.at('visibility'), ['public', 'private', 'secret']),
      };
    });
    const agents = array(r.field('agents'), r.at('agents')).map((value, index) => {
      const a = object(value, elementPath(r.at('agents'), index), ['participantId', 'status', 'requestHandle', 'block', 'attempt', 'released']);
      return {
        participantId: identifier(a.field('participantId'), a.at('participantId')),
        status: literal(a.field('status'), a.at('status'), CONVERSION_AGENT_STATUSES),
        requestHandle: nullable(a.field('requestHandle'), handle => identifier(handle, a.at('requestHandle'))),
        block: nullable(a.field('block'), block => literal(block, a.at('block'), CONVERSION_AGENT_BLOCKS)),
        attempt: safeInteger(a.field('attempt'), a.at('attempt')),
        released: a.field('released') === true,
      };
    });
    return { v: version(r.field('v'), r.at('v')), record: record.value, snapshot, destination, agents };
  });
}

class JournalCorrupt extends Error {}

type Db = DatabaseSync;

function readEntry(db: Db, conversionId: string): ConversionEntry | null {
  const row = db.prepare('SELECT value FROM control_records WHERE record_key = ?').get(conversionKey(conversionId)) as { value: string } | undefined;
  if (!row) return null;
  const decoded = decodeEntry(JSON.parse(row.value));
  if (!decoded.ok || decoded.value.record.conversionId !== conversionId) throw new JournalCorrupt();
  return decoded.value;
}

const newRevision = (): string => `crev_${randomBytes(16).toString('base64url')}`;

function writeRecord(db: Db, key: string, operationId: string, value: unknown): void {
  db.prepare(`
    INSERT INTO control_records (record_key, revision, operation_id, value, expires_at) VALUES (?, ?, ?, ?, NULL)
    ON CONFLICT (record_key) DO UPDATE SET revision = excluded.revision, operation_id = excluded.operation_id, value = excluded.value
  `).run(key, newRevision(), operationId, JSON.stringify(value));
}

type Claim = Readonly<{ fingerprint: string; conversionId: string }>;

function claimed(db: Db, operationId: string): Claim | null {
  const row = db.prepare('SELECT value FROM control_operations WHERE operation_id = ?').get(operationKey(operationId)) as { value: string } | undefined;
  return row ? JSON.parse(row.value) as Claim : null;
}

/** An operation replay returns the entry as its first call left it. */
function replayed(db: Db, operationId: string): ConversionEntry | null {
  const row = db.prepare('SELECT record_key, value FROM control_operations WHERE operation_id = ?')
    .get(operationKey(operationId)) as { record_key: string; value: string } | undefined;
  if (!row) return null;
  const decoded = decodeEntry((JSON.parse(row.value) as { entry: unknown }).entry);
  if (!decoded.ok) throw new JournalCorrupt();
  return decoded.value;
}

function claim(db: Db, operationId: string, fingerprint: string, entry: ConversionEntry): void {
  db.prepare('INSERT INTO control_operations (operation_id, record_key, revision, value, expires_at) VALUES (?, ?, ?, ?, NULL)')
    .run(operationKey(operationId), conversionKey(entry.record.conversionId), String(entry.record.revision),
      JSON.stringify({ fingerprint, conversionId: entry.record.conversionId, entry }));
}

type SnapshotRead = ConversionSnapshot | 'not_found' | 'invalid_selection';

/** The source channel as the human confirmed it: its revision, joined humans and each selected agent's active session. */
function snapshotSource(db: Db, input: ConversionStart): SnapshotRead {
  const channel = db.prepare('SELECT title, revision FROM channels WHERE channel_id = ?')
    .get(input.sourceChannelId) as { title: string | null; revision: number } | undefined;
  if (!channel) return 'not_found';
  const members = db.prepare(`
    SELECT p.participant_id, p.kind FROM memberships m JOIN participants p ON p.participant_id = m.participant_id
    WHERE m.channel_id = ? AND m.membership = 'joined' ORDER BY p.participant_id
  `).all(input.sourceChannelId) as unknown as Array<{ participant_id: string; kind: 'human' | 'agent' }>;
  const agents: ConversionAgentIdentity[] = [];
  for (const participantId of [...input.agents].sort()) {
    if (!members.some(member => member.participant_id === participantId && member.kind === 'agent')) return 'invalid_selection';
    const binding = db.prepare(`
      SELECT harness, session_id, generation FROM bindings
      WHERE participant_id = ? AND status = 'active' ORDER BY generation DESC LIMIT 1
    `).get(participantId) as { harness: string; session_id: string; generation: number } | undefined;
    if (!binding) return 'invalid_selection';
    agents.push({ participantId, harness: binding.harness, sessionId: binding.session_id, generation: Number(binding.generation) });
  }
  return {
    v: 1,
    historyMode: input.historyMode,
    sourceChannelId: input.sourceChannelId,
    sourceRevision: Number(channel.revision),
    title: channel.title,
    visibility: input.visibility,
    humans: members.filter(member => member.kind === 'human').map(member => member.participant_id),
    agents,
  };
}

const TERMINAL: readonly ConversionState[] = ['externalized', 'cancelled', 'failed'];

/** Applies the source write state a transition carries. Returns false when the lock is not this conversion's. */
function moveSource(db: Db, entry: ConversionEntry, to: ConversionState, operationId: string): boolean {
  const channelId = entry.snapshot.sourceChannelId;
  const lock = readChannelConversionLock(db, channelId);
  if (lock?.conversionId !== entry.record.conversionId) return false;
  const key = channelConversionKey(channelId);
  if (to === 'committing') {
    writeRecord(db, key, operationId, { ...lock, write: 'paused' } satisfies ChannelConversionLock);
  } else if (to === 'activating') {
    if (lock.write !== 'paused' || entry.destination === null) return false;
    writeRecord(db, key, operationId, {
      conversionId: lock.conversionId, write: 'linked', destinationChannelId: entry.destination.destinationChannelId,
    } satisfies ChannelConversionLock);
  } else if (to === 'cancelled' || to === 'failed') {
    if (lock.write === 'linked') return false;
    db.prepare('DELETE FROM control_records WHERE record_key = ?').run(key);
  }
  return true;
}

function sameAgents(entry: ConversionEntry, agents: readonly ConversionAgentState[]): boolean {
  const selected = entry.snapshot.agents.map(agent => agent.participantId);
  return agents.length === selected.length && agents.every((agent, index) => agent.participantId === selected[index]);
}

export function createConversionJournal(handle: InternalStoreHandle): ConversionJournal {
  const run = <T, C extends string>(body: () => OperationResult<T, C>): Promise<OperationResult<T, C>> => {
    try {
      return Promise.resolve(body());
    } catch {
      return Promise.resolve(unavailable());
    }
  };

  function applyChange(input: ConversionChange): OperationResult<ConversionEntry, ConversionChangeRejection> {
    const fingerprint = JSON.stringify(['change', input.conversionId, input.expectedRevision, input.from ?? null, input.to ?? null,
      input.destination ?? null, input.agents ?? null]);
    return handle.transaction(db => {
      const previous = claimed(db, input.operationId);
      if (previous) {
        return previous.fingerprint === fingerprint ? ok(replayed(db, input.operationId)!) : rejected('operation_mismatch');
      }
      const current = readEntry(db, input.conversionId);
      if (!current) return rejected('not_found');
      if (current.record.revision !== input.expectedRevision
        || (input.from !== undefined && current.record.state !== input.from)) return rejected('stale_revision');
      const to = input.to ?? current.record.state;
      if (input.to !== undefined && !isAllowedTransition(current.record.state, input.to)) return rejected('invalid_transition');
      if (input.to === undefined && TERMINAL.includes(to)) return rejected('invalid_transition');
      if (input.destination && current.destination
        && JSON.stringify(input.destination) !== JSON.stringify(current.destination)) return rejected('invalid_change');
      if (input.agents && !sameAgents(current, input.agents)) return rejected('invalid_change');
      const next: ConversionEntry = {
        ...current,
        record: { ...current.record, state: to, revision: current.record.revision + 1 },
        destination: input.destination ?? current.destination,
        agents: input.agents ?? current.agents,
      };
      if (input.to !== undefined && !moveSource(db, next, input.to, input.operationId)) return rejected('invalid_transition');
      writeRecord(db, conversionKey(input.conversionId), input.operationId, next);
      claim(db, input.operationId, fingerprint, next);
      return ok(next);
    });
  }

  return {
    start(input) {
      const fingerprint = JSON.stringify(['start', input]);
      return run(() => handle.transaction(db => {
        const previous = claimed(db, input.operationId);
        if (previous) return previous.fingerprint === fingerprint ? ok(replayed(db, input.operationId)!) : rejected('operation_mismatch');
        // A conversion ID names one confirmed choice; asking again with another choice conflicts.
        if (readEntry(db, input.conversionId)) return rejected('conflict');
        const lock = readChannelConversionLock(db, input.sourceChannelId);
        if (lock) return rejected('conflict');
        const snapshot = snapshotSource(db, input);
        if (typeof snapshot === 'string') return rejected(snapshot);
        const entry: ConversionEntry = {
          v: 1,
          record: {
            v: CONVERSION_VERSION, conversionId: input.conversionId, operationId: input.operationId,
            historyMode: input.historyMode, state: 'preparing', revision: 0,
          },
          snapshot,
          destination: null,
          agents: snapshot.agents.map(agent => ({
            participantId: agent.participantId, status: 'verifying', requestHandle: null, block: null, attempt: 0, released: false,
          })),
        };
        writeRecord(db, conversionKey(input.conversionId), input.operationId, entry);
        writeRecord(db, channelConversionKey(input.sourceChannelId), input.operationId, {
          conversionId: input.conversionId, write: 'open', destinationChannelId: null,
        } satisfies ChannelConversionLock);
        claim(db, input.operationId, fingerprint, entry);
        return ok(entry);
      }));
    },

    entry(conversionId) {
      return run(() => handle.read(db => {
        const entry = readEntry(db, conversionId);
        return entry ? ok(entry) : rejected('not_found');
      }));
    },

    change(input) {
      return run(() => applyChange(input));
    },

    sourceLock(channelId) {
      return run(() => ok(handle.read(db => readChannelConversionLock(db, channelId))));
    },

    /** A conversion begins only from a snapshot, through `start`; `create` replays that start. */
    create(input) {
      return run(() => handle.read(db => {
        const entry = replayed(db, input.operationId);
        return entry && entry.record.conversionId === input.conversionId && entry.record.historyMode === input.historyMode
          ? ok(entry.record) : rejected('operation_mismatch');
      }));
    },

    read(conversionId) {
      return run(() => handle.read(db => {
        const entry = readEntry(db, conversionId);
        return entry ? ok(entry.record) : rejected('not_found');
      }));
    },

    async advance(input) {
      const { conversionId, operationId, expectedRevision, from, to } = input;
      const result = await run(() => applyChange({ conversionId, operationId, expectedRevision, from, to }));
      switch (result.kind) {
        case 'ok': return ok(result.value.record);
        case 'rejected': return rejected(result.code === 'invalid_change' ? 'invalid_transition' : result.code);
        default: return result;
      }
    },
  };
}
