// Immutable event references and the exact authored content they identify.
// SDK encryption, rendering and transport formats stay outside this contract.

import {
  type ContentLimits, type Decoded, decodeWith, fail, identifier, literal, nullable, object, text,
  utcTimestamp, version,
} from './decode';
import { type DeviceId, type EventId, type ParticipantId, type RoomId, readId } from './ids';
import { type ParticipantView, readParticipantView } from './identity';

/**
 * Reference to one authored, immutable event. An edit is another event with another
 * reference; the digest covers the approved content bytes, never display output.
 */
export type EventRef = Readonly<{
  v: 1;
  roomId: RoomId;
  eventId: EventId;
  authorParticipantId: ParticipantId;
  authorDeviceId: DeviceId;
  /** `sha256:` followed by 64 lowercase hex digits. */
  contentDigest: string;
}>;

/** Text message content. The body is retained exactly as authored. */
export type MessageContent = Readonly<{ v: 1; kind: 'text'; body: string }>;

/**
 * Finite public reasons a timeline event's content cannot be shown. Never a free-text
 * SDK error: `missing_keys` (no room key reached this device), `withheld_unverified`
 * (see the KHA-142 evidence categories), `decrypt_failed`, or `unsupported` (an
 * encoding this client does not understand).
 */
export const UNAVAILABLE_REASONS = ['missing_keys', 'withheld_unverified', 'decrypt_failed', 'unsupported'] as const;

export type UnavailableReason = (typeof UNAVAILABLE_REASONS)[number];

/** Placeholder for a timeline event whose content cannot be shown. No free-text reasons. */
export type UnavailableContent = Readonly<{ v: 1; kind: 'unavailable'; reason: UnavailableReason }>;

/** The two shapes a timeline item's content can take. */
export type TimelineContent = MessageContent | UnavailableContent;

/**
 * A timeline entry. Only endpoint ports expose these; control APIs carry `EventRef`
 * metadata alone. `content` is `unavailable` when the plaintext cannot be shown; the
 * `ref` identity and ordering are unaffected.
 */
export type TimelineItem = Readonly<{
  ref: EventRef;
  content: TimelineContent;
  participant: ParticipantView;
  clientTxnId: string | null;
  /** UTC RFC 3339, local receipt time; not an ordering authority. */
  receivedAt: string;
}>;

/** Domain separator of the version 1 content encoding. */
export const MESSAGE_ENCODING_V1 = 'khala.message.v1';

const DIGEST = /^sha256:[0-9a-f]{64}$/;

export function isContentDigest(value: string): boolean {
  return DIGEST.test(value);
}

/**
 * Version 1 content encoding: UTF-8 of the compact JSON array
 * `["khala.message.v1","text",body]`. Positional, so no key ordering applies; the
 * body is never Unicode- or newline-normalised. String escaping is exactly
 * ECMAScript `JSON.stringify`: `"` and `\` are backslash-escaped; U+0008, U+0009,
 * U+000A, U+000C and U+000D use `\b \t \n \f \r`; every other U+0000-U+001F uses
 * `\u00xx` with lowercase hex; everything else, including DEL, U+2028, U+2029,
 * `<`, `>`, `&` and all non-ASCII, is emitted as raw UTF-8. Unpaired surrogates and
 * NUL are refused, so the escaping never has to represent them.
 *
 * Throws `TypeError` for content outside version 1 `text`; digest through
 * `digestMessageContent` for a total result.
 */
export function encodeMessageContent(content: MessageContent): Uint8Array {
  if (content.v !== 1 || content.kind !== 'text') throw new TypeError('unsupported message content version or kind');
  const body = decodeWith(() => text(content.body, 'body', Number.MAX_SAFE_INTEGER));
  if (!body.ok) throw new TypeError(`invalid message content: ${body.error.path} ${body.error.code}`);
  return new TextEncoder().encode(JSON.stringify([MESSAGE_ENCODING_V1, content.kind, content.body]));
}

/**
 * Digest outcome. `crypto_unavailable` means the platform has no usable Web Crypto
 * (for example a non-secure browser origin); it never means the content is wrong.
 */
export type DigestResult =
  | Readonly<{ ok: true; digest: string }>
  | Readonly<{ ok: false; reason: 'invalid_content' | 'crypto_unavailable' }>;

/** `sha256:<hex>` over `encodeMessageContent(content)`, via the platform Web Crypto API. Never throws. */
export async function digestMessageContent(content: MessageContent): Promise<DigestResult> {
  let bytes: Uint8Array;
  try {
    bytes = encodeMessageContent(content);
  } catch {
    return { ok: false, reason: 'invalid_content' };
  }
  let digest: Uint8Array;
  try {
    // A missing `crypto` or `crypto.subtle` throws here too, and is reported the same way.
    // Copy into an ArrayBuffer-backed view: DOM's BufferSource rejects
    // Uint8Array<ArrayBufferLike> (TS 5.9 lib.dom), which broke web typecheck.
    digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(bytes)));
  } catch {
    return { ok: false, reason: 'crypto_unavailable' };
  }
  return { ok: true, digest: `sha256:${Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')}` };
}

export function decodeEventRef(input: unknown): Decoded<EventRef> {
  return decodeWith(() => readEventRef(input, ''));
}

export function readEventRef(input: unknown, path: string): EventRef {
  const r = object(input, path, ['v', 'roomId', 'eventId', 'authorParticipantId', 'authorDeviceId', 'contentDigest']);
  const ref: EventRef = {
    v: version(r.field('v'), r.at('v')),
    roomId: readId<'RoomId'>(r.field('roomId'), r.at('roomId')),
    eventId: readId<'EventId'>(r.field('eventId'), r.at('eventId')),
    authorParticipantId: readId<'ParticipantId'>(r.field('authorParticipantId'), r.at('authorParticipantId')),
    authorDeviceId: readId<'DeviceId'>(r.field('authorDeviceId'), r.at('authorDeviceId')),
    contentDigest: identifier(r.field('contentDigest'), r.at('contentDigest')),
  };
  if (!isContentDigest(ref.contentDigest)) fail(r.at('contentDigest'), 'invalid_value');
  return ref;
}

/** Exact equality of every reference field. */
export function sameEventRef(a: EventRef, b: EventRef): boolean {
  return a.v === b.v && a.roomId === b.roomId && a.eventId === b.eventId && a.authorParticipantId === b.authorParticipantId
    && a.authorDeviceId === b.authorDeviceId && a.contentDigest === b.contentDigest;
}

export function decodeMessageContent(input: unknown, limits: ContentLimits): Decoded<MessageContent> {
  return decodeWith(() => readMessageContent(input, '', limits));
}

export function readMessageContent(input: unknown, path: string, limits: ContentLimits): MessageContent {
  const r = object(input, path, ['v', 'kind', 'body']);
  return {
    v: version(r.field('v'), r.at('v')),
    kind: literal(r.field('kind'), r.at('kind'), ['text']),
    body: text(r.field('body'), r.at('body'), limits.maxBodyBytes),
  };
}

export function decodeUnavailableContent(input: unknown): Decoded<UnavailableContent> {
  return decodeWith(() => readUnavailableContent(input, ''));
}

export function readUnavailableContent(input: unknown, path: string): UnavailableContent {
  const r = object(input, path, ['v', 'kind', 'reason']);
  return {
    v: version(r.field('v'), r.at('v')),
    kind: literal(r.field('kind'), r.at('kind'), ['unavailable']),
    reason: literal(r.field('reason'), r.at('reason'), UNAVAILABLE_REASONS),
  };
}

export function decodeTimelineContent(input: unknown, limits: ContentLimits): Decoded<TimelineContent> {
  return decodeWith(() => readTimelineContent(input, '', limits));
}

/** Dispatches on `kind` before either reader enforces its own exact field set. */
export function readTimelineContent(input: unknown, path: string, limits: ContentLimits): TimelineContent {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) fail(path, 'not_object');
  const kind = (input as Record<string, unknown>).kind;
  return kind === 'unavailable' ? readUnavailableContent(input, path) : readMessageContent(input, path, limits);
}

/**
 * Decodes a timeline item and proves the reference binds exactly this content and
 * the attributed participant. Structural success alone is not enough: the digest is
 * recomputed. `ref.authorDeviceId` is not required to appear in the participant's
 * current `deviceIds`, because devices rotate and history outlives them; callers
 * that approve a specific event compare the full reference with `sameEventRef`.
 */
export async function decodeTimelineItem(input: unknown, limits: ContentLimits): Promise<Decoded<TimelineItem>> {
  const decoded = decodeWith(() => readTimelineItem(input, '', limits));
  if (!decoded.ok) return decoded;
  const mismatch = await verifyContentDigest(decoded.value, 'ref.contentDigest');
  return mismatch ?? decoded;
}

/**
 * Returns a located failure when the item's reference does not digest its content
 * (`mismatch`) or the digest cannot be computed here (`digest_unavailable`). An
 * `unavailable` item carries no recoverable plaintext, so there is nothing to digest.
 */
export async function verifyContentDigest(item: TimelineItem, path: string): Promise<Decoded<never> | null> {
  if (item.content.kind === 'unavailable') return null;
  const result = await digestMessageContent(item.content);
  if (!result.ok) return { ok: false, error: { path, code: result.reason === 'crypto_unavailable' ? 'digest_unavailable' : 'invalid_value' } };
  return result.digest === item.ref.contentDigest ? null : { ok: false, error: { path, code: 'mismatch' } };
}

/** Structural read only; callers must still verify the digest (see `decodeTimelineItem`). */
export function readTimelineItem(input: unknown, path: string, limits: ContentLimits): TimelineItem {
  const r = object(input, path, ['ref', 'content', 'participant', 'clientTxnId', 'receivedAt']);
  const item: TimelineItem = {
    ref: readEventRef(r.field('ref'), r.at('ref')),
    content: readTimelineContent(r.field('content'), r.at('content'), limits),
    participant: readParticipantView(r.field('participant'), r.at('participant'), limits),
    clientTxnId: nullable(r.field('clientTxnId'), value => identifier(value, r.at('clientTxnId'))),
    receivedAt: utcTimestamp(r.field('receivedAt'), r.at('receivedAt')),
  };
  if (item.participant.participantId !== item.ref.authorParticipantId) fail(r.at('participant'), 'mismatch');
  return item;
}
