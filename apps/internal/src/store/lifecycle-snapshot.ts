import type { DatabaseSync } from 'node:sqlite';
import type { ChannelMembership } from '@khala/contracts/messaging/index';
import { decodeCanonical } from './channel-store';
import type { InternalStoreHandle } from './open';

// Lifecycle reads are authority-neutral projections of one owned store. They name
// every exported column explicitly, so bindings, sessions, mode state, operation
// fingerprints and launch material can never leak through a `SELECT *`.

/** Immutable `meta` key tying one store directory to one logical channel. */
export const LIFECYCLE_CHANNEL_META_KEY = 'lifecycle.channel_id';

export type LifecycleIdentity = 'match' | 'mismatch';

export type ResumeMetadataV1 = Readonly<{
  v: 1;
  channelId: string;
  title: string | null;
  createdAt: string;
  creatorParticipantId: string;
  creatorDeviceId: string;
  revision: number;
  participantCount: number;
  eventCount: number;
  latestSequence: number | null;
}>;

export type ArchiveParticipant = Readonly<{
  participantId: string;
  kind: 'human' | 'agent';
  displayName: string;
  membership: ChannelMembership | null;
  deviceIds: readonly string[];
}>;

export type ArchiveEvent = Readonly<{
  sequence: number;
  eventId: string;
  authorParticipantId: string;
  authorDeviceId: string;
  receivedAt: string;
  body: string;
}>;

export type ArchiveSnapshot = Readonly<{
  metadata: ResumeMetadataV1;
  participants: readonly ArchiveParticipant[];
  events: readonly ArchiveEvent[];
}>;

export type LifecycleReadResult<T> =
  | Readonly<{ kind: 'found'; value: T }>
  | Readonly<{ kind: 'identity_mismatch' }>
  | Readonly<{ kind: 'corrupt' }>;

export type LifecycleBindResult =
  | Readonly<{ kind: 'bound'; changed: boolean }>
  | Readonly<{ kind: 'identity_mismatch' }>;

/**
 * A bound store is identified by its bound launch channel, which must still exist;
 * channels later created in the same store (an owner-confirmed create request) do
 * not change that identity. An unbound legacy store must hold exactly this one channel.
 */
function identityOf(db: DatabaseSync, channelId: string): LifecycleIdentity {
  const bound = db.prepare('SELECT value FROM meta WHERE key = ?')
    .get(LIFECYCLE_CHANNEL_META_KEY) as { value: string } | undefined;
  if (bound !== undefined) {
    return bound.value === channelId && db.prepare('SELECT 1 FROM channels WHERE channel_id = ?').get(channelId)
      ? 'match'
      : 'mismatch';
  }
  const channels = db.prepare('SELECT channel_id FROM channels ORDER BY channel_id LIMIT 2')
    .all() as unknown as Array<{ channel_id: string }>;
  return channels.length === 1 && channels[0]?.channel_id === channelId ? 'match' : 'mismatch';
}

/** Binds a freshly created or legacy single-channel store to its logical channel ID. */
export function bindLifecycleChannel(handle: InternalStoreHandle, channelId: string): LifecycleBindResult {
  return handle.transaction(db => {
    if (identityOf(db, channelId) === 'mismatch') return { kind: 'identity_mismatch' } as const;
    const changed = db.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)')
      .run(LIFECYCLE_CHANNEL_META_KEY, channelId).changes > 0;
    return { kind: 'bound', changed } as const;
  });
}

type ChannelMetaRow = Readonly<{
  channel_id: string;
  title: string | null;
  created_at: string;
  creator_participant_id: string;
  creator_device_id: string;
  revision: number;
  participant_count: number;
  event_count: number;
  latest_sequence: number | null;
}>;

function metadataOf(db: DatabaseSync, channelId: string): ResumeMetadataV1 | null {
  const row = db.prepare(`
    SELECT c.channel_id, c.title, c.created_at, c.creator_participant_id, c.creator_device_id, c.revision,
      (SELECT COUNT(*) FROM memberships m WHERE m.channel_id = c.channel_id) AS participant_count,
      (SELECT COUNT(*) FROM events e WHERE e.channel_id = c.channel_id) AS event_count,
      (SELECT MAX(sequence) FROM events e WHERE e.channel_id = c.channel_id) AS latest_sequence
    FROM channels c WHERE c.channel_id = ?
  `).get(channelId) as ChannelMetaRow | undefined;
  if (!row) return null;
  return {
    v: 1,
    channelId: row.channel_id,
    title: row.title,
    createdAt: row.created_at,
    creatorParticipantId: row.creator_participant_id,
    creatorDeviceId: row.creator_device_id,
    revision: Number(row.revision),
    participantCount: Number(row.participant_count),
    eventCount: Number(row.event_count),
    latestSequence: row.latest_sequence === null ? null : Number(row.latest_sequence),
  };
}

function checked<T>(
  handle: InternalStoreHandle,
  channelId: string,
  project: (db: DatabaseSync, metadata: ResumeMetadataV1) => T | null,
): LifecycleReadResult<T> {
  return handle.read(db => {
    if (identityOf(db, channelId) === 'mismatch') return { kind: 'identity_mismatch' } as const;
    const metadata = metadataOf(db, channelId);
    const value = metadata === null ? null : project(db, metadata);
    return value === null ? { kind: 'corrupt' } as const : { kind: 'found', value } as const;
  });
}

export function readResumeMetadata(
  handle: InternalStoreHandle,
  channelId: string,
): LifecycleReadResult<ResumeMetadataV1> {
  return checked(handle, channelId, (_db, metadata) => metadata);
}

type ParticipantRow = Readonly<{
  participant_id: string;
  kind: 'human' | 'agent';
  display_name: string;
  membership: ChannelMembership | null;
  device_id: string | null;
}>;

type EventRow = Readonly<{
  sequence: number;
  event_id: string;
  author_participant_id: string;
  author_device_id: string;
  received_at: string;
  canonical_payload: Uint8Array;
  content_digest: string;
}>;

function participantsOf(db: DatabaseSync, channelId: string): readonly ArchiveParticipant[] {
  // Members plus any historical authors, each with every registered device.
  const rows = db.prepare(`
    SELECT p.participant_id, p.kind, p.display_name, m.membership, d.device_id
    FROM participants p
    LEFT JOIN memberships m ON m.participant_id = p.participant_id AND m.channel_id = ?
    LEFT JOIN devices d ON d.participant_id = p.participant_id
    WHERE m.channel_id IS NOT NULL
      OR p.participant_id IN (SELECT author_participant_id FROM events WHERE channel_id = ?)
    ORDER BY p.participant_id, d.device_id
  `).all(channelId, channelId) as unknown as ParticipantRow[];
  const participants: ArchiveParticipant[] = [];
  for (const row of rows) {
    const last = participants.at(-1);
    if (last?.participantId === row.participant_id) {
      if (row.device_id !== null) participants[participants.length - 1] = { ...last, deviceIds: [...last.deviceIds, row.device_id] };
      continue;
    }
    participants.push({
      participantId: row.participant_id,
      kind: row.kind,
      displayName: row.display_name,
      membership: row.membership,
      deviceIds: row.device_id === null ? [] : [row.device_id],
    });
  }
  return participants;
}

function eventsOf(db: DatabaseSync, channelId: string): readonly ArchiveEvent[] | null {
  const rows = db.prepare(`
    SELECT sequence, event_id, author_participant_id, author_device_id, received_at, canonical_payload, content_digest
    FROM events WHERE channel_id = ? ORDER BY sequence
  `).all(channelId) as unknown as EventRow[];
  const events: ArchiveEvent[] = [];
  for (const row of rows) {
    const content = decodeCanonical(row.canonical_payload, row.content_digest);
    if (content === null) return null;
    events.push({
      sequence: Number(row.sequence),
      eventId: row.event_id,
      authorParticipantId: row.author_participant_id,
      authorDeviceId: row.author_device_id,
      receivedAt: row.received_at,
      body: content.body,
    });
  }
  return events;
}

/** Materializes the complete archive inside one synchronous owned read. */
export function readArchiveSnapshot(
  handle: InternalStoreHandle,
  channelId: string,
): LifecycleReadResult<ArchiveSnapshot> {
  return checked(handle, channelId, (db, metadata) => {
    const events = eventsOf(db, channelId);
    return events === null ? null : { metadata, participants: participantsOf(db, channelId), events };
  });
}

export type CreatedChannelRemoval =
  | Readonly<{ kind: 'removed' }>
  /** This store does not hold the channel, or holds it as its launch channel. */
  | Readonly<{ kind: 'absent' }>;

/**
 * Removes one channel that an owner-confirmed create added to a launch store, and
 * nothing else: its events, memberships, discovery settings and create record go,
 * and any binding activated for it is revoked. The launch channel and every other
 * channel in the store keep all of their rows.
 */
export function removeCreatedChannel(handle: InternalStoreHandle, channelId: string): CreatedChannelRemoval {
  return handle.transaction(db => {
    const bound = db.prepare('SELECT value FROM meta WHERE key = ?')
      .get(LIFECYCLE_CHANNEL_META_KEY) as { value: string } | undefined;
    if (bound === undefined || bound.value === channelId
      || !db.prepare('SELECT 1 FROM channels WHERE channel_id = ?').get(channelId)) return { kind: 'absent' } as const;
    db.prepare(`
      UPDATE bindings SET status = 'revoked'
      WHERE (binding_id, generation) IN (SELECT binding_id, generation FROM discovery_activations WHERE channel_id = ?)
    `).run(channelId);
    for (const table of [
      'discovery_activations', 'discovery_allowlist', 'discovery_visibility', 'channel_operations',
      'receipt_fact_events', 'events', 'memberships', 'channels',
    ]) {
      db.prepare(`DELETE FROM ${table} WHERE channel_id = ?`).run(channelId);
    }
    return { kind: 'removed' } as const;
  });
}
