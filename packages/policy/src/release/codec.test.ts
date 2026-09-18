import { describe, expect, it } from 'vitest';
import type { BindingId, EventRef, ReleaseId } from '@khala/contracts/delivery/index';
import { encodeReleasePayload, type ReleasePayloadInput } from './index';
import { sha256Digest } from './codec';
import { digest, id, text } from './fixtures/sample';

const BODY = 'Review the API change.\nDo not merge yet.';
const BODY_DIGEST = 'sha256:f16c1e5a70000f33eebc69c8ecf82d1ab7360fcdd15121ac3293f1afd4d4ea6b';

// Literal fixture from the KHA-119 plan, computed independently with Python hashlib.
const LITERAL_JSON = '["khala.release.v1","release_demo_1","binding_a1",1,1,[["room_demo","event_intro_1","agent_alice","device_a1",'
  + '"sha256:f16c1e5a70000f33eebc69c8ecf82d1ab7360fcdd15121ac3293f1afd4d4ea6b","Review the API change.\\nDo not merge yet."]]]';
const LITERAL_DIGEST = 'sha256:99014d34d49a8edd7f21b5c983a3fe63856ece67ea7c7ae2741db0193c3ec243';

const ref = (eventId: string, contentDigest = BODY_DIGEST): EventRef => ({
  v: 1,
  roomId: id('room_demo'),
  eventId: id(eventId),
  authorParticipantId: id('agent_alice'),
  authorDeviceId: id('device_a1'),
  contentDigest,
});

const demo = (overrides: Partial<ReleasePayloadInput> = {}): ReleasePayloadInput => ({
  releaseId: id<ReleaseId>('release_demo_1'),
  bindingId: id<BindingId>('binding_a1'),
  generation: 1,
  policyVersion: 1,
  items: [{ ref: ref('event_intro_1'), content: text(BODY) }],
  ...overrides,
});

async function encodeAndDigest(input: ReleasePayloadInput): Promise<{ bytes: Uint8Array; digest: string }> {
  const encoded = encodeReleasePayload(input);
  if (!encoded.ok) throw new Error(`encode failed at ${encoded.field}`);
  const hashed = await sha256Digest(encoded.bytes);
  if (!hashed.ok) throw new Error('digest unavailable');
  return { bytes: encoded.bytes, digest: hashed.digest };
}

describe('release codec', () => {
  it('matches the literal fixture byte for byte', async () => {
    // The fixture body digest is the KHA-105 digest of the same body.
    expect(await digest(BODY)).toBe(BODY_DIGEST);
    const { bytes, digest: payloadDigest } = await encodeAndDigest(demo());
    expect(bytes.byteLength).toBe(230);
    expect(new TextDecoder().decode(bytes)).toBe(LITERAL_JSON);
    expect(payloadDigest).toBe(LITERAL_DIGEST);
  });

  it('keeps selection order: a reordered selection encodes differently', async () => {
    const first = { ref: ref('event_1'), content: text(BODY) };
    const second = { ref: ref('event_2'), content: text(BODY) };
    const ab = await encodeAndDigest(demo({ items: [first, second] }));
    const ba = await encodeAndDigest(demo({ items: [second, first] }));
    expect(ab.digest).not.toBe(ba.digest);
  });

  it('never normalises Unicode or newlines', async () => {
    const composed = await encodeAndDigest(demo({ items: [{ ref: ref('e'), content: text('café') }] }));
    const decomposed = await encodeAndDigest(demo({ items: [{ ref: ref('e'), content: text('cafe\u0301') }] }));
    expect(composed.digest).not.toBe(decomposed.digest);
    const lf = await encodeAndDigest(demo({ items: [{ ref: ref('e'), content: text('a\nb') }] }));
    const crlf = await encodeAndDigest(demo({ items: [{ ref: ref('e'), content: text('a\r\nb') }] }));
    expect(lf.digest).not.toBe(crlf.digest);
  });

  it.each([
    ['unsafe generation', { generation: Number.MAX_SAFE_INTEGER + 1 }, 'generation', 'invalid_field'],
    ['negative policy version', { policyVersion: -1 }, 'policyVersion', 'invalid_field'],
    ['fractional generation', { generation: 1.5 }, 'generation', 'invalid_field'],
    ['empty release id', { releaseId: id<ReleaseId>('') }, 'releaseId', 'invalid_field'],
    ['empty selection', { items: [] }, 'items', 'invalid_field'],
    [
      'unknown message version',
      { items: [{ ref: ref('e'), content: { v: 2, kind: 'text', body: BODY } as never }] },
      'items[0].content',
      'invalid_version',
    ],
    [
      'unknown reference version',
      { items: [{ ref: { ...ref('e'), v: 2 } as never, content: text(BODY) }] },
      'items[0].ref.v',
      'invalid_version',
    ],
    [
      'malformed digest',
      { items: [{ ref: ref('e', 'sha256:ABC'), content: text(BODY) }] },
      'items[0].ref.contentDigest',
      'invalid_field',
    ],
    ['lone surrogate body', { items: [{ ref: ref('e'), content: text('\ud800') }] }, 'items[0].content.body', 'invalid_field'],
    ['NUL body', { items: [{ ref: ref('e'), content: text('a\u0000b') }] }, 'items[0].content.body', 'invalid_field'],
  ] as const)('rejects %s without echoing the value', (_name, change, field, code) => {
    const result = encodeReleasePayload(demo(change as Partial<ReleasePayloadInput>));
    expect(result).toEqual({ ok: false, code, field });
  });
});
