import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import intro from '../../fixtures/messaging/exact-intro.json';
import { type ContentLimits, decodeContentLimits } from './decode';
import {
  type EventRef, type MessageContent, type UnavailableEventRef, UNAVAILABLE_REASONS, decodeEventRef, decodeTimelineItem,
  decodeUnavailableContent, decodeUnavailableEventRef, digestMessageContent, encodeMessageContent, sameEventRef,
} from './events';

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const text = (body: string): MessageContent => ({ v: 1, kind: 'text', body });
const ref = intro.eventRef as EventRef;
const limits = (() => {
  const decoded = decodeContentLimits(intro.limits);
  if (!decoded.ok) throw new Error('fixture limits must decode');
  return decoded.value;
})() satisfies ContentLimits;

async function digestOf(content: MessageContent): Promise<string> {
  const result = await digestMessageContent(content);
  if (!result.ok) throw new Error(`digest failed: ${result.reason}`);
  return result.digest;
}

describe('exact intro content encoding', () => {
  it('matches the independently computed literal bytes and digest', async () => {
    const bytes = encodeMessageContent(intro.content as MessageContent);
    expect(bytes.byteLength).toBe(71);
    expect(bytes.byteLength).toBe(intro.encoding.byteLength);
    expect(hex(bytes)).toBe(intro.encoding.utf8Hex);
    expect(await digestOf(intro.content as MessageContent)).toBe(intro.encoding.contentDigest);
    expect(intro.encoding.contentDigest).toBe('sha256:f16c1e5a70000f33eebc69c8ecf82d1ab7360fcdd15121ac3293f1afd4d4ea6b');
  });

  it('pins the fixture digest with a separate platform SHA-256 primitive', () => {
    const fixtureBytes = Buffer.from(intro.encoding.utf8Hex, 'hex');
    expect(`sha256:${createHash('sha256').update(fixtureBytes).digest('hex')}`).toBe(intro.encoding.contentDigest);
  });

  it.each(intro.digestVectors)('matches vector $name', async vector => {
    expect(hex(encodeMessageContent(text(vector.body)))).toBe(vector.utf8Hex);
    expect(await digestOf(text(vector.body))).toBe(vector.contentDigest);
  });

  it('never normalises newlines or Unicode', async () => {
    const digests = new Map(intro.digestVectors.map(vector => [vector.name, vector.contentDigest]));
    expect(digests.get('crlf_newline')).not.toBe(intro.encoding.contentDigest);
    expect(digests.get('nfc_e_acute')).not.toBe(digests.get('nfd_e_acute'));
    expect(await digestOf(text('caf\u00e9'))).not.toBe(await digestOf(text('cafe\u0301')));
  });

  it('is positional, so input key order cannot change the bytes', () => {
    const reordered = JSON.parse('{"body":"Review the API change.\\nDo not merge yet.","kind":"text","v":1}') as MessageContent;
    expect(hex(encodeMessageContent(reordered))).toBe(intro.encoding.utf8Hex);
  });

  it('refuses bodies UTF-8 cannot carry exactly', () => {
    expect(() => encodeMessageContent(text('broken \ud800 surrogate'))).toThrow(TypeError);
  });

  it('refuses any version or kind other than version 1 text', () => {
    expect(() => encodeMessageContent({ ...text('hi'), v: 2 } as unknown as MessageContent)).toThrow(TypeError);
    expect(() => encodeMessageContent({ ...text('hi'), kind: 'html' } as unknown as MessageContent)).toThrow(TypeError);
  });
});

describe('digestMessageContent is total', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reports invalid content instead of throwing', async () => {
    expect(await digestMessageContent(text('broken \ud800 surrogate'))).toEqual({ ok: false, reason: 'invalid_content' });
  });

  it('reports missing Web Crypto, as on a non-secure origin, instead of throwing', async () => {
    vi.stubGlobal('crypto', {});
    expect(await digestMessageContent(text('hi'))).toEqual({ ok: false, reason: 'crypto_unavailable' });
    vi.stubGlobal('crypto', undefined);
    expect(await digestMessageContent(text('hi'))).toEqual({ ok: false, reason: 'crypto_unavailable' });
  });

  it('reports a rejecting Web Crypto instead of throwing', async () => {
    vi.stubGlobal('crypto', { subtle: { digest: () => Promise.reject(new Error('NotSupportedError')) } });
    expect(await digestMessageContent(text('hi'))).toEqual({ ok: false, reason: 'crypto_unavailable' });
  });

  it('turns an unavailable digest into a located decode failure, never a success', async () => {
    vi.stubGlobal('crypto', {});
    expect(await decodeTimelineItem(intro.timelineItem, limits))
      .toEqual({ ok: false, error: { path: 'ref.contentDigest', code: 'digest_unavailable' } });
  });
});

describe('event references', () => {
  it('decodes the worked reference unchanged', () => {
    expect(decodeEventRef(intro.eventRef)).toEqual({ ok: true, value: intro.eventRef });
  });

  it('treats an edit as a different immutable reference', () => {
    expect(sameEventRef(ref, { ...ref, eventId: 'event_intro_1_edit' as EventRef['eventId'] })).toBe(false);
    expect(sameEventRef(ref, { ...ref })).toBe(true);
  });

  // One case per compared field: an approval for this event must not match any other.
  const substitutions: { [Field in keyof EventRef]: unknown } = {
    v: 2,
    roomId: 'room_other',
    eventId: 'event_intro_2',
    authorParticipantId: 'agent_bob',
    authorDeviceId: 'device_b1',
    contentDigest: intro.digestVectors[0]!.contentDigest,
  };

  it('compares every reference field', () => {
    expect(Object.keys(substitutions).sort()).toEqual(Object.keys(ref).sort());
  });

  it.each(Object.entries(substitutions))('refuses a reference differing only in %s', (field, value) => {
    expect(sameEventRef(ref, { ...ref, [field]: value } as EventRef)).toBe(false);
    expect(sameEventRef({ ...ref, [field]: value } as EventRef, ref)).toBe(false);
  });

  it('accepts a timeline item only when the reference digests its exact content', async () => {
    expect(await decodeTimelineItem(intro.timelineItem, limits)).toEqual({ ok: true, value: intro.timelineItem });
  });
});

describe('unavailable content', () => {
  it('decodes a closed reason unchanged', () => {
    expect(decodeUnavailableContent(intro.unavailableContent)).toEqual({ ok: true, value: intro.unavailableContent });
  });

  it.each(UNAVAILABLE_REASONS)('accepts every closed reason, including %s', reason => {
    expect(decodeUnavailableContent({ ...intro.unavailableContent, reason })).toEqual({ ok: true, value: { ...intro.unavailableContent, reason } });
  });

  it('refuses a reason outside the closed set, including a plausible SDK-shaped one', () => {
    expect(decodeUnavailableContent({ ...intro.unavailableContent, reason: 'OlmError: session key corrupted' }))
      .toEqual({ ok: false, error: { path: 'reason', code: 'invalid_value' } });
  });

  it('keeps the same identity and ordering fields as a decryptable item, minus the digest', async () => {
    const decoded = await decodeTimelineItem(intro.timelineItemUnavailable, limits);
    expect(decoded).toEqual({ ok: true, value: intro.timelineItemUnavailable });
    if (decoded.ok) {
      expect(decoded.value.ref.roomId).toBe(intro.timelineItem.ref.roomId);
      expect(decodeUnavailableEventRef(decoded.value.ref)).toEqual({ ok: true, value: decoded.value.ref });
    }
  });

  it('never digests unavailable content, even with no usable Web Crypto', async () => {
    vi.stubGlobal('crypto', {});
    try {
      expect(await decodeTimelineItem(intro.timelineItemUnavailable, limits)).toEqual({ ok: true, value: intro.timelineItemUnavailable });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('decodes the unavailable reference unchanged, with no contentDigest field', () => {
    expect(decodeUnavailableEventRef(intro.timelineItemUnavailable.ref)).toEqual({ ok: true, value: intro.timelineItemUnavailable.ref });
    expect(intro.timelineItemUnavailable.ref).not.toHaveProperty('contentDigest');
  });

  it('is a compile-time guarantee, not just a runtime one, that an unavailable reference cannot approve an event', () => {
    const unavailableRef = intro.timelineItemUnavailable.ref as UnavailableEventRef;
    // @ts-expect-error UnavailableEventRef has no contentDigest, so it cannot stand in for an EventRef.
    expect(sameEventRef(unavailableRef, ref)).toBe(false);
  });
});
