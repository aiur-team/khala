// Immutable event references and the exact authored content they identify.
// SDK encryption, rendering and transport formats stay outside this contract.

import {
  type ContentLimits, type Decoded, decodeWith, fail, identifier, literal, nullable, object, text,
  utcTimestamp, version,
} from './decode';
import { type ParticipantView, readParticipantView } from './identity';

/**
 * Reference to one authored, immutable event. An edit is another event with another
 * reference; the digest covers the approved content bytes, never display output.
 */
export type EventRef = Readonly<{
  v: 1;
  roomId: string;
  eventId: string;
  authorParticipantId: string;
  authorDeviceId: string;
  /** `sha256:` followed by 64 lowercase hex digits. */
  contentDigest: string;
}>;

/** Text message content. The body is retained exactly as authored. */
export type MessageContent = Readonly<{ v: 1; kind: 'text'; body: string }>;

/**
 * A decrypted timeline entry. Only endpoint ports expose these; control APIs carry
 * `EventRef` metadata alone.
 */
export type TimelineItem = Readonly<{
  ref: EventRef;
  content: MessageContent;
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
 * body is never Unicode- or newline-normalised. Unpaired surrogates are refused
 * because UTF-8 cannot carry them without substitution.
 */
export function encodeMessageContent(content: MessageContent): Uint8Array {
  if (content.v !== 1 || content.kind !== 'text') throw new TypeError('unsupported message content version or kind');
  decodeOrThrow(() => text(content.body, 'body', Number.MAX_SAFE_INTEGER));
  return new TextEncoder().encode(JSON.stringify([MESSAGE_ENCODING_V1, content.kind, content.body]));
}

/** `sha256:<hex>` over `encodeMessageContent(content)`, via the platform Web Crypto API. */
export async function digestMessageContent(content: MessageContent): Promise<string> {
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', encodeMessageContent(content)));
  return `sha256:${Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

export function decodeEventRef(input: unknown): Decoded<EventRef> {
  return decodeWith(() => readEventRef(input, ''));
}

export function readEventRef(input: unknown, path: string): EventRef {
  const r = object(input, path, ['v', 'roomId', 'eventId', 'authorParticipantId', 'authorDeviceId', 'contentDigest']);
  const ref: EventRef = {
    v: version(r.field('v'), r.at('v')),
    roomId: identifier(r.field('roomId'), r.at('roomId')),
    eventId: identifier(r.field('eventId'), r.at('eventId')),
    authorParticipantId: identifier(r.field('authorParticipantId'), r.at('authorParticipantId')),
    authorDeviceId: identifier(r.field('authorDeviceId'), r.at('authorDeviceId')),
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

/** Returns a located `mismatch` failure when the item's reference does not digest its content. */
export async function verifyContentDigest(item: TimelineItem, path: string): Promise<Decoded<never> | null> {
  return await digestMessageContent(item.content) === item.ref.contentDigest ? null : { ok: false, error: { path, code: 'mismatch' } };
}

/** Structural read only; callers must still verify the digest (see `decodeTimelineItem`). */
export function readTimelineItem(input: unknown, path: string, limits: ContentLimits): TimelineItem {
  const r = object(input, path, ['ref', 'content', 'participant', 'clientTxnId', 'receivedAt']);
  const item: TimelineItem = {
    ref: readEventRef(r.field('ref'), r.at('ref')),
    content: readMessageContent(r.field('content'), r.at('content'), limits),
    participant: readParticipantView(r.field('participant'), r.at('participant'), limits),
    clientTxnId: nullable(r.field('clientTxnId'), value => identifier(value, r.at('clientTxnId'))),
    receivedAt: utcTimestamp(r.field('receivedAt'), r.at('receivedAt')),
  };
  if (item.participant.participantId !== item.ref.authorParticipantId) fail(r.at('participant'), 'mismatch');
  return item;
}

function decodeOrThrow(read: () => unknown): void {
  const decoded = decodeWith(read);
  if (!decoded.ok) throw new TypeError(`invalid message content: ${decoded.error.path} ${decoded.error.code}`);
}
