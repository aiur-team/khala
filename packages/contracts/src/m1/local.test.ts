import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type Decoded, decodeWith } from '../messaging/decode';
import { readMatrixUserId, readRoomId } from './agent-join';
import { decodeInboxEntry } from './inbox';
import * as local from './local';

const roomId = '!c7Kq2vXbT1nP0aZ9yW3eQw:local';
const eventId = '$q3Zp0bE8yS1m4Vt7nC2aRw';
const owner = local.LOCAL_OWNER_USER_ID;
const agent = '@agent-a1b2c3d4:local';
const timestamp = '2026-10-02T00:00:00.000Z';
const token = 'a'.repeat(43);
const link = `http://127.0.0.1:47830/join/${token}`;
const openUrl = `http://127.0.0.1:47830/open/${token}`;
const event = (seq = 5) => ({ seq, eventId, roomId, type: 'm.room.message', sender: owner, ts: 1759395700000, txnId: 'web-7b1e', content: { msgtype: 'm.text', body: '@kevin-Codex can you review PR #12?' } });
const ownerMember = { userId: owner, participantId: owner, ownerId: local.LOCAL_OWNER_ID, deviceId: local.LOCAL_OWNER_DEVICE_ID, displayName: 'kevin', kind: 'human', membership: 'join' };
const agentMember = { ...ownerMember, userId: agent, participantId: agent, deviceId: 'KH_LOCAL_a1b2c3d4', displayName: 'kevin-Codex', kind: 'agent', harness: 'codex', ownerLabel: 'kevin', listeningMode: 'steer' };
const summary = { roomId, name: 'refactor', createdAt: timestamp, lastSeq: 5, lastTs: 1759395700000, preview: null, members: [{ userId: owner, displayName: 'kevin', kind: 'human' }] };
const created = { roomId, name: 'refactor', selfLink: link, shareLink: link, openUrl, expiresAt: timestamp };
const profile = { v: 1, username: 'kevin', color: 'teal', initials: null, updatedAt: timestamp };
const profileView = { userId: owner, ownerId: local.LOCAL_OWNER_ID, username: 'kevin', suggestion: 'kevin', color: 'teal', initials: null };
const helper = { v: 1, pid: 4242, port: 47830, origin: 'http://127.0.0.1:47830', adminToken: token, version: '0.0.0', startedAt: timestamp };
function rejected(result: Decoded<unknown>, path: string, code = 'invalid_value') {
  expect(result).toEqual({ ok: false, error: { path, code } });
}
function accepted<T>(decode: (input: unknown) => Decoded<T>, value: unknown) {
  expect(decode(value)).toEqual({ ok: true, value });
}

describe('local ids and pure encoders', () => {
  it('matches Node encoders for every tail length and random bytes', () => {
    for (let length = 0; length <= 40; length++) for (let n = 0; n < 50; n++) {
      const bytes = randomBytes(length);
      expect(local.base64url(bytes)).toBe(Buffer.from(bytes).toString('base64url'));
      expect(local.hex(bytes)).toBe(Buffer.from(bytes).toString('hex'));
    }
    expect(local.newLocalRoomId(new Uint8Array(16))).toBe('!AAAAAAAAAAAAAAAAAAAAAA:local');
    expect(local.newLocalAgentUserId(Uint8Array.of(0xa1, 0xb2, 0xc3, 0xd4))).toBe(agent);
    const descending = Uint8Array.from({ length: 16 }, (_, i) => 255 - i);
    expect(local.newLocalEventId(descending)).toBe('$__79_Pv6-fj39vX08_Lx8A');
  });
  it('generates ids compatible with hosted readers and the inbox', () => {
    for (let n = 0; n < 200; n++) {
      const room = local.newLocalRoomId(randomBytes(16));
      const user = local.newLocalAgentUserId(randomBytes(4));
      const id = local.newLocalEventId(randomBytes(16));
      expect(room).toHaveLength(29);
      expect(local.isLocalRoomId(room)).toBe(true);
      expect(local.isLocalAgentUserId(user)).toBe(true);
      expect(local.isLocalEventId(id)).toBe(true);
      expect(id).toMatch(/^\$\S+$/u);
      expect(decodeWith(() => readRoomId(room, 'r')).ok).toBe(true);
      expect(decodeWith(() => readMatrixUserId(user, 'u')).ok).toBe(true);
      expect(decodeInboxEntry({ eventId: id, roomId: room, ts: timestamp, sender: owner, senderLabel: 'kevin', senderKind: 'human', kind: 'message', body: 'x' }).ok).toBe(true);
    }
    expect(decodeWith(() => readMatrixUserId(owner, 'u')).ok).toBe(true);
  });
  it('guards random byte lengths and room keys', () => {
    expect(() => local.newLocalRoomId(new Uint8Array(15))).toThrow(RangeError);
    expect(() => local.newLocalAgentUserId(new Uint8Array(5))).toThrow(RangeError);
    expect(() => local.newLocalEventId(new Uint8Array(17))).toThrow(RangeError);
    expect(local.localRoomKey(roomId)).toBe('c7Kq2vXbT1nP0aZ9yW3eQw');
    for (const value of ['!../../etc:local', '!abc:local', '!c7Kq2vXbT1nP0aZ9yW3eQw:khala.local', '']) expect(() => local.localRoomKey(value)).toThrow(new RangeError('not_local_room'));
    expect(local.localAgentDeviceId(agent)).toBe('KH_LOCAL_a1b2c3d4');
    for (const value of [owner, '@agent-short:local', '@agent-a1b2c3d4:remote', '']) expect(() => local.localAgentDeviceId(value)).toThrow(new RangeError('not_local_agent'));
    expect(local.localRoomPath(roomId, 'events')).toBe(`/api/local/rooms/${encodeURIComponent(roomId)}/events`);
  });
  it('has no browser-incompatible globals or imports', () => {
    const source = readFileSync(new URL('./local.ts', import.meta.url), 'utf8');
    for (const pattern of [/\bBuffer\b/u, /\bbtoa\b/u, /\batob\b/u, /\bTextEncoder\b/u, /\bcrypto\b/u, /from ['"]node:/u, /\brequire\(/u]) expect(source).not.toMatch(pattern);
  });
});

describe('local events', () => {
  it('decodes the worked create log and expanded lines 2–7', () => {
    const first = JSON.parse('{"seq":1,"eventId":"$q3Zp0bE8yS1m4Vt7nC2aRw","roomId":"!c7Kq2vXbT1nP0aZ9yW3eQw:local","type":"m.room.create","sender":"@khala_owner:local","ts":1759395601000,"content":{"name":"refactor","createdBy":"@khala_owner:local"}}');
    accepted(local.decodeLocalEvent, first);
    const contents = [
      { type: 'm.room.member', sender: owner, content: { user: owner, membership: 'join', displayname: 'kevin', kind: 'human' } },
      { type: 'm.room.member', sender: owner, content: { user: agent, membership: 'invite', displayname: 'kevin-Codex', kind: 'agent', harness: 'codex', invitedBy: owner } },
      { type: 'm.room.member', sender: agent, content: { user: agent, membership: 'join', displayname: 'kevin-Codex', kind: 'agent', harness: 'codex', 'com.khala.listening_mode': 'sync' } },
      { type: 'm.room.message', sender: owner, txnId: 'web-7b1e', content: { msgtype: 'm.text', body: 'Review please' } },
      { type: 'com.khala.listening_mode.v1', sender: owner, content: { v: 1, agent, mode: 'steer' } },
      { type: 'm.room.member', sender: agent, content: { user: agent, membership: 'join', displayname: 'kevin-Codex', kind: 'agent', 'com.khala.listening_mode': 'steer' } },
    ];
    contents.forEach((fields, i) => accepted(local.decodeLocalEvent, { ...first, ...fields, seq: i + 2, eventId: local.newLocalEventId(Uint8Array.from({ length: 16 }, () => i)) }));
    accepted(local.decodeLocalCreateContent, { name: 'refactor', createdBy: owner, operationId: 'create-1' });
    accepted(local.decodeLocalEvent, { ...first, content: { ...first.content, operationId: 'create-1' } });
    accepted(local.decodeLocalEvent, { ...first, seq: 8, type: 'm.room.name', content: { name: 'new name' } });
    accepted(local.decodeLocalEvent, { ...first, seq: 9, type: 'com.khala.event.v1', content: { v: 1, arbitrary: 'nested decoder owns this' } });
  });
  it.each([
    [{ x: 1 }, 'x', 'unknown_field'], [{ seq: 0 }, 'seq', 'invalid_value'], [{ seq: 1.5 }, 'seq', 'unsafe_integer'],
    [{ eventId: '$short' }, 'eventId', 'invalid_value'], [{ roomId: '!abc:khala.local' }, 'roomId', 'invalid_value'],
    [{ sender: '@someone:local' }, 'sender', 'invalid_value'], [{ type: 'm.room.topic' }, 'type', 'invalid_value'],
    [{ txnId: 'has space' }, 'txnId', 'invalid_value'], [{ txnId: undefined }, 'txnId', 'wrong_type'],
    [{ content: { msgtype: 'm.image', body: 'x' } }, 'content.msgtype', 'invalid_value'],
    [{ content: { msgtype: 'm.text', body: 'a'.repeat(8001) } }, 'content.body', 'too_long'],
    [{ content: { msgtype: 'm.text', body: '' } }, 'content.body', 'empty'],
    [{ content: [] }, 'content', 'not_object'],
    [{ type: 'm.room.member', content: { user: owner, membership: 'join', displayname: 'kevin', kind: 'human', x: 1 } }, 'content.x', 'unknown_field'],
    [{ type: 'm.room.member', content: { user: owner, membership: 'join', displayname: 'kevin', kind: 'human', harness: 'codex' } }, 'content.harness', 'invalid_value'],
    [{ type: 'm.room.member', content: { user: owner, membership: 'join', displayname: 'kevin', kind: 'human', 'com.khala.listening_mode': 'sync' } }, 'content.com.khala.listening_mode', 'invalid_value'],
  ])('rejects event patch %j', (patch, path, code) => rejected(local.decodeLocalEvent({ ...event(), ...patch }), path, code));
  it('keeps message extension keys and checks both character and serialized byte limits', () => {
    const request = { txnId: 'kls-0b7c', type: 'm.room.message', content: { msgtype: 'm.text', body: 'hi' } };
    accepted(local.decodeLocalSendRequest, request);
    accepted(local.decodeLocalSendRequest, { ...request, content: { msgtype: 'm.notice', body: 'renamed', 'com.khala.agent_participant_id': agent } });
    accepted(local.decodeLocalSendRequest, { ...request, content: { msgtype: 'm.text', body: '😀'.repeat(4000) } });
    rejected(local.decodeLocalSendRequest({ ...request, txnId: 'a'.repeat(65) }), 'txnId');
    rejected(local.decodeLocalSendRequest({ ...request, type: 'm.room.member' }), 'type');
    rejected(local.decodeLocalSendRequest({ ...request, content: { msgtype: 'm.text', body: 'hi', data: 'a'.repeat(40000) } }), 'content', 'too_long');
    rejected(local.decodeLocalSendRequest({ ...request, content: { msgtype: 'm.text', body: '😀'.repeat(4001) } }), 'content.body', 'too_long');
    const circular: Record<string, unknown> = {}; circular['self'] = circular;
    rejected(local.decodeLocalSendRequest({ ...request, content: circular }), 'content');
  });
});

describe('local pages and members', () => {
  it('requires ascending pages with exact cursors and bounded lengths', () => {
    accepted(local.decodeLocalEventsPage, { events: [event(5), event(6)], next: 6 });
    rejected(local.decodeLocalEventsPage({ events: [event(5), event(6)], next: 5 }), 'next');
    rejected(local.decodeLocalEventsPage({ events: [event(6), event(5)], next: 5 }), 'events[1].seq');
    rejected(local.decodeLocalEventsPage({ events: [event(5), event(5)], next: 5 }), 'events[1].seq');
    accepted(local.decodeLocalEventsPage, { events: [], next: 9 });
    rejected(local.decodeLocalEventsPage({ events: Array.from({ length: 201 }, (_, i) => event(i + 1)), next: 201 }), 'events', 'too_long');
    accepted(local.decodeLocalHistoryPage, { events: [event(5), { ...event(6), type: 'com.khala.event.v1', content: { v: 1 } }], nextBefore: eventId });
    rejected(local.decodeLocalHistoryPage({ events: [{ ...event(), type: 'm.room.member', content: { user: owner, membership: 'join', displayname: 'kevin', kind: 'human' } }] }), 'events[0].type');
    rejected(local.decodeLocalHistoryPage({ events: [], nextBefore: '$x' }), 'nextBefore');
    rejected(local.decodeLocalHistoryPage({ events: Array.from({ length: 101 }, (_, i) => event(i + 1)) }), 'events', 'too_long');
    rejected(local.decodeLocalHistoryPage({ events: [event(6), event(5)] }), 'events[1].seq');
  });
  it('validates present members, agent attributes and duplicate ids', () => {
    accepted(local.decodeLocalMember, ownerMember);
    accepted(local.decodeLocalMember, agentMember);
    accepted(local.decodeLocalMembersResponse, { members: [ownerMember, agentMember] });
    rejected(local.decodeLocalMember({ ...agentMember, participantId: owner }), 'participantId');
    rejected(local.decodeLocalMember({ ...ownerMember, membership: 'leave' }), 'membership');
    rejected(local.decodeLocalMember({ ...ownerMember, deviceId: 'KH_LOCAL_a1b2c3d4' }), 'deviceId');
    rejected(local.decodeLocalMember({ ...agentMember, deviceId: 'KH_AGENT_a1b2c3d4' }), 'deviceId');
    for (const key of ['harness', 'ownerLabel', 'listeningMode']) rejected(local.decodeLocalMember({ ...ownerMember, [key]: agentMember[key as keyof typeof agentMember] }), key);
    rejected(local.decodeLocalMembersResponse({ members: [ownerMember, ownerMember] }), 'members[1].userId', 'duplicate');
    rejected(local.decodeLocalMembersResponse({ members: Array.from({ length: 101 }, () => ownerMember) }), 'members', 'too_long');
  });
});

// Every public decoder participates: happy paths plus strict/missing/optional tables.
const cases: { decode: (input: unknown) => Decoded<unknown>; value: Record<string, unknown>; optional?: Record<string, unknown> }[] = [
  { decode: local.decodeLocalCreateContent, value: { name: 'refactor', createdBy: owner }, optional: { operationId: 'op-1' } },
  { decode: local.decodeLocalNameContent, value: { name: 'refactor' } },
  { decode: local.decodeLocalMemberContent, value: { user: agent, membership: 'leave', displayname: 'kevin-Codex', kind: 'agent' }, optional: { harness: 'codex', invitedBy: owner, 'com.khala.listening_mode': 'sync' } },
  { decode: local.decodeLocalEvent, value: event(), optional: { txnId: 'txn-2' } },
  { decode: local.decodeLocalMe, value: { userId: agent, roomId, roomName: 'refactor', membership: 'invite', displayName: 'kevin-Codex' }, optional: { invitedBy: owner } },
  { decode: local.decodeLocalJoined, value: { seq: 3, ts: 0 } },
  { decode: local.decodeLocalEventsPage, value: { events: [], next: 0 } },
  { decode: local.decodeLocalHistoryPage, value: { events: [] }, optional: { nextBefore: eventId } },
  { decode: local.decodeLocalSendRequest, value: { txnId: 'txn-1', type: 'm.room.message', content: { msgtype: 'm.text', body: 'hi' } } },
  { decode: local.decodeLocalSendResult, value: { eventId } },
  { decode: local.decodeLocalMember, value: ownerMember },
  { decode: local.decodeLocalMember, value: { ...agentMember }, optional: { harness: 'claude', ownerLabel: 'kevin', listeningMode: 'async' } },
  { decode: local.decodeLocalMembersResponse, value: { members: [] } },
  { decode: local.decodeLocalChannelSummary, value: summary, optional: { lastSender: { userId: owner, displayName: 'kevin' } } },
  { decode: local.decodeLocalChannelsPage, value: { revision: 0, channels: [summary] } },
  { decode: local.decodeLocalChannelCreated, value: created },
  { decode: local.decodeLocalShareLink, value: { shareLink: link, expiresAt: timestamp } },
  { decode: local.decodeLocalOpenLink, value: { openUrl, expiresAt: timestamp } },
  { decode: local.decodeLocalRoomRef, value: { roomId } },
  { decode: local.decodeLocalHealth, value: { ok: true, version: '0.0.0', pid: 4242 } },
  { decode: local.decodeLocalErrorBody, value: { error: 'not_found' } },
  { decode: local.decodeOwnerProfile, value: profile },
  { decode: local.decodeOwnerProfileView, value: profileView },
  { decode: local.decodeOwnerUsernameResult, value: { username: 'kevin' } },
  { decode: local.decodeOwnerColorResult, value: { color: 'teal' } },
  { decode: local.decodeOwnerInitialsResult, value: { initials: null } },
  { decode: local.decodeHelperFile, value: helper },
  { decode: local.decodeChannelSecrets, value: { v: 1, links: {}, members: {} } },
];
describe('strict wire and record decoders', () => {
  it.each(cases)('$decode.name preserves valid values', ({ decode, value, optional }) => {
    accepted(decode, value);
    if (optional) accepted(decode, { ...value, ...optional });
  });
  it.each(cases)('$decode.name rejects unknown, missing and explicit undefined fields', ({ decode, value, optional }) => {
    rejected(decode({ ...value, extra: true }), 'extra', 'unknown_field');
    for (const key of Object.keys(value)) {
      if (key in (optional ?? {})) continue;
      const missing = { ...value }; delete missing[key];
      rejected(decode(missing), key, 'missing_field');
    }
    for (const key of Object.keys(optional ?? {})) expect(decode({ ...value, [key]: undefined }).ok).toBe(false);
    expect(decode(null).ok).toBe(false);
    expect(decode([]).ok).toBe(false);
    expect(decode(new Date()).ok).toBe(false);
  });
  it('validates channels, canonical initials, helper records and secrets', () => {
    rejected(local.decodeLocalChannelSummary({ ...summary, createdAt: '2026-10-02' }), 'createdAt');
    rejected(local.decodeLocalChannelCreated({ ...created, openUrl: link }), 'openUrl');
    rejected(local.decodeLocalChannelCreated({ ...created, name: 'a'.repeat(65) }), 'name', 'too_long');
    rejected(local.decodeLocalChannelCreated({ ...created, name: ' padded' }), 'name');
    accepted(local.decodeLocalChannelCreated, { ...created, name: '😀'.repeat(64) });
    rejected(local.decodeLocalChannelCreated({ ...created, name: '😀'.repeat(65) }), 'name', 'too_long');
    accepted(local.decodeLocalChannelSummary, { ...summary, members: [{ userId: agent, displayName: 'kevin-Codex', kind: 'agent', harness: 'codex' }] });
    rejected(local.decodeLocalChannelSummary({ ...summary, members: [{ ...summary.members[0], harness: 'codex' }] }), 'members[0].harness');
    rejected(local.decodeLocalChannelSummary({ ...summary, lastSender: { userId: owner, displayName: 'kevin', extra: true } }), 'lastSender.extra', 'unknown_field');
    rejected(local.decodeLocalChannelSummary({ ...summary, members: [{ ...summary.members[0], extra: true }] }), 'members[0].extra', 'unknown_field');
    rejected(local.decodeOwnerProfile({ ...profile, username: 'kevin-Claude' }), 'username');
    for (const [decode, value] of [[local.decodeOwnerProfile, profile], [local.decodeOwnerProfileView, profileView]] as const) {
      accepted<unknown>(decode, { ...value, initials: 'KV' });
      const { initials: _initials, ...missing } = value;
      expect(_initials).toBeNull();
      rejected(decode(missing), 'initials', 'missing_field');
      for (const initials of ['K', 'kv', ' KV', undefined]) rejected(decode({ ...value, initials }), 'initials');
    }
    accepted(local.decodeOwnerInitialsResult, { initials: 'KV' });
    rejected(local.decodeOwnerProfileView({ ...profileView, userId: '@x:local' }), 'userId');
    rejected(local.decodeHelperFile({ ...helper, origin: 'http://localhost:47830' }), 'origin');
    rejected(local.decodeHelperFile({ ...helper, port: 70000 }), 'port');
    rejected(local.decodeHelperFile({ ...helper, port: 0 }), 'port');
    rejected(local.decodeHelperFile({ ...helper, pid: 0 }), 'pid');
    rejected(local.decodeHelperFile({ ...helper, adminToken: 'short' }), 'adminToken');
    rejected(local.decodeLocalHealth({ ok: false, version: '0.0.0', pid: 4242 }), 'ok');
    const hash = 'a'.repeat(64);
    accepted(local.decodeChannelSecrets, { v: 1, links: { [hash]: { expiresAt: timestamp, consumedAt: timestamp, kind: 'join' } }, members: { [agent]: { tokenSha256: hash } } });
    rejected(local.decodeChannelSecrets({ v: 1, links: { ABC: {} }, members: {} }), 'links.ABC');
    rejected(local.decodeChannelSecrets({ v: 1, links: {}, members: { [owner]: { tokenSha256: hash } } }), `members.${owner}`);
    rejected(local.decodeChannelSecrets({ v: 1, links: {}, members: { [agent]: { tokenSha256: 'bad' } } }), `members.${agent}.tokenSha256`);
    rejected(local.decodeChannelSecrets({ v: 1, links: { [hash]: { expiresAt: timestamp, consumedAt: undefined, kind: 'join' } }, members: {} }), `links.${hash}.consumedAt`, 'wrong_type');
    rejected(local.decodeChannelSecrets({ v: 1, links: { [hash]: { expiresAt: timestamp, kind: 'join', x: 1 } }, members: {} }), `links.${hash}.x`, 'unknown_field');
  });
});

it('preserves validated previous membership for rename delivery', () => {
  const previousContent = { user: agent, membership: 'join', displayname: 'kevin-Codex', kind: 'agent', harness: 'codex' };
  const value = { seq: 4, eventId, roomId, sender: owner, ts: 1759395600000, type: 'm.room.member',
    content: { ...previousContent, displayname: 'reviewer' }, previousContent };
  expect(local.decodeLocalEvent(value)).toEqual({ ok: true, value });
  expect(local.decodeLocalEvent({ ...value, previousContent: { ...previousContent, membership: 'invalid' } }).ok).toBe(false);
});

it('decodes events pages and cached profiles for existing registry-suffixed owners', () => {
  accepted(local.decodeOwnerProfile, { ...profile, username: 'bob-Gemini' });
  accepted(local.decodeOwnerProfileView, { ...profileView, username: 'bob-Gemini' });
  const page = { events: [{ ...event(), type: 'm.room.member', content: { user: owner, membership: 'join',
    displayname: 'bob-Gemini', kind: 'human' } }], next: 5 };
  accepted(local.decodeLocalEventsPage, page);
  accepted(local.decodeLocalMembersResponse, { members: [{ ...agentMember, ownerLabel: 'bob-Gemini' }] });
});

it.each(['gemini', 'opencode', 'cline'])('opens every local harness decoder to %s', harness => {
  const content = { user: agent, membership: 'join', displayname: 'Agent', kind: 'agent', harness };
  accepted(local.decodeLocalMemberContent, content);
  accepted(local.decodeLocalMember, { ...agentMember, harness });
  const member = { userId: agent, displayName: 'Agent', kind: 'agent', harness };
  accepted(local.decodeLocalChannelSummary, { ...summary, members: [member] });
  accepted(local.decodeLocalMembersResponse, { members: [{ ...agentMember, harness }] });
  const e = { ...event(), type: 'm.room.member', content, previousContent: { ...content, membership: 'invite' } };
  accepted(local.decodeLocalEventsPage, { events: [e], next: e.seq });
});
