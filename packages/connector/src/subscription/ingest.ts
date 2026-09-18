// Deterministic ingestion of one source page into the owner's durable pending
// store. Every event is durably handled, in order, before the caller may commit
// the page cursor; the first event that cannot be handled stops the page.
// Ingestion produces pending review state only, never a model notification.

import { createHash } from 'node:crypto';
import type { EventRef, SessionBinding } from '@khala/contracts/delivery/index';
import type {
  CallOptions, DeviceId, ParticipantId, RoomId, UnavailableEventRef, UnavailableReason,
} from '@khala/contracts/messaging/index';
import type { SourceEvent } from './adapter';

export type AcceptResult = 'stored' | 'duplicate' | 'blocked';

/**
 * Durable pending store (KHA-115). `duplicate` means the same event identity with
 * an identical digest is already held; the store answers `blocked` for a changed
 * digest under a known event identity, and for any write it cannot make durable.
 * A later decrypted event may replace an unavailable placeholder with the same
 * `eventId`.
 */
export interface EventIngestionPort {
  accept(input: Readonly<{ binding: SessionBinding; event: EventRef; canonicalPayload: Uint8Array }>): Promise<AcceptResult>;
  acceptUnavailable(input: Readonly<{ binding: SessionBinding; ref: UnavailableEventRef; reason: UnavailableReason }>): Promise<AcceptResult>;
}

/**
 * Maps a crypto-verified device to the participant it belongs to in a room.
 * `null` proves the device is not that room's participant device; `unavailable`
 * proves nothing and is retried.
 */
export interface ProvenancePort {
  participantForDevice(
    input: Readonly<{ roomId: RoomId; deviceId: DeviceId }>,
    options?: CallOptions,
  ): Promise<ParticipantId | null | 'unavailable'>;
}

export type IngestOutcome =
  | Readonly<{ kind: 'handled' }>
  | Readonly<{ kind: 'blocked'; code: 'missing_keys' | 'storage_failed' }>
  | Readonly<{ kind: 'retry' }>
  | Readonly<{ kind: 'cancelled' }>;

export type IngestContext = Readonly<{
  binding: SessionBinding;
  ingestion: EventIngestionPort;
  provenance: ProvenancePort;
  /** False once the owning connection generation is superseded or stopped. */
  isCurrent: () => boolean;
  signal: AbortSignal;
}>;

/** Handles `events` in source order; stops at the first one that is not durably handled. */
export async function ingestPage(ctx: IngestContext, events: readonly SourceEvent[]): Promise<IngestOutcome> {
  for (const event of events) {
    if (!ctx.isCurrent()) return { kind: 'cancelled' };
    const outcome = await ingestEvent(ctx, event);
    if (outcome.kind !== 'handled') return outcome;
  }
  return ctx.isCurrent() ? { kind: 'handled' } : { kind: 'cancelled' };
}

async function ingestEvent(ctx: IngestContext, event: SourceEvent): Promise<IngestOutcome> {
  if (event.kind === 'undecryptable') {
    // Keys may still arrive: hold the cursor rather than let the event disappear behind it.
    if (event.reason === 'missing_keys') return { kind: 'blocked', code: 'missing_keys' };
    return store(() => ctx.ingestion.acceptUnavailable({ binding: ctx.binding, ref: event.ref, reason: event.reason }));
  }

  const verified = await verifyEvent(ctx, event);
  if (verified.kind === 'retry') return { kind: 'retry' };
  if (verified.kind === 'forged') {
    // Content that fails authentication never reaches the pending store, and one bad
    // sender cannot stall the stream. The owner sees a placeholder attributed to the
    // verified sender, never to the author it claimed; a sender that is not a room
    // participant has nothing trustworthy to show, so the event is dropped.
    if (verified.sender === null) return { kind: 'handled' };
    const { v, roomId, eventId } = event.ref;
    const ref: UnavailableEventRef = {
      v, roomId, eventId, authorParticipantId: verified.sender, authorDeviceId: event.verifiedDeviceId,
    };
    return store(() => ctx.ingestion.acceptUnavailable({ binding: ctx.binding, ref, reason: 'decrypt_failed' }));
  }
  return store(() => ctx.ingestion.accept({ binding: ctx.binding, event: event.ref, canonicalPayload: event.canonicalPayload }));
}

async function store(write: () => Promise<AcceptResult>): Promise<IngestOutcome> {
  let result: AcceptResult;
  try {
    result = await write();
  } catch {
    result = 'blocked';
  }
  return result === 'blocked' ? { kind: 'blocked', code: 'storage_failed' } : { kind: 'handled' };
}

type Verification =
  | Readonly<{ kind: 'ok' }>
  | Readonly<{ kind: 'forged'; sender: ParticipantId | null }>
  | Readonly<{ kind: 'retry' }>;

/**
 * Maps the crypto-verified device to its participant, then requires that sender to
 * be the claimed author and the payload bytes to match the digest.
 */
async function verifyEvent(
  ctx: IngestContext,
  event: Extract<SourceEvent, { kind: 'decrypted' }>,
): Promise<Verification> {
  const { ref } = event;
  let sender: ParticipantId | null | 'unavailable';
  try {
    sender = await ctx.provenance.participantForDevice({ roomId: ref.roomId, deviceId: event.verifiedDeviceId }, { signal: ctx.signal });
  } catch {
    sender = 'unavailable';
  }
  if (sender === 'unavailable') return { kind: 'retry' };
  if (sender === null || event.verifiedDeviceId !== ref.authorDeviceId || sender !== ref.authorParticipantId) {
    return { kind: 'forged', sender };
  }
  return sha256(event.canonicalPayload) === ref.contentDigest ? { kind: 'ok' } : { kind: 'forged', sender };
}

/** Connector code runs under Node, where hashing is synchronous and needs no platform Web Crypto. */
function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
