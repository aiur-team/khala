import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import intro from '../../fixtures/messaging/exact-intro.json';
import {
  type EventRef, type MessageContent, decodeEventRef, decodeTimelineItem, digestMessageContent, encodeMessageContent,
  sameEventRef,
} from './events';

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const text = (body: string): MessageContent => ({ v: 1, kind: 'text', body });
const ref = intro.eventRef as EventRef;

describe('exact intro content encoding', () => {
  it('matches the independently computed literal bytes and digest', async () => {
    const bytes = encodeMessageContent(intro.content as MessageContent);
    expect(bytes.byteLength).toBe(71);
    expect(bytes.byteLength).toBe(intro.encoding.byteLength);
    expect(hex(bytes)).toBe(intro.encoding.utf8Hex);
    expect(await digestMessageContent(intro.content as MessageContent)).toBe(intro.encoding.contentDigest);
    expect(intro.encoding.contentDigest).toBe('sha256:f16c1e5a70000f33eebc69c8ecf82d1ab7360fcdd15121ac3293f1afd4d4ea6b');
  });

  it('pins the fixture digest with a separate platform SHA-256 primitive', () => {
    const fixtureBytes = Buffer.from(intro.encoding.utf8Hex, 'hex');
    expect(`sha256:${createHash('sha256').update(fixtureBytes).digest('hex')}`).toBe(intro.encoding.contentDigest);
  });

  it.each(intro.digestVectors)('matches vector $name', async vector => {
    expect(hex(encodeMessageContent(text(vector.body)))).toBe(vector.utf8Hex);
    expect(await digestMessageContent(text(vector.body))).toBe(vector.contentDigest);
  });

  it('never normalises newlines or Unicode', async () => {
    const digests = new Map(intro.digestVectors.map(vector => [vector.name, vector.contentDigest]));
    expect(digests.get('crlf_newline')).not.toBe(intro.encoding.contentDigest);
    expect(digests.get('nfc_e_acute')).not.toBe(digests.get('nfd_e_acute'));
    expect(await digestMessageContent(text('caf\u00e9'))).not.toBe(await digestMessageContent(text('cafe\u0301')));
  });

  it('is positional, so input key order cannot change the bytes', () => {
    const reordered = JSON.parse('{"body":"Review the API change.\\nDo not merge yet.","kind":"text","v":1}') as MessageContent;
    expect(hex(encodeMessageContent(reordered))).toBe(intro.encoding.utf8Hex);
  });

  it('refuses bodies UTF-8 cannot carry exactly', () => {
    expect(() => encodeMessageContent(text('broken \ud800 surrogate'))).toThrow(TypeError);
  });
});

describe('event references', () => {
  it('decodes the worked reference unchanged', () => {
    expect(decodeEventRef(intro.eventRef)).toEqual({ ok: true, value: intro.eventRef });
  });

  it('treats an edit as a different immutable reference', () => {
    const edit: EventRef = { ...ref, eventId: 'event_intro_1_edit' };
    expect(sameEventRef(ref, edit)).toBe(false);
    expect(sameEventRef(ref, { ...ref })).toBe(true);
  });

  it('detects author and device substitution', () => {
    expect(sameEventRef(ref, { ...ref, authorParticipantId: 'agent_bob' })).toBe(false);
    expect(sameEventRef(ref, { ...ref, authorDeviceId: 'device_b1' })).toBe(false);
  });

  it('accepts a timeline item only when the reference digests its exact content', async () => {
    expect(await decodeTimelineItem(intro.timelineItem, intro.limits)).toEqual({ ok: true, value: intro.timelineItem });
  });
});
