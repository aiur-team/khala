import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { type SessionBinding, sameSessionBinding } from '@khala/contracts/delivery/index';
import {
  type ChannelMembership, type DeviceId, type EventId, MESSAGE_ENCODING_V1,
  type MessageContent, type OwnerId, type ParticipantId, type ParticipantView,
  type RoomId, encodeMessageContent,
} from '@khala/contracts/messaging/index';
import { decodeEventId, decodeParticipantId } from '@khala/contracts/messaging/ids';
import { projectNamesInOrder, validateAgentName, type NameTimelineEvent } from '@khala/contracts/messaging/agent-names';
import {
  decodeSubscriptionCursor, decodeTimelineCursor, encodeSubscriptionCursor, encodeTimelineCursor,
} from './cursors';
import { isChannelLinked, isChannelWritable } from './conversion-lock';
import type { InternalStoreHandle } from './open';

export type RegisteredParticipant = Omit<ParticipantView, 'deviceIds'>;
export type TrustedBinding = SessionBinding;
export type StoredBinding = SessionBinding & Readonly<{ status: 'active' | 'revoked' }>;

export type StoredChannel = Readonly<{
  channelId: RoomId;
  title: string | null;
  membership: ChannelMembership;
  revision: string;
}>;

export type StoredEvent = Readonly<{
  sequence: number;
  eventId: EventId;
  channelId: RoomId;
  authorParticipantId: ParticipantId;
  authorDeviceId: DeviceId;
  clientTxnId: string;
  content: MessageContent;
  canonicalPayload: Uint8Array;
  contentDigest: string;
  receivedAt: string;
  participant: ParticipantView;
}>;

type MutationResult<Code extends string> =
  | Readonly<{ kind: 'done'; changed: boolean }>
  | Readonly<{ kind: 'rejected'; code: Code }>
  | Readonly<{ kind: 'unavailable' }>;

type ParticipantRegistrationResult = MutationResult<'identity_mismatch' | 'invalid_input'>;
type DeviceRegistrationResult = MutationResult<'identity_mismatch' | 'not_found' | 'invalid_input'>;
type BindingRegistrationResult = MutationResult<'identity_mismatch' | 'not_found' | 'invalid_input'>;
type BindingRevocationResult = MutationResult<'not_found' | 'invalid_input'>;
/** `read_only`: nobody joins a channel whose conversion linked it to its external channel. */
type MembershipResult = MutationResult<'not_found' | 'read_only' | 'invalid_input'>;

export type BindingReadResult =
  | Readonly<{ kind: 'done'; binding: StoredBinding }>
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'rejected'; code: 'binding_mismatch' }>
  | Readonly<{ kind: 'unavailable' }>;

export type SessionBindingResult =
  | Readonly<{ kind: 'done'; binding: StoredBinding | null }>
  | Readonly<{ kind: 'unavailable' }>;

export type LatestGenerationResult =
  | Readonly<{ kind: 'done'; generation: number | null }>
  | Readonly<{ kind: 'unavailable' }>;

export type CreateChannelResult =
  | Readonly<{ kind: 'created' | 'replayed'; channel: StoredChannel }>
  | Readonly<{ kind: 'rejected'; code: 'identity_mismatch' | 'operation_mismatch' | 'invalid_input' }>
  | Readonly<{ kind: 'unavailable' }>;

export type CreatedChannelLookup =
  | Readonly<{ kind: 'found'; channel: StoredChannel }>
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'rejected'; code: 'operation_mismatch' | 'invalid_input' }>
  | Readonly<{ kind: 'unavailable' }>;

export type ChannelReadResult =
  | Readonly<{ kind: 'done'; channel: StoredChannel }>
  | Readonly<{ kind: 'rejected'; code: 'not_found' | 'not_joined' | 'invalid_input' }>
  | Readonly<{ kind: 'unavailable' }>;

export type ChannelListResult = Readonly<{ kind: 'done'; channels: readonly StoredChannel[] }> | Readonly<{ kind: 'unavailable' }>;

export type RosterResult =
  | Readonly<{ kind: 'done'; participants: readonly ParticipantView[] }>
  | Readonly<{ kind: 'rejected'; code: 'not_found' }>
  | Readonly<{ kind: 'unavailable' }>;

export type ProvenanceResult =
  | Readonly<{ kind: 'done'; participantId: ParticipantId | null }>
  | Readonly<{ kind: 'unavailable' }>;

export type SendResult =
  | Readonly<{ kind: 'stored' | 'replayed'; event: StoredEvent }>
  | Readonly<{ kind: 'rejected'; code: 'identity_mismatch' | 'not_found' | 'not_joined' | 'operation_mismatch' | 'read_only' | 'invalid_input' }>
  | Readonly<{ kind: 'unavailable' }>;

export type TimelineResult =
  | Readonly<{ kind: 'done'; events: readonly StoredEvent[]; nextCursor: string | null; revision: string }>
  | Readonly<{ kind: 'rejected'; code: 'not_found' | 'not_joined' | 'invalid_cursor' | 'invalid_input' }>
  | Readonly<{ kind: 'unavailable' }>;

export type SubscriptionReadResult =
  | Readonly<{ kind: 'page'; events: readonly StoredEvent[]; nextCursor: string; caughtUp: boolean }>
  | Readonly<{ kind: 'rejected'; code: 'binding_mismatch' | 'binding_revoked' | 'stale_binding' | 'not_joined' | 'invalid_cursor' | 'invalid_input' }>
  | Readonly<{ kind: 'unavailable' }>;

/** Notification state only: no event, body, release, cursor, or token leaves this query. */
export type PendingHumanReleaseResult = Readonly<{ kind: 'pending'; pending: boolean }> | Readonly<{ kind: 'unavailable' }>;

export type ChannelUpdate = Readonly<{ channel: StoredChannel; events: readonly StoredEvent[] }>;

type ParticipantRow = Readonly<{
  participant_id: string;
  owner_id: string;
  kind: 'human' | 'agent';
  display_name: string;
}>;

type BindingRow = Readonly<{
  binding_id: string;
  generation: number;
  owner_id: string;
  participant_id: string;
  device_id: string;
  harness: string;
  session_id: string;
  status: 'active' | 'revoked';
}>;

type ChannelRow = Readonly<{
  channel_id: string;
  title: string | null;
  revision: number;
  membership: ChannelMembership | null;
}>;

type EventRow = Readonly<{
  sequence: number;
  event_id: string;
  channel_id: string;
  author_participant_id: string;
  author_device_id: string;
  client_txn_id: string;
  canonical_payload: Uint8Array;
  content_digest: string;
  received_at: string;
}>;

type ParticipantDeviceRow = ParticipantRow & Readonly<{ device_id: string | null }>;

const isIdentifier = (value: string): boolean => value.length > 0 && !value.includes('\0');
const isGeneration = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;
const isLimit = (value: number): boolean => Number.isSafeInteger(value) && value >= 1 && value <= 1_000;
const isTimestamp = (value: string): boolean => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  && !Number.isNaN(Date.parse(value));

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.from(a).equals(Buffer.from(b));
}

function participantView(db: DatabaseSync, participantId: string): ParticipantView | null {
  const row = db.prepare(`
    SELECT participant_id, owner_id, kind, display_name
    FROM participants WHERE participant_id = ?
  `).get(participantId) as ParticipantRow | undefined;
  if (!row) return null;
  const devices = db.prepare('SELECT device_id FROM devices WHERE participant_id = ? ORDER BY device_id')
    .all(participantId) as unknown as Array<{ device_id: string }>;
  return {
    participantId: row.participant_id as ParticipantId,
    ownerId: row.owner_id as OwnerId,
    kind: row.kind,
    displayName: row.display_name,
    deviceIds: devices.map(device => device.device_id as DeviceId),
  };
}

function participantViewsFromRows(rows: readonly ParticipantDeviceRow[]): Map<string, ParticipantView> {
  const views = new Map<string, ParticipantView>();
  for (const row of rows) {
    const existing = views.get(row.participant_id);
    if (existing) {
      if (row.device_id !== null) {
        views.set(row.participant_id, {
          ...existing,
          deviceIds: [...existing.deviceIds, row.device_id as DeviceId],
        });
      }
      continue;
    }
    views.set(row.participant_id, {
      participantId: row.participant_id as ParticipantId,
      ownerId: row.owner_id as OwnerId,
      kind: row.kind,
      displayName: row.display_name,
      deviceIds: row.device_id === null ? [] : [row.device_id as DeviceId],
    });
  }
  return views;
}

function participantViews(db: DatabaseSync, participantIds: readonly string[]): Map<string, ParticipantView> {
  if (participantIds.length === 0) return new Map();
  const placeholders = participantIds.map(() => '?').join(', ');
  const rows = db.prepare(`
    SELECT p.participant_id, p.owner_id, p.kind, p.display_name, d.device_id
    FROM participants p
    LEFT JOIN devices d ON d.participant_id = p.participant_id
    WHERE p.participant_id IN (${placeholders})
    ORDER BY p.participant_id, d.device_id
  `).all(...participantIds) as unknown as ParticipantDeviceRow[];
  return participantViewsFromRows(rows);
}

export function decodeCanonical(bytes: Uint8Array, expectedDigest: string): MessageContent | null {
  if (digest(bytes) !== expectedDigest) return null;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const raw: unknown = JSON.parse(text);
    if (!Array.isArray(raw) || raw[0] !== MESSAGE_ENCODING_V1) return null;
    let content: MessageContent;
    if (raw.length === 3 && raw[1] === 'text' && typeof raw[2] === 'string') {
      content = { v: 1, kind: 'text', body: raw[2] };
    } else if (raw.length === 4 && raw[1] === 'agent_rename') {
      const target = decodeParticipantId(raw[2]);
      const name = validateAgentName(raw[3]);
      if (!target.ok || !name.ok || name.name !== raw[3]) return null;
      content = { v: 1, kind: 'agent_rename', agentParticipantId: target.value, body: name.name };
    } else if (raw.length === 5 && raw[1] === 'agent_name_snapshot') {
      const target = decodeParticipantId(raw[2]);
      const name = validateAgentName(raw[3]);
      const source = raw[4] === null ? null : decodeEventId(raw[4]);
      if (!target.ok || !name.ok || name.name !== raw[3] || source !== null && !source.ok) return null;
      content = { v: 1, kind: 'agent_name_snapshot', agentParticipantId: target.value, body: name.name, sourceEventId: source?.value ?? null };
    } else return null;
    return sameBytes(encodeMessageContent(content), bytes) ? content : null;
  } catch {
    return null;
  }
}

function storedEvent(
  db: DatabaseSync,
  row: EventRow,
  participants: Map<string, ParticipantView | null> = new Map(),
): StoredEvent | null {
  const content = decodeCanonical(row.canonical_payload, row.content_digest);
  if (!participants.has(row.author_participant_id)) {
    participants.set(row.author_participant_id, participantView(db, row.author_participant_id));
  }
  const participant = participants.get(row.author_participant_id) ?? null;
  if (!content || !participant) return null;
  return {
    sequence: row.sequence,
    eventId: row.event_id as EventId,
    channelId: row.channel_id as RoomId,
    authorParticipantId: row.author_participant_id as ParticipantId,
    authorDeviceId: row.author_device_id as DeviceId,
    clientTxnId: row.client_txn_id,
    content,
    canonicalPayload: new Uint8Array(row.canonical_payload),
    contentDigest: row.content_digest,
    receivedAt: row.received_at,
    participant,
  };
}

function storedEvents(db: DatabaseSync, rows: readonly EventRow[]): readonly StoredEvent[] | null {
  const participants = participantViews(db, [...new Set(rows.map(row => row.author_participant_id))]);
  const events = rows.map(row => storedEvent(db, row, participants));
  return events.every((event): event is StoredEvent => event !== null) ? events : null;
}

/** A model cannot assert its own causal root. Only a current binding's last
 * acknowledged, server-issued batch can carry provenance into a new send. */
function causeForAgentSend(
  db: DatabaseSync, channelId: string, participantId: string, deviceId: string,
  binding: SessionBinding | null,
): Readonly<{ rootId: string; depth: number; releaseIds: readonly string[] }> | null {
  if (!binding) return null;
  const latest = db.prepare(`SELECT max(ledger_revision) AS revision FROM agent_acknowledgements
    WHERE binding_id = ? AND generation = ? AND channel_id = ?`)
    .get(binding.bindingId, binding.generation, channelId) as { revision: number | null };
  if (latest.revision === null) return null;
  const causes = db.prepare(`SELECT e.causal_root_id AS root_id, e.causal_depth AS depth, a.release_id
    FROM agent_acknowledgements a JOIN events e ON e.event_id = a.event_id
    WHERE a.binding_id = ? AND a.generation = ? AND a.channel_id = ? AND a.ledger_revision = ?`)
    .all(binding.bindingId, binding.generation, channelId, latest.revision) as unknown as Array<{
      root_id: string | null; depth: number | null; release_id: string;
    }>;
  const rootId = causes[0]?.root_id;
  if (!rootId || causes.some(cause => cause.root_id !== rootId || cause.depth === null
    || !Number.isSafeInteger(cause.depth) || cause.depth < 0)) return null;
  return { rootId, depth: Math.max(...causes.map(cause => cause.depth!)) + 1,
    releaseIds: causes.map(cause => cause.release_id) };
}

function authenticatedAuthorBinding(
  db: DatabaseSync, channelId: string, participantId: string, deviceId: string,
  binding: SessionBinding | undefined,
): SessionBinding | null {
  if (!binding || binding.agentParticipantId !== participantId || binding.deviceId !== deviceId) return null;
  const held = db.prepare(`SELECT b.* FROM bindings b
    JOIN discovery_activations admission ON admission.binding_id = b.binding_id
      AND admission.generation = b.generation AND admission.channel_id = ?
    WHERE b.binding_id = ? AND b.generation = ? AND b.participant_id = ? AND b.device_id = ?
    AND b.generation = (SELECT max(generation) FROM bindings WHERE binding_id = b.binding_id)`)
    .get(channelId, binding.bindingId, binding.generation, participantId, deviceId) as BindingRow | undefined;
  return held?.status === 'active' && sameBinding(held, binding) ? binding : null;
}

function bindingFromRow(row: BindingRow): StoredBinding {
  return {
    v: 1,
    bindingId: row.binding_id as SessionBinding['bindingId'],
    ownerId: row.owner_id as SessionBinding['ownerId'],
    agentParticipantId: row.participant_id as SessionBinding['agentParticipantId'],
    deviceId: row.device_id as SessionBinding['deviceId'],
    harness: row.harness,
    sessionId: row.session_id,
    generation: row.generation,
    status: row.status,
  };
}

function sameBinding(row: BindingRow, binding: TrustedBinding): boolean {
  return sameSessionBinding(bindingFromRow(row), binding);
}

type ChannelLookup =
  | Readonly<{ kind: 'found'; channel: StoredChannel }>
  | Readonly<{ kind: 'missing' }>
  | Readonly<{ kind: 'not_joined' }>;

type ChannelSnapshotLookup =
  | Readonly<{ kind: 'found'; channel: StoredChannel }>
  | Readonly<{ kind: 'missing' }>
  | Readonly<{ kind: 'not_member' }>;

function channelSnapshotFor(db: DatabaseSync, channelId: string, participantId: string): ChannelSnapshotLookup {
  const row = db.prepare(`
    SELECT c.channel_id, c.title, c.revision, m.membership
    FROM channels c
    LEFT JOIN memberships m ON m.channel_id = c.channel_id AND m.participant_id = ?
    WHERE c.channel_id = ?
  `).get(participantId, channelId) as ChannelRow | undefined;
  if (!row) return { kind: 'missing' };
  if (row.membership === null) return { kind: 'not_member' };
  return {
    kind: 'found',
    channel: {
      channelId: row.channel_id as RoomId,
      title: row.title,
      membership: row.membership,
      revision: String(row.revision),
    },
  };
}

function channelFor(db: DatabaseSync, channelId: string, participantId: string): ChannelLookup {
  const snapshot = channelSnapshotFor(db, channelId, participantId);
  if (snapshot.kind === 'missing') return snapshot;
  if (snapshot.kind === 'not_member' || snapshot.channel.membership !== 'joined') return { kind: 'not_joined' };
  return snapshot;
}

/**
 * Who reads a channel's history. A joined member reads all of it; a bound agent reads only
 * what its admission shares. Every event-bearing read names its reader, so none can skip
 * the admission boundary by omission.
 */
export type HistoryReader =
  | Readonly<{ kind: 'member' }>
  | Readonly<{ kind: 'binding'; binding: Readonly<{ bindingId: string; generation: number }> }>;

/**
 * The admission boundary, and the one place it is decided: the last sequence of `channelId`
 * that `reader` may not see, or null when the reader may see none of the channel. A binding
 * sees what its admission recorded: from the channel head at activation when the owner shared
 * no history (`history: none`), or the whole channel when the owner shared it. A binding with
 * no admission record for the channel is denied, whatever cursor it presents.
 */
export function admissionStart(db: DatabaseSync, reader: HistoryReader, channelId: string): number | null {
  if (reader.kind === 'member') return 0;
  return (db.prepare(`
    SELECT start_sequence FROM discovery_activations WHERE binding_id = ? AND generation = ? AND channel_id = ?
  `).get(reader.binding.bindingId, reader.binding.generation, channelId) as { start_sequence: number } | undefined)?.start_sequence ?? null;
}

function allEvents(db: DatabaseSync, channelId: string): readonly StoredEvent[] | null {
  const rows = db.prepare('SELECT * FROM events WHERE channel_id = ? ORDER BY sequence').all(channelId) as unknown as EventRow[];
  return storedEvents(db, rows);
}

function eventAtSequence(db: DatabaseSync, channelId: string, sequence: number): StoredEvent | null {
  const row = db.prepare('SELECT * FROM events WHERE channel_id = ? AND sequence = ?')
    .get(channelId, sequence) as EventRow | undefined;
  return row ? storedEvent(db, row) : null;
}

function unavailable(): Readonly<{ kind: 'unavailable' }> {
  return { kind: 'unavailable' };
}

export interface ChannelStore {
  registerParticipant(participant: RegisteredParticipant): ParticipantRegistrationResult;
  registerDevice(input: Readonly<{ deviceId: DeviceId; participantId: ParticipantId }>): DeviceRegistrationResult;
  registerBinding(binding: TrustedBinding): BindingRegistrationResult;
  revokeBinding(key: Readonly<{ bindingId: string; generation: number }>): BindingRevocationResult;
  binding(binding: TrustedBinding): BindingReadResult;
  /** Newest registered generation for a binding ID, or null when none exists. */
  latestBindingGeneration(bindingId: string): LatestGenerationResult;
  /**
   * This binding ID's active row at its newest generation, only when it names exactly
   * this harness session; otherwise null. A revoked or superseded row never answers.
   */
  sessionBinding(key: Readonly<{ bindingId: string; harness: string; sessionId: string }>): SessionBindingResult;
  setMembership(input: Readonly<{ channelId: RoomId; participantId: ParticipantId; membership: ChannelMembership }>): MembershipResult;
  createChannel(input: Readonly<{
    operationId: string;
    channelId: RoomId;
    title: string | null;
    creatorOwnerId: OwnerId;
    creatorParticipantId: ParticipantId;
    creatorDeviceId: DeviceId;
    createdAt: string;
  }>): CreateChannelResult;
  findCreatedChannel(input: Readonly<{
    operationId: string;
    creatorOwnerId: OwnerId;
    creatorParticipantId: ParticipantId;
    creatorDeviceId: DeviceId;
  }>): CreatedChannelLookup;
  channel(input: Readonly<{ channelId: RoomId; participantId: ParticipantId }>): ChannelReadResult;
  listChannels(participantId: ParticipantId): ChannelListResult;
  roster(channelId: RoomId): RosterResult;
  /** Endpoint-only presentation projection. Call only after authenticating channel access. */
  nameProjection(channelId: RoomId): ReturnType<typeof projectNamesInOrder> | null;
  participantForDevice(input: Readonly<{ channelId: RoomId; deviceId: DeviceId }>): ProvenanceResult;
  send(input: Readonly<{
    channelId: RoomId;
    eventId: EventId;
    authorParticipantId: ParticipantId;
    authorDeviceId: DeviceId;
    clientTxnId: string;
    content: MessageContent;
    receivedAt: string;
    /** Authenticated transport's binding; never decoded from the message body. */
    sourceBinding?: SessionBinding;
  }>): SendResult;
  timeline(input: Readonly<{
    channelId: RoomId;
    participantId: ParticipantId;
    /** Whose view this is: a bound agent sees only what was said after its admission. */
    reader: HistoryReader;
    cursor: string | null;
    limit: number;
  }>): TimelineResult;
  readSubscription(input: Readonly<{
    channelId: RoomId;
    binding: TrustedBinding;
    cursor: string | null;
    limit: number;
  }>): SubscriptionReadResult;
  pendingHumanRelease(input: Readonly<{ channelId: RoomId; binding: TrustedBinding }>): PendingHumanReleaseResult;
  subscribeChannel(
    input: Readonly<{ channelId: RoomId; participantId: ParticipantId }>,
    listener: (update: ChannelUpdate) => void,
  ): () => void;
  subscribeHints(channelId: RoomId, listener: () => void): () => void;
}

export function createChannelStore(handle: InternalStoreHandle): ChannelStore {
  type ChannelListener = Readonly<{
    participantId: ParticipantId;
    listener: (update: ChannelUpdate) => void;
  }>;
  const channelListeners = new Map<string, Set<ChannelListener>>();
  const channelEventCaches = new Map<string, readonly StoredEvent[]>();
  const hintListeners = new Map<string, Set<() => void>>();
  const api: ChannelStore = {
    registerParticipant(participant) {
      if (![participant.participantId, participant.ownerId, participant.displayName].every(isIdentifier)
        || (participant.kind !== 'human' && participant.kind !== 'agent')) {
        return { kind: 'rejected', code: 'invalid_input' };
      }
      try {
        return handle.transaction(db => {
          const existing = db.prepare('SELECT * FROM participants WHERE participant_id = ?')
            .get(participant.participantId) as ParticipantRow | undefined;
          if (existing) {
            const same = existing.owner_id === participant.ownerId && existing.kind === participant.kind
              && existing.display_name === participant.displayName;
            return same ? { kind: 'done', changed: false } as const
              : { kind: 'rejected', code: 'identity_mismatch' } as const;
          }
          db.prepare(`
            INSERT INTO participants (participant_id, owner_id, kind, display_name) VALUES (?, ?, ?, ?)
          `).run(participant.participantId, participant.ownerId, participant.kind, participant.displayName);
          return { kind: 'done', changed: true } as const;
        });
      } catch { return unavailable(); }
    },

    registerDevice(input) {
      if (![input.deviceId, input.participantId].every(isIdentifier)) return { kind: 'rejected', code: 'invalid_input' };
      try {
        return handle.transaction(db => {
          const existing = db.prepare('SELECT participant_id FROM devices WHERE device_id = ?')
            .get(input.deviceId) as { participant_id: string } | undefined;
          if (existing) return existing.participant_id === input.participantId
            ? { kind: 'done', changed: false } as const
            : { kind: 'rejected', code: 'identity_mismatch' } as const;
          if (!db.prepare('SELECT 1 FROM participants WHERE participant_id = ?').get(input.participantId)) {
            return { kind: 'rejected', code: 'not_found' } as const;
          }
          db.prepare('INSERT INTO devices (device_id, participant_id) VALUES (?, ?)')
            .run(input.deviceId, input.participantId);
          return { kind: 'done', changed: true } as const;
        });
      } catch { return unavailable(); }
    },

    registerBinding(binding) {
      if (binding.v !== 1 || !isGeneration(binding.generation)
        || ![binding.bindingId, binding.ownerId, binding.agentParticipantId, binding.deviceId, binding.harness, binding.sessionId]
          .every(isIdentifier)) return { kind: 'rejected', code: 'invalid_input' };
      try {
        return handle.transaction(db => {
          const existing = db.prepare('SELECT * FROM bindings WHERE binding_id = ? AND generation = ?')
            .get(binding.bindingId, binding.generation) as BindingRow | undefined;
          if (existing) return sameBinding(existing, binding)
            ? { kind: 'done', changed: false } as const
            : { kind: 'rejected', code: 'identity_mismatch' } as const;
          const device = db.prepare('SELECT participant_id FROM devices WHERE device_id = ?')
            .get(binding.deviceId) as { participant_id: string } | undefined;
          const participant = db.prepare('SELECT owner_id, kind FROM participants WHERE participant_id = ?')
            .get(binding.agentParticipantId) as { owner_id: string; kind: string } | undefined;
          if (!device || !participant) return { kind: 'rejected', code: 'not_found' } as const;
          if (device.participant_id !== binding.agentParticipantId || participant.owner_id !== binding.ownerId
            || participant.kind !== 'agent') return { kind: 'rejected', code: 'identity_mismatch' } as const;
          db.prepare(`
            INSERT INTO bindings (
              binding_id, generation, owner_id, participant_id, device_id, harness, session_id, status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
          `).run(
            binding.bindingId, binding.generation, binding.ownerId, binding.agentParticipantId,
            binding.deviceId, binding.harness, binding.sessionId,
          );
          return { kind: 'done', changed: true } as const;
        });
      } catch { return unavailable(); }
    },

    revokeBinding(key) {
      if (!isIdentifier(key.bindingId) || !isGeneration(key.generation)) return { kind: 'rejected', code: 'invalid_input' };
      try {
        return handle.transaction(db => {
          const row = db.prepare('SELECT status FROM bindings WHERE binding_id = ? AND generation = ?')
            .get(key.bindingId, key.generation) as { status: string } | undefined;
          if (!row) return { kind: 'rejected', code: 'not_found' } as const;
          if (row.status === 'revoked') return { kind: 'done', changed: false } as const;
          db.prepare("UPDATE bindings SET status = 'revoked' WHERE binding_id = ? AND generation = ?")
            .run(key.bindingId, key.generation);
          return { kind: 'done', changed: true } as const;
        });
      } catch { return unavailable(); }
    },

    binding(binding) {
      try {
        return handle.read(db => {
          const row = db.prepare('SELECT * FROM bindings WHERE binding_id = ? AND generation = ?')
            .get(binding.bindingId, binding.generation) as BindingRow | undefined;
          if (!row) return { kind: 'absent' } as const;
          return sameBinding(row, binding)
            ? { kind: 'done', binding: bindingFromRow(row) } as const
            : { kind: 'rejected', code: 'binding_mismatch' } as const;
        });
      } catch { return unavailable(); }
    },

    sessionBinding(key) {
      if (![key.bindingId, key.harness, key.sessionId].every(isIdentifier)) return { kind: 'done', binding: null };
      try {
        return handle.read(db => {
          const row = db.prepare(`
            SELECT b.* FROM bindings b
            WHERE b.binding_id = ? AND b.harness = ? AND b.session_id = ? AND b.status = 'active'
              AND b.generation = (SELECT max(generation) FROM bindings WHERE binding_id = b.binding_id)
          `).get(key.bindingId, key.harness, key.sessionId) as BindingRow | undefined;
          return { kind: 'done', binding: row ? bindingFromRow(row) : null } as const;
        });
      } catch { return unavailable(); }
    },

    latestBindingGeneration(bindingId) {
      try {
        return handle.read(db => {
          const row = db.prepare('SELECT max(generation) AS generation FROM bindings WHERE binding_id = ?')
            .get(bindingId) as { generation: number | null } | undefined;
          return { kind: 'done', generation: row?.generation ?? null } as const;
        });
      } catch { return unavailable(); }
    },

    setMembership(input) {
      if (![input.channelId, input.participantId].every(isIdentifier)
        || !['joining', 'joined', 'left', 'revoked'].includes(input.membership)) {
        return { kind: 'rejected', code: 'invalid_input' };
      }
      try {
        const result = handle.transaction(db => {
          if (!db.prepare('SELECT 1 FROM channels WHERE channel_id = ?').get(input.channelId)
            || !db.prepare('SELECT 1 FROM participants WHERE participant_id = ?').get(input.participantId)) {
            return { kind: 'rejected', code: 'not_found' } as const;
          }
          const row = db.prepare('SELECT membership FROM memberships WHERE channel_id = ? AND participant_id = ?')
            .get(input.channelId, input.participantId) as { membership: string } | undefined;
          if (row?.membership === input.membership) return { kind: 'done', changed: false } as const;
          if ((input.membership === 'joining' || input.membership === 'joined') && isChannelLinked(db, input.channelId)) {
            return { kind: 'rejected', code: 'read_only' } as const;
          }
          db.prepare(`
            INSERT INTO memberships (channel_id, participant_id, membership) VALUES (?, ?, ?)
            ON CONFLICT (channel_id, participant_id) DO UPDATE SET membership = excluded.membership
          `).run(input.channelId, input.participantId, input.membership);
          db.prepare('UPDATE channels SET revision = revision + 1 WHERE channel_id = ?').run(input.channelId);
          return { kind: 'done', changed: true } as const;
        });
        if (result.kind === 'done' && result.changed) handle.publish({ kind: 'channel', channelId: input.channelId });
        return result;
      } catch { return unavailable(); }
    },

    createChannel(input) {
      if (![input.operationId, input.channelId, input.creatorOwnerId, input.creatorParticipantId, input.creatorDeviceId]
        .every(isIdentifier)
        || !isTimestamp(input.createdAt) || (input.title !== null && typeof input.title !== 'string')) {
        return { kind: 'rejected', code: 'invalid_input' };
      }
      const fingerprint = JSON.stringify([
        'khala.channel.create.v1', input.creatorOwnerId, input.creatorParticipantId, input.creatorDeviceId, input.title,
      ]);
      try {
        const result = handle.transaction(db => {
          const operation = db.prepare('SELECT fingerprint, channel_id FROM channel_operations WHERE operation_id = ?')
            .get(input.operationId) as { fingerprint: string; channel_id: string } | undefined;
          if (operation) {
            if (operation.fingerprint !== fingerprint) return { kind: 'rejected', code: 'operation_mismatch' } as const;
            const replayed = channelSnapshotFor(db, operation.channel_id, input.creatorParticipantId);
            return replayed.kind === 'found'
              ? { kind: 'replayed', channel: replayed.channel } as const
              : { kind: 'unavailable' } as const;
          }
          if (db.prepare('SELECT 1 FROM channels WHERE channel_id = ?').get(input.channelId)) {
            return { kind: 'rejected', code: 'operation_mismatch' } as const;
          }
          const device = db.prepare('SELECT participant_id FROM devices WHERE device_id = ?')
            .get(input.creatorDeviceId) as { participant_id: string } | undefined;
          const participant = db.prepare('SELECT owner_id FROM participants WHERE participant_id = ?')
            .get(input.creatorParticipantId) as { owner_id: string } | undefined;
          if (device?.participant_id !== input.creatorParticipantId || participant?.owner_id !== input.creatorOwnerId) {
            return { kind: 'rejected', code: 'identity_mismatch' } as const;
          }
          db.prepare(`
            INSERT INTO channels (
              channel_id, title, creator_participant_id, creator_device_id, revision, created_at
            ) VALUES (?, ?, ?, ?, 0, ?)
          `).run(input.channelId, input.title, input.creatorParticipantId, input.creatorDeviceId, input.createdAt);
          db.prepare("INSERT INTO memberships (channel_id, participant_id, membership) VALUES (?, ?, 'joined')")
            .run(input.channelId, input.creatorParticipantId);
          db.prepare('INSERT INTO channel_operations (operation_id, fingerprint, channel_id) VALUES (?, ?, ?)')
            .run(input.operationId, fingerprint, input.channelId);
          const created = channelFor(db, input.channelId, input.creatorParticipantId);
          return created.kind === 'found'
            ? { kind: 'created', channel: created.channel } as const
            : { kind: 'unavailable' } as const;
        });
        if (result.kind === 'created') handle.publish({ kind: 'channel', channelId: input.channelId });
        return result;
      } catch { return unavailable(); }
    },

    findCreatedChannel(input) {
      if (![input.operationId, input.creatorOwnerId, input.creatorParticipantId, input.creatorDeviceId]
        .every(isIdentifier)) return { kind: 'rejected', code: 'invalid_input' };
      try {
        return handle.read(db => {
          const row = db.prepare(`
            SELECT o.channel_id, c.creator_participant_id, c.creator_device_id, p.owner_id
            FROM channel_operations o
            JOIN channels c ON c.channel_id = o.channel_id
            JOIN participants p ON p.participant_id = c.creator_participant_id
            WHERE o.operation_id = ?
          `).get(input.operationId) as {
            channel_id: string;
            creator_participant_id: string;
            creator_device_id: string;
            owner_id: string;
          } | undefined;
          if (!row) return { kind: 'absent' } as const;
          if (row.owner_id !== input.creatorOwnerId || row.creator_participant_id !== input.creatorParticipantId
            || row.creator_device_id !== input.creatorDeviceId) {
            return { kind: 'rejected', code: 'operation_mismatch' } as const;
          }
          const channel = channelSnapshotFor(db, row.channel_id, input.creatorParticipantId);
          return channel.kind === 'found'
            ? { kind: 'found', channel: channel.channel } as const
            : { kind: 'unavailable' } as const;
        });
      } catch { return unavailable(); }
    },

    channel(input) {
      if (![input.channelId, input.participantId].every(isIdentifier)) return { kind: 'rejected', code: 'invalid_input' };
      try {
        return handle.read(db => {
          const channel = channelFor(db, input.channelId, input.participantId);
          if (channel.kind === 'missing') return { kind: 'rejected', code: 'not_found' } as const;
          if (channel.kind === 'not_joined') return { kind: 'rejected', code: 'not_joined' } as const;
          return { kind: 'done', channel: channel.channel } as const;
        });
      } catch { return unavailable(); }
    },

    listChannels(participantId) {
      if (!isIdentifier(participantId)) return unavailable();
      try {
        return handle.read(db => {
          const rows = db.prepare(`
            SELECT c.channel_id, c.title, c.revision, m.membership
            FROM channels c JOIN memberships m ON m.channel_id = c.channel_id
            WHERE m.participant_id = ? AND m.membership = 'joined'
            ORDER BY c.created_at DESC, c.channel_id
          `).all(participantId) as unknown as ChannelRow[];
          return { kind: 'done', channels: rows.map(row => ({
            channelId: row.channel_id as RoomId, title: row.title,
            membership: 'joined' as const, revision: String(row.revision),
          })) } as const;
        });
      } catch { return unavailable(); }
    },

    roster(channelId) {
      try {
        return handle.read(db => {
          if (!db.prepare('SELECT 1 FROM channels WHERE channel_id = ?').get(channelId)) {
            return { kind: 'rejected', code: 'not_found' } as const;
          }
          const rows = db.prepare(`
            SELECT p.participant_id, p.owner_id, p.kind, p.display_name, d.device_id
            FROM memberships m
            JOIN participants p ON p.participant_id = m.participant_id
            LEFT JOIN devices d ON d.participant_id = p.participant_id
            WHERE m.channel_id = ?
            ORDER BY p.participant_id, d.device_id
          `).all(channelId) as unknown as ParticipantDeviceRow[];
          return { kind: 'done', participants: [...participantViewsFromRows(rows).values()] } as const;
        });
      } catch { return unavailable(); }
    },

    nameProjection(channelId) {
      try {
        return handle.read(db => {
          const rows = db.prepare('SELECT * FROM events WHERE channel_id = ? ORDER BY sequence').all(channelId) as unknown as EventRow[];
          const events = storedEvents(db, rows);
          const roster = api.roster(channelId);
          if (!events || roster.kind !== 'done') return null;
          return projectNamesInOrder(roster.participants.map(participant => ({ ...participant, initialName: participant.displayName })),
            events.map((event): NameTimelineEvent => event.content.kind === 'text'
              ? { kind: 'message', eventId: event.eventId, authorParticipantId: event.authorParticipantId }
              : { kind: event.content.kind, eventId: event.eventId, actorParticipantId: event.authorParticipantId,
                  targetParticipantId: event.content.agentParticipantId, name: event.content.body,
                  sourceEventId: event.content.kind === 'agent_name_snapshot' ? event.content.sourceEventId : null }));
        });
      } catch { return null; }
    },

    participantForDevice(input) {
      if (![input.channelId, input.deviceId].every(isIdentifier)) return unavailable();
      try {
        return handle.read(db => {
          const row = db.prepare(`
            SELECT d.participant_id
            FROM devices d
            JOIN memberships m ON m.participant_id = d.participant_id
            WHERE d.device_id = ? AND m.channel_id = ?
          `).get(input.deviceId, input.channelId) as { participant_id: string } | undefined;
          return {
            kind: 'done',
            participantId: row ? row.participant_id as ParticipantId : null,
          } as const;
        });
      } catch { return unavailable(); }
    },

    send(input) {
      if (![input.channelId, input.eventId, input.authorParticipantId, input.authorDeviceId, input.clientTxnId]
        .every(isIdentifier) || !isTimestamp(input.receivedAt)) return { kind: 'rejected', code: 'invalid_input' };
      let canonicalPayload: Uint8Array;
      try { canonicalPayload = encodeMessageContent(input.content); } catch {
        return { kind: 'rejected', code: 'invalid_input' };
      }
      const contentDigest = digest(canonicalPayload);
      try {
        const result = handle.transaction(db => {
          const duplicate = db.prepare('SELECT * FROM events WHERE author_device_id = ? AND client_txn_id = ?')
            .get(input.authorDeviceId, input.clientTxnId) as EventRow | undefined;
          if (duplicate) {
            const exact = duplicate.channel_id === input.channelId
              && duplicate.author_participant_id === input.authorParticipantId
              && duplicate.content_digest === contentDigest
              && sameBytes(duplicate.canonical_payload, canonicalPayload);
            if (!exact) return { kind: 'rejected', code: 'operation_mismatch' } as const;
            const event = storedEvent(db, duplicate);
            return event ? { kind: 'replayed', event } as const : { kind: 'unavailable' } as const;
          }
          if (db.prepare('SELECT 1 FROM events WHERE event_id = ?').get(input.eventId)) {
            return { kind: 'rejected', code: 'operation_mismatch' } as const;
          }
          const channel = channelFor(db, input.channelId, input.authorParticipantId);
          if (channel.kind === 'missing') return { kind: 'rejected', code: 'not_found' } as const;
          if (channel.kind === 'not_joined') return { kind: 'rejected', code: 'not_joined' } as const;
          const device = db.prepare('SELECT participant_id FROM devices WHERE device_id = ?')
            .get(input.authorDeviceId) as { participant_id: string } | undefined;
          if (device?.participant_id !== input.authorParticipantId) {
            return { kind: 'rejected', code: 'identity_mismatch' } as const;
          }
          if (!isChannelWritable(db, input.channelId)) return { kind: 'rejected', code: 'read_only' } as const;
          const author = db.prepare('SELECT kind FROM participants WHERE participant_id = ?')
            .get(input.authorParticipantId) as { kind: 'human' | 'agent' } | undefined;
          if (!author) return { kind: 'unavailable' } as const;
          const authorBinding = author.kind === 'agent'
            ? authenticatedAuthorBinding(db, input.channelId, input.authorParticipantId,
              input.authorDeviceId, input.sourceBinding) : null;
          const cause = author.kind === 'human'
            ? { rootId: input.eventId, depth: 0 }
            : causeForAgentSend(db, input.channelId, input.authorParticipantId, input.authorDeviceId, authorBinding);
          const inserted = db.prepare(`
            INSERT INTO events (
              event_id, channel_id, author_participant_id, author_device_id, client_txn_id,
              canonical_payload, content_digest, received_at, causal_root_id, causal_depth,
              author_binding_id, author_binding_generation
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            input.eventId, input.channelId, input.authorParticipantId, input.authorDeviceId,
            input.clientTxnId, canonicalPayload, contentDigest, input.receivedAt,
            cause?.rootId ?? null, cause?.depth ?? null,
            authorBinding?.bindingId ?? null, authorBinding?.generation ?? null,
          );
          if (input.content.kind === 'text') db.prepare(`INSERT INTO automation_arrivals (event_id, binding_id, generation, mode_version)
            SELECT ?, b.binding_id, b.generation, m.version FROM bindings b
            JOIN memberships member ON member.participant_id = b.participant_id AND member.channel_id = ?
            JOIN discovery_activations admission ON admission.binding_id = b.binding_id
              AND admission.generation = b.generation AND admission.channel_id = member.channel_id
            JOIN mode_controls m ON m.binding_id = b.binding_id AND m.generation = b.generation
            WHERE b.status = 'active' AND member.membership = 'joined' AND b.participant_id <> ?
            AND b.generation = (SELECT max(newer.generation) FROM bindings newer WHERE newer.binding_id = b.binding_id)`)
            .run(input.eventId, input.channelId, input.authorParticipantId);
          // An authenticated response to the exact acknowledged batch is a terminal
          // observation for those peer jobs. ACK alone never frees the active slot.
          if (author.kind === 'agent' && cause && 'releaseIds' in cause && input.sourceBinding) {
            const finish = db.prepare(`UPDATE automation_releases SET state = 'finished'
              WHERE release_id = ? AND binding_id = ? AND generation = ? AND root_id = ? AND state = 'reserved'`);
            for (const releaseId of cause.releaseIds) finish.run(releaseId,
              input.sourceBinding.bindingId, input.sourceBinding.generation, cause.rootId);
          }
          db.prepare('UPDATE channels SET revision = revision + 1 WHERE channel_id = ?').run(input.channelId);
          const row = db.prepare('SELECT * FROM events WHERE sequence = ?').get(inserted.lastInsertRowid) as EventRow;
          const event = storedEvent(db, row);
          return event ? { kind: 'stored', event } as const : { kind: 'unavailable' } as const;
        });
        if (result.kind === 'stored') {
          handle.publish({ kind: 'channel', channelId: input.channelId, eventSequence: result.event.sequence });
          handle.publish({ kind: 'subscription', channelId: input.channelId });
        }
        return result;
      } catch { return unavailable(); }
    },

    timeline(input) {
      if (!isLimit(input.limit)) return { kind: 'rejected', code: 'invalid_input' };
      try {
        return handle.read(db => {
          const channel = channelFor(db, input.channelId, input.participantId);
          if (channel.kind === 'missing') return { kind: 'rejected', code: 'not_found' } as const;
          if (channel.kind === 'not_joined') return { kind: 'rejected', code: 'not_joined' } as const;
          const currentRevision = Number(channel.channel.revision);
          const maximum = (db.prepare('SELECT coalesce(max(sequence), 0) AS value FROM events WHERE channel_id = ?')
            .get(input.channelId) as { value: number }).value;
          const cursor = input.cursor === null
            ? { channelId: input.channelId, snapshotHighWater: maximum, snapshotRevision: currentRevision, beforeSequence: maximum + 1 }
            : decodeTimelineCursor(input.cursor);
          if (!cursor || cursor.channelId !== input.channelId || cursor.snapshotHighWater > maximum
            || cursor.snapshotRevision > currentRevision || cursor.beforeSequence > cursor.snapshotHighWater + 1) {
            return { kind: 'rejected', code: 'invalid_cursor' } as const;
          }
          const start = admissionStart(db, input.reader, input.channelId);
          if (start === null) return { kind: 'rejected', code: 'not_joined' } as const;
          const rows = db.prepare(`
            SELECT * FROM events
            WHERE channel_id = ? AND sequence <= ? AND sequence < ? AND sequence > ?
            ORDER BY sequence DESC LIMIT ?
          `).all(input.channelId, cursor.snapshotHighWater, cursor.beforeSequence, start, input.limit + 1) as unknown as EventRow[];
          const selected = rows.slice(0, input.limit);
          const decoded = storedEvents(db, selected);
          if (!decoded) return { kind: 'unavailable' } as const;
          const events = [...decoded].reverse();
          const nextCursor = rows.length > input.limit && selected.length > 0
            ? encodeTimelineCursor({ ...cursor, beforeSequence: selected[selected.length - 1]!.sequence })
            : null;
          return { kind: 'done', events, nextCursor, revision: String(cursor.snapshotRevision) } as const;
        });
      } catch { return unavailable(); }
    },

    readSubscription(input) {
      if (!isLimit(input.limit)) return { kind: 'rejected', code: 'invalid_input' };
      try {
        return handle.read(db => {
          const row = db.prepare('SELECT * FROM bindings WHERE binding_id = ? AND generation = ?')
            .get(input.binding.bindingId, input.binding.generation) as BindingRow | undefined;
          if (!row) {
            const anyGeneration = db.prepare('SELECT 1 FROM bindings WHERE binding_id = ?').get(input.binding.bindingId);
            return { kind: 'rejected', code: anyGeneration ? 'stale_binding' : 'binding_mismatch' } as const;
          }
          if (!sameBinding(row, input.binding)) return { kind: 'rejected', code: 'binding_mismatch' } as const;
          if (row.status === 'revoked') return { kind: 'rejected', code: 'binding_revoked' } as const;
          const channel = channelFor(db, input.channelId, row.participant_id);
          if (channel.kind !== 'found') {
            return { kind: 'rejected', code: 'not_joined' } as const;
          }
          const maximum = (db.prepare('SELECT coalesce(max(sequence), 0) AS value FROM events WHERE channel_id = ?')
            .get(input.channelId) as { value: number }).value;
          const start = admissionStart(db, { kind: 'binding', binding: input.binding }, input.channelId);
          if (start === null) return { kind: 'rejected', code: 'not_joined' } as const;
          const cursor = input.cursor === null
            ? { channelId: input.channelId, bindingId: row.binding_id, generation: row.generation, lastCoveredSequence: start }
            : decodeSubscriptionCursor(input.cursor);
          if (!cursor || cursor.channelId !== input.channelId || cursor.bindingId !== row.binding_id
            || cursor.generation !== row.generation || cursor.lastCoveredSequence > maximum) {
            return { kind: 'rejected', code: 'invalid_cursor' } as const;
          }
          const after = Math.max(cursor.lastCoveredSequence, start);
          const rows = db.prepare(`
            SELECT * FROM events WHERE channel_id = ? AND sequence > ? ORDER BY sequence LIMIT ?
          `).all(input.channelId, after, input.limit + 1) as unknown as EventRow[];
          const covered = rows.slice(0, input.limit);
          const eligible = covered.filter(event => event.author_participant_id !== row.participant_id);
          const events = storedEvents(db, eligible);
          if (!events) return { kind: 'unavailable' } as const;
          const lastCoveredSequence = covered.at(-1)?.sequence ?? after;
          return {
            kind: 'page',
            events,
            nextCursor: encodeSubscriptionCursor({ ...cursor, lastCoveredSequence }),
            caughtUp: rows.length <= input.limit,
          } as const;
        });
      } catch { return unavailable(); }
    },

    pendingHumanRelease(input) {
      try {
        return handle.read(db => {
          const row = db.prepare('SELECT * FROM bindings WHERE binding_id = ? AND generation = ?')
            .get(input.binding.bindingId, input.binding.generation) as BindingRow | undefined;
          if (!row || !sameBinding(row, input.binding) || row.status !== 'active') return { kind: 'unavailable' } as const;
          if (channelFor(db, input.channelId, row.participant_id).kind !== 'found') return { kind: 'unavailable' } as const;
          const start = admissionStart(db, { kind: 'binding', binding: input.binding }, input.channelId);
          if (start === null) return { kind: 'unavailable' } as const;
          const pending = db.prepare(`
            SELECT 1 FROM events e
            JOIN participants p ON p.participant_id = e.author_participant_id
            WHERE e.channel_id = ? AND e.sequence > ? AND e.author_participant_id <> ? AND p.kind = 'human'
              AND NOT EXISTS (
                SELECT 1 FROM agent_acknowledgements a
                WHERE a.binding_id = ? AND a.generation = ? AND a.channel_id = e.channel_id AND a.event_id = e.event_id
              )
            LIMIT 1
          `).get(input.channelId, start, row.participant_id, row.binding_id, row.generation);
          return { kind: 'pending', pending: pending !== undefined } as const;
        });
      } catch { return { kind: 'unavailable' }; }
    },

    subscribeChannel(input, listener) {
      const entry: ChannelListener = { participantId: input.participantId, listener };
      let listeners = channelListeners.get(input.channelId);
      if (!listeners) {
        listeners = new Set<ChannelListener>();
        try {
          const events = handle.read(db => allEvents(db, input.channelId));
          if (events) channelEventCaches.set(input.channelId, events);
        } catch { /* A failed snapshot leaves this observer fail-closed. */ }
      }
      listeners.add(entry);
      channelListeners.set(input.channelId, listeners);
      return () => {
        listeners.delete(entry);
        if (listeners.size === 0) {
          channelListeners.delete(input.channelId);
          channelEventCaches.delete(input.channelId);
        }
      };
    },

    subscribeHints(channelId, listener) {
      const listeners = hintListeners.get(channelId) ?? new Set<() => void>();
      listeners.add(listener);
      hintListeners.set(channelId, listeners);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) hintListeners.delete(channelId);
      };
    },
  };
  handle.subscribe(notification => {
    if (notification.kind === 'subscription') {
      for (const listener of hintListeners.get(notification.channelId) ?? []) {
        try { listener(); } catch { /* Isolate listener failures from later listeners. */ }
      }
      return;
    }
    const listeners = channelListeners.get(notification.channelId);
    if (!listeners || listeners.size === 0) return;
    const cachedEvents = channelEventCaches.get(notification.channelId);
    if (!cachedEvents) return;
    let refreshed: Readonly<{
      events: readonly StoredEvent[];
      updates: Map<string, ChannelUpdate>;
    }> | null = null;
    try {
      refreshed = handle.read(db => {
        let events = cachedEvents;
        if (notification.eventSequence !== undefined
          && events.at(-1)?.sequence !== notification.eventSequence) {
          const event = eventAtSequence(db, notification.channelId, notification.eventSequence);
          if (!event || (events.at(-1)?.sequence ?? 0) > event.sequence) return null;
          events = [...events, event];
        }
        const updates = new Map<string, ChannelUpdate>();
        for (const participantId of new Set([...listeners].map(entry => entry.participantId))) {
          const lookup = channelSnapshotFor(db, notification.channelId, participantId);
          if (lookup.kind === 'found') updates.set(participantId, { channel: lookup.channel, events });
        }
        return { events, updates };
      });
    } catch { return; }
    if (!refreshed) return;
    channelEventCaches.set(notification.channelId, refreshed.events);
    for (const entry of listeners) {
      const update = refreshed.updates.get(entry.participantId);
      if (!update) continue;
      try { entry.listener(update); } catch { /* Isolate listener failures from later listeners. */ }
    }
  });
  return api;
}
