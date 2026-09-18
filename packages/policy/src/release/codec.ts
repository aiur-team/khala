// Canonical release bytes. KHA-105 owns the per-message encoding; this codec adds
// provenance and recipient identity around the exact approved bodies.

import {
  type BindingId, type EventRef, type ReleaseId, decodeBindingId, decodeEventRef, decodeReleaseId,
} from '@khala/contracts/delivery/index';
import type { ReleaseContent } from './types';

/** Domain separator of the version 1 release encoding. */
export const RELEASE_ENCODING_V1 = 'khala.release.v1';

/** Domain separator of the KHA-105 version 1 message encoding. */
const MESSAGE_ENCODING_V1 = 'khala.message.v1';

export type ReleasePayloadInput = Readonly<{
  releaseId: ReleaseId;
  bindingId: BindingId;
  generation: number;
  policyVersion: number;
  /** Selection order is preserved. */
  items: readonly Readonly<{ ref: EventRef; content: ReleaseContent }>[];
}>;

export type EncodeResult =
  | Readonly<{ ok: true; bytes: Uint8Array }>
  | Readonly<{ ok: false; code: 'invalid_field' | 'invalid_version'; field: string }>;

export type DigestResult =
  | Readonly<{ ok: true; digest: string }>
  | Readonly<{ ok: false; reason: 'crypto_unavailable' }>;

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** A body KHA-105 can encode: well-formed UTF-16 without NUL, never normalised. */
export function isEncodableBody(body: unknown): body is string {
  return typeof body === 'string' && !LONE_SURROGATE.test(body) && !body.includes('\u0000');
}

const isVersion = (value: unknown): boolean => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/**
 * Version 1 release encoding: UTF-8 of the compact positional JSON array
 * `["khala.release.v1",releaseId,bindingId,generation,policyVersion,
 * [[roomId,eventId,authorParticipantId,authorDeviceId,contentDigest,body],...]]`.
 * Selection order is kept and no Unicode or newline normalisation applies. String
 * escaping is exactly ECMAScript `JSON.stringify`, as in the KHA-105 encoding.
 * Never throws and never echoes a value in its failure.
 */
export function encodeReleasePayload(input: ReleasePayloadInput): EncodeResult {
  const invalid = (field: string, code: 'invalid_field' | 'invalid_version' = 'invalid_field'): EncodeResult =>
    ({ ok: false, code, field });
  if (!decodeReleaseId(input.releaseId).ok) return invalid('releaseId');
  if (!decodeBindingId(input.bindingId).ok) return invalid('bindingId');
  if (!isVersion(input.generation)) return invalid('generation');
  if (!isVersion(input.policyVersion)) return invalid('policyVersion');
  if (!Array.isArray(input.items) || input.items.length === 0) return invalid('items');

  const rows: string[][] = [];
  for (const [index, item] of input.items.entries()) {
    const ref = decodeEventRef(item.ref);
    if (!ref.ok) {
      const field = ref.field === '' ? `items[${index}].ref` : `items[${index}].ref.${ref.field}`;
      return invalid(field, ref.code === 'invalid_version' ? 'invalid_version' : 'invalid_field');
    }
    const { content } = item;
    if (content.v !== 1 || content.kind !== 'text') return invalid(`items[${index}].content`, 'invalid_version');
    if (!isEncodableBody(content.body)) return invalid(`items[${index}].content.body`);
    const { roomId, eventId, authorParticipantId, authorDeviceId, contentDigest } = ref.value;
    rows.push([roomId, eventId, authorParticipantId, authorDeviceId, contentDigest, content.body]);
  }

  const tuple = [RELEASE_ENCODING_V1, input.releaseId, input.bindingId, input.generation, input.policyVersion, rows];
  return { ok: true, bytes: new TextEncoder().encode(JSON.stringify(tuple)) };
}

/** KHA-105 version 1 content bytes, re-derived here so policy never imports messaging. */
export function encodeMessageContent(content: ReleaseContent): Uint8Array {
  return new TextEncoder().encode(JSON.stringify([MESSAGE_ENCODING_V1, content.kind, content.body]));
}

/** Prefixed lowercase SHA-256 via the platform Web Crypto API. Never throws. */
export async function sha256Digest(bytes: Uint8Array): Promise<DigestResult> {
  let digest: Uint8Array;
  try {
    // Copy into an ArrayBuffer-backed view; DOM's BufferSource rejects ArrayBufferLike.
    digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(bytes)));
  } catch {
    return { ok: false, reason: 'crypto_unavailable' };
  }
  return { ok: true, digest: `sha256:${Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')}` };
}
