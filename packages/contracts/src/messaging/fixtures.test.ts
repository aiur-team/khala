import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import intro from '../../fixtures/messaging/exact-intro.json';
import invalid from '../../fixtures/messaging/invalid.json';
import views from '../../fixtures/messaging/views.json';
import { decodeAdmission, decodeInviteState, decodeShareGrant } from './admission';
import { decodeControlRecord } from './control-store';
import { type ContentLimits, type Decoded, decodeContentLimits } from './decode';
import { decodeDeviceView } from './devices';
import { decodeEventRef, decodeMessageContent, decodeTimelineItem } from './events';
import { type SessionBinding, decodeAuthPrincipal, decodeParticipantView, decodeSessionBinding, sameSessionBinding } from './identity';
import * as messaging from './index';
import { decodeRecoveryCapabilities, decodeRecoveryStatus } from './recovery';
import { decodeRevocationProgress, decodeRevocationRequest } from './revocation';
import { isCurrentGeneration } from './outcomes';
import { decodeRoomSnapshot, decodeRoomSummary, decodeSendState, decodeTimelinePage } from './rooms';

const limits = (() => {
  const decoded = decodeContentLimits(intro.limits);
  if (!decoded.ok) throw new Error('fixture limits must decode');
  return decoded.value;
})();
const decoders: Record<string, (input: unknown) => Decoded<unknown> | Promise<Decoded<unknown>>> = {
  principal: decodeAuthPrincipal,
  participant: input => decodeParticipantView(input, limits),
  binding: decodeSessionBinding,
  eventRef: decodeEventRef,
  content: input => decodeMessageContent(input, limits),
  timelineItem: input => decodeTimelineItem(input, limits),
  roomSummary: input => decodeRoomSummary(input, limits),
  sendState: decodeSendState,
  deviceView: decodeDeviceView,
  shareGrant: decodeShareGrant,
  inviteState: decodeInviteState,
  admission: input => decodeAdmission(input, limits),
  revocationRequest: decodeRevocationRequest,
  revocationProgress: decodeRevocationProgress,
  recoveryCapabilities: decodeRecoveryCapabilities,
  recoveryStatus: decodeRecoveryStatus,
  controlRecord: decodeControlRecord,
};

const expand = (value: unknown): unknown => {
  const match = typeof value === 'string' ? /^@repeat:(.+):(\d+)$/su.exec(value) : null;
  return match ? (match[1] as string).repeat(Number(match[2])) : value;
};

function mutate(base: unknown, set: Record<string, unknown> = {}, remove: readonly string[] = []): unknown {
  const copy = structuredClone(base) as Record<string, unknown>;
  for (const [path, value] of Object.entries(set)) {
    const keys = path.split('.');
    let target = copy;
    for (const key of keys.slice(0, -1)) target = target[key] as Record<string, unknown>;
    target[keys.at(-1) as string] = expand(value);
  }
  for (const key of remove) delete copy[key];
  return copy;
}

const lookup = (path: string): unknown => path.split('.').reduce<unknown>((value, key) => (value as Record<string, unknown>)[key], intro);

describe('exact intro fixture', () => {
  it.each([
    ['principal', 'principal'], ['participant', 'participants.human'], ['participant', 'participants.agent'],
    ['binding', 'binding'], ['eventRef', 'eventRef'], ['content', 'content'], ['timelineItem', 'timelineItem'],
  ])('%s decodes %s and round-trips byte-stable JSON', async (decoder, path) => {
    const input = lookup(path);
    const decoded = await decoders[decoder]!(input);
    expect(decoded).toEqual({ ok: true, value: input });
    if (decoded.ok) expect(JSON.stringify(decoded.value)).toBe(JSON.stringify(input));
  });

  it('keeps the reference, binding and content fields both contract domains mirror', () => {
    expect(Object.keys(intro.eventRef).sort()).toEqual(['authorDeviceId', 'authorParticipantId', 'contentDigest', 'eventId', 'roomId', 'v']);
    expect(Object.keys(intro.binding).sort()).toEqual(['agentParticipantId', 'bindingId', 'deviceId', 'generation', 'harness', 'ownerId', 'sessionId', 'v']);
    expect(intro.content.body).toBe('Review the API change.\nDo not merge yet.');
  });

  it('decodes a page and a snapshot containing the worked item', async () => {
    const room = { roomId: 'room_demo', title: 'API review', membership: 'joined', revision: 'rev_1' };
    expect((await decodeTimelinePage({ items: [intro.timelineItem], nextCursor: null, snapshotRevision: 's1' }, limits)).ok).toBe(true);
    expect((await decodeRoomSnapshot({ room, items: [intro.timelineItem], snapshotRevision: 's1', generation: 1 }, limits)).ok).toBe(true);
  });

  it('rejects duplicate event IDs in a page and foreign-room items in a snapshot', async () => {
    expect(await decodeTimelinePage({ items: [intro.timelineItem, intro.timelineItem], nextCursor: null, snapshotRevision: 's1' }, limits))
      .toEqual({ ok: false, error: { path: 'items[1].ref.eventId', code: 'duplicate' } });
    const room = { roomId: 'room_other', title: null, membership: 'joined', revision: 'rev_1' };
    expect(await decodeRoomSnapshot({ room, items: [intro.timelineItem], snapshotRevision: 's1', generation: 1 }, limits))
      .toEqual({ ok: false, error: { path: 'items[0].ref.roomId', code: 'mismatch' } });
  });

  it('rejects page and snapshot items whose reference does not digest their body', async () => {
    const tampered = mutate(intro.timelineItem, { 'content.body': 'Merge it now.' });
    const room = { roomId: 'room_demo', title: null, membership: 'joined', revision: 'rev_1' };
    const failure = { ok: false, error: { path: 'items[1].ref.contentDigest', code: 'mismatch' } };
    const second = mutate(tampered, { 'ref.eventId': 'event_intro_2' });
    expect(await decodeTimelinePage({ items: [intro.timelineItem, second], nextCursor: null, snapshotRevision: 's1' }, limits)).toEqual(failure);
    expect(await decodeRoomSnapshot({ room, items: [intro.timelineItem, second], snapshotRevision: 's1', generation: 1 }, limits)).toEqual(failure);
  });
});

describe('timestamps', () => {
  it('accepts early four-digit years without Date.UTC century mapping', () => {
    const early = { ...intro.principal, sessionExpiresAt: '0050-01-01T00:00:00Z' };
    expect(decodeAuthPrincipal(early)).toEqual({ ok: true, value: early });
  });
});

describe('invalid fixtures', () => {
  it.each(invalid.cases)('$name', async testCase => {
    const input = mutate(lookup(testCase.base), testCase.set, 'remove' in testCase ? testCase.remove : []);
    expect(await decoders[testCase.decoder]!(input)).toEqual({ ok: false, error: testCase.error });
  });

  it('lists every plan peer', () => {
    const names = [...invalid.cases, ...invalid.peers.cases].map(testCase => testCase.name);
    expect(names).toEqual(expect.arrayContaining([
      'same reference with different body',
      'same command operation ID with another room',
      'empty issuer',
      'email mapped as owner ID',
      'wrong digest prefix',
      'next generation substituted into a release targeting generation 1',
      'principal unknown envelope version',
      'stale observer generation',
    ]));
  });

  it('knows how to run every peer check', () => {
    // controlStore peers run against the conformance fake in control-store.test.ts.
    expect(invalid.peers.cases.map(peer => peer.check).filter(check => !['controlStore', 'sameSessionBinding', 'isCurrentGeneration'].includes(check)))
      .toEqual([]);
  });

  it.each(invalid.peers.cases.filter(peer => peer.check === 'sameSessionBinding'))('peer: $name', peer => {
    const base = lookup(peer.base as string);
    const decoded = [decodeSessionBinding(base), decodeSessionBinding(mutate(base, peer.set))];
    if (!decoded[0]!.ok || !decoded[1]!.ok) throw new Error('peer bindings must be well-formed');
    expect(sameSessionBinding(decoded[0]!.value as SessionBinding, decoded[1]!.value as SessionBinding)).toBe(peer.expect);
  });

  it.each(invalid.peers.cases.filter(peer => peer.check === 'isCurrentGeneration'))('peer: $name', peer => {
    expect(isCurrentGeneration(peer.currentGeneration as number, { generation: peer.notificationGeneration as number })).toBe(peer.expect);
  });
});

describe('content limits', () => {
  it('decodes the fixture limits unchanged', () => {
    expect(decodeContentLimits(intro.limits)).toEqual({ ok: true, value: intro.limits });
  });

  it.each([
    ['empty object', {}, 'maxBodyBytes', 'missing_field'],
    ['NaN body limit', { ...intro.limits, maxBodyBytes: Number.NaN }, 'maxBodyBytes', 'unsafe_integer'],
    ['infinite display name limit', { ...intro.limits, maxDisplayNameBytes: Number.POSITIVE_INFINITY }, 'maxDisplayNameBytes', 'unsafe_integer'],
    ['zero title limit', { ...intro.limits, maxRoomTitleBytes: 0 }, 'maxRoomTitleBytes', 'invalid_value'],
    ['negative body limit', { ...intro.limits, maxBodyBytes: -1 }, 'maxBodyBytes', 'invalid_value'],
    ['fractional body limit', { ...intro.limits, maxBodyBytes: 10.5 }, 'maxBodyBytes', 'unsafe_integer'],
    ['string body limit', { ...intro.limits, maxBodyBytes: '4096' }, 'maxBodyBytes', 'wrong_type'],
    ['unknown limit', { ...intro.limits, maxAttachmentBytes: 1 }, 'maxAttachmentBytes', 'unknown_field'],
  ])('refuses %s', (_name, input, path, code) => {
    expect(decodeContentLimits(input)).toEqual({ ok: false, error: { path, code } });
  });

  it('fails closed when forged limits reach a decoder anyway', () => {
    const forged = { maxBodyBytes: Number.NaN, maxDisplayNameBytes: undefined, maxRoomTitleBytes: -1 } as unknown as ContentLimits;
    expect(decodeMessageContent(intro.content, forged)).toEqual({ ok: false, error: { path: 'body', code: 'invalid_limits' } });
    expect(decodeParticipantView(intro.participants.agent, forged)).toEqual({ ok: false, error: { path: 'displayName', code: 'invalid_limits' } });
    expect(decodeRoomSummary({ roomId: 'room_demo', title: 'API review', membership: 'joined', revision: 'rev_1' }, forged))
      .toEqual({ ok: false, error: { path: 'title', code: 'invalid_limits' } });
  });
});

describe('view fixtures', () => {
  it.each(views.valid)('accepts: $name', async testCase => {
    const expected = 'expected' in testCase ? testCase.expected : testCase.input;
    expect(await decoders[testCase.decoder]!(testCase.input)).toEqual({ ok: true, value: expected });
  });

  it.each(views.invalid)('rejects: $name', async testCase => {
    expect(await decoders[testCase.decoder]!(testCase.input)).toEqual({ ok: false, error: testCase.error });
  });
});

describe('public surface', () => {
  it('does not expose fixtures or test helpers at runtime', () => {
    const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { exports: Record<string, string> };
    expect(Object.entries(packageJson.exports).filter(([key, target]) => /fixture/i.test(key + target))).toEqual([]);
    const indexSource = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    expect(indexSource).not.toMatch(/from '[^']*(fixtures|\.test)/);
    expect(Object.keys(messaging).filter(name => /fixture|fake/i.test(name))).toEqual([]);
  });
});
