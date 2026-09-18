import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import intro from '../../fixtures/messaging/exact-intro.json';
import invalid from '../../fixtures/messaging/invalid.json';
import views from '../../fixtures/messaging/views.json';
import { decodeAdmission, decodeInviteState, decodeShareGrant } from './admission';
import { decodeControlRecord } from './control-store';
import type { Decoded } from './decode';
import { decodeDeviceView } from './devices';
import { decodeEventRef, decodeMessageContent, decodeTimelineItem } from './events';
import { decodeAuthPrincipal, decodeParticipantView, decodeSessionBinding } from './identity';
import * as messaging from './index';
import { decodeRecoveryCapabilities, decodeRecoveryStatus } from './recovery';
import { decodeRevocationProgress, decodeRevocationRequest } from './revocation';
import { decodeRoomSnapshot, decodeRoomSummary, decodeSendState, decodeTimelinePage } from './rooms';

const limits = intro.limits;
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
    expect(Object.keys(intro.binding).sort()).toEqual(['agentParticipantId', 'bindingId', 'deviceId', 'generation', 'harness', 'ownerId', 'sessionId']);
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
