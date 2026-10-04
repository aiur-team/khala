import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { getEventListeners } from 'node:events';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import {
  LOCAL_OWNER_USER_ID, LOCAL_LINK_TTL_MS, isLocalRoomId, localRoomKey, newLocalEventId,
  type LocalEvent, type LocalMemberContent, type OwnerProfile,
} from '@khala/contracts/m1/local';
import { StateError } from '../state';
import { openLocalStore, LocalStoreError, type OpenedLocalStore } from './store';

const ownerDefault: OwnerProfile = { v: 1, username: 'kevin', color: 'teal', initials: null, updatedAt: '2025-10-02T09:00:00.000Z' };
const agent = '@agent-a1b2c3d4:local';
const sha256 = (token: string) => createHash('sha256').update(token).digest('hex');
let tmp: string;
let root: string;
let store: OpenedLocalStore;
let clock: number;
let counter: number;
const random = (n: number) => { const bytes = new Uint8Array(n); new DataView(bytes.buffer).setUint32(0, ++counter); return bytes; };
const roomDir = (roomId: string) => path.join(root, 'channels', localRoomKey(roomId));
const logPath = (roomId: string) => path.join(roomDir(roomId), 'log.jsonl');
const message = (body: string, txnId?: string, sender = LOCAL_OWNER_USER_ID as string) => ({
  type: 'm.room.message' as const, sender, content: { msgtype: 'm.text', body }, ...(txnId !== undefined ? { txnId } : {}),
});
async function reopen(): Promise<void> {
  await store.close();
  store = await openLocalStore({ root, ownerDefault, now: () => clock, random });
}
async function membership(roomId: string, content: Partial<LocalMemberContent> = {}): Promise<LocalEvent> {
  return store.append(roomId, { type: 'm.room.member', sender: LOCAL_OWNER_USER_ID, content: {
    user: agent, membership: 'join', displayname: 'kevin-Claude', kind: 'agent', harness: 'claude', ...content,
  } });
}
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'khala-store-'));
  root = path.join(tmp, 'khala/local');
  clock = 1759395600000;
  counter = 0;
  store = await openLocalStore({ root, ownerDefault, now: () => clock, random });
});
afterEach(async () => {
  vi.useRealTimers();
  await store?.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

test('creates a channel with exactly one owner join, summary, secrets and two revision increments', async () => {
  const { roomId, created } = await store.createChannel('refactor');
  expect(created).toBe(true);
  expect(isLocalRoomId(roomId)).toBe(true);
  const events = store.eventsAfter(roomId, 0, 10);
  expect(events.map(e => [e.seq, e.type])).toEqual([[1, 'm.room.create'], [2, 'm.room.member']]);
  expect(events[0]!.content).toEqual({ name: 'refactor', createdBy: LOCAL_OWNER_USER_ID });
  expect(events[1]!.content).toEqual({ user: LOCAL_OWNER_USER_ID, membership: 'join', displayname: 'kevin', kind: 'human' });
  expect(store.members(roomId)[0]).toStrictEqual({ userId: LOCAL_OWNER_USER_ID, participantId: LOCAL_OWNER_USER_ID,
    ownerId: 'local-owner', deviceId: 'KH_LOCAL_OWNER', displayName: 'kevin', kind: 'human', membership: 'join' });
  expect(store.revision()).toBe(2);
  expect(store.listChannels()).toEqual([{ roomId, name: 'refactor', createdAt: ownerDefault.updatedAt,
    lastSeq: 2, lastTs: clock, preview: null, members: [{ userId: LOCAL_OWNER_USER_ID, displayName: 'kevin', kind: 'human' }] }]);
  expect(JSON.parse(await fs.readFile(path.join(roomDir(roomId), 'secrets.json'), 'utf8'))).toEqual({ v: 1, links: {}, members: {} });
});

test('deduplicates concurrent operations and rebuilds the operation index on replay', async () => {
  const [a, b] = await Promise.all([store.createChannel('a', 'op-1'), store.createChannel('b', 'op-1')]);
  expect(a.created).toBe(true);
  expect(b).toEqual({ roomId: a.roomId, created: false });
  expect(await fs.readdir(path.join(root, 'channels'))).toHaveLength(1);
  expect(store.findByOperation('op-1')).toBe(a.roomId);
  expect(store.eventsAfter(a.roomId, 0, 1)[0]!.content.operationId).toBe('op-1');
  await reopen();
  expect(store.findByOperation('op-1')).toBe(a.roomId);
  expect(await store.createChannel('c', 'op-1')).toEqual(b);
  expect(store.revision()).toBe(0);
});

test('replays history, names, all member states, modes, tokens, links and owner profile exactly', async () => {
  const { roomId } = await store.createChannel('refactor', 'replay');
  await membership(roomId, { membership: 'invite', invitedBy: LOCAL_OWNER_USER_ID });
  await membership(roomId, { 'com.khala.listening_mode': 'sync' });
  await store.append(roomId, message('hello', 'web-1'));
  await store.append(roomId, { type: 'com.khala.listening_mode.v1', sender: LOCAL_OWNER_USER_ID, content: { v: 1, agent, mode: 'steer' } });
  expect(store.member(roomId, agent)?.listeningMode).toBe('sync');
  await membership(roomId, { 'com.khala.listening_mode': 'steer' });
  await membership(roomId, { displayname: 'kev-bot', 'com.khala.listening_mode': 'steer' });
  await store.append(roomId, { type: 'm.room.name', sender: LOCAL_OWNER_USER_ID, content: { name: 'refactor-2' } });
  const token = 'T'.repeat(43);
  await store.setMemberToken(roomId, agent, sha256(token));
  const link = await store.mintLink(roomId, 'join');
  await store.setOwner({ ...ownerDefault, initials: 'KW' });
  const snapshot = () => ({ summaries: store.listChannels(), members: store.members(roomId), owner: store.owner(),
    human: store.member(roomId, LOCAL_OWNER_USER_ID), agent: store.member(roomId, agent), events: store.eventsAfter(roomId, 0, 200),
    history: store.history(roomId, undefined, 100), name: store.channelName(roomId), channel: store.channelOfMember(agent), auth: store.agentForToken(token) });
  const before = snapshot();
  await reopen();
  expect(snapshot()).toStrictEqual(before);
  expect(store.revision()).toBe(0);
  expect(await store.consumeLink(link.token)).toEqual({ roomId });
  const duplicate = await store.append(roomId, message('changed', 'web-1'));
  expect(duplicate.content.body).toBe('hello');
  expect(store.revision()).toBe(0);
});

test('loads the worked example from hand-written disk files', async () => {
  await store.close();
  const roomId = '!c7Kq2vXbT1nP0aZ9yW3eQw:local';
  await fs.mkdir(roomDir(roomId), { mode: 0o700 });
  const contents: [LocalEvent['type'], Record<string, unknown>][] = [
    ['m.room.create', { name: 'refactor', createdBy: LOCAL_OWNER_USER_ID }],
    ['m.room.member', { user: LOCAL_OWNER_USER_ID, membership: 'join', displayname: 'kevin', kind: 'human' }],
    ['m.room.member', { user: agent, membership: 'invite', displayname: 'kevin-Claude', kind: 'agent', harness: 'claude', invitedBy: LOCAL_OWNER_USER_ID }],
    ['m.room.member', { user: agent, membership: 'join', displayname: 'kevin-Claude', kind: 'agent', harness: 'claude' }],
    ['m.room.message', { msgtype: 'm.text', body: '@kevin-Codex can you review PR #12?' }],
    ['com.khala.listening_mode.v1', { v: 1, agent, mode: 'steer' }],
    ['m.room.member', { user: agent, membership: 'join', displayname: 'kevin-Claude', kind: 'agent', harness: 'claude', 'com.khala.listening_mode': 'steer' }],
  ];
  const events = contents.map(([type, content], i): LocalEvent => ({ seq: i + 1, eventId: newLocalEventId(random(16)), roomId, type,
    sender: i === 3 || i === 6 ? agent : LOCAL_OWNER_USER_ID, ts: 1759395601000 + i * 30000,
    ...(i === 4 ? { txnId: 'web-7b1e' } : {}), content }));
  const token = 'A'.repeat(43);
  await fs.writeFile(logPath(roomId), events.map(e => JSON.stringify(e) + '\n').join(''), { mode: 0o600 });
  await fs.writeFile(path.join(roomDir(roomId), 'secrets.json'), JSON.stringify({ v: 1,
    links: { [sha256(token)]: { expiresAt: '2025-10-02T09:10:01.000Z', kind: 'join' } }, members: { [agent]: { tokenSha256: sha256('member') } } }), { mode: 0o600 });
  await fs.writeFile(path.join(root, 'owner.json'), JSON.stringify(ownerDefault), { mode: 0o600 });
  clock = 1759395900000;
  await reopen();
  expect(store.channelName(roomId)).toBe('refactor');
  expect(store.members(roomId).map(m => [m.userId, m.deviceId, m.listeningMode])).toEqual([
    [LOCAL_OWNER_USER_ID, 'KH_LOCAL_OWNER', undefined], [agent, 'KH_LOCAL_a1b2c3d4', 'steer'],
  ]);
  expect(store.channelSummary(roomId)).toMatchObject({ preview: contents[4]![1].body, lastSeq: 7,
    lastSender: { userId: LOCAL_OWNER_USER_ID, displayName: 'kevin' } });
  expect(store.history(roomId, undefined, 50)).toEqual({ events: [events[4]] });
  expect(store.channelOfMember(agent)).toBe(roomId);
  expect(await store.append(roomId, message('dup', 'web-7b1e'))).toStrictEqual(events[4]);
  expect(store.revision()).toBe(0);
  expect(await store.consumeLink(token)).toEqual({ roomId });
  expect(await store.consumeLink(token)).toBeNull();
});

test('deduplicates concurrent sender/txn pairs inside the queue, but not across senders', async () => {
  const { roomId } = await store.createChannel('dedup');
  const rev = store.revision();
  const [a, b] = await Promise.all([store.append(roomId, message('a', 'same')), store.append(roomId, message('b', 'same'))]);
  expect(a).toStrictEqual(b);
  expect(store.revision()).toBe(rev + 1);
  expect((await fs.readFile(logPath(roomId), 'utf8')).trimEnd().split('\n')).toHaveLength(3);
  const other = await store.append(roomId, message('other', 'same', agent));
  expect(other.seq).toBe(a.seq + 1);
  expect(store.eventsAfter(roomId, 0, 10)).toHaveLength(4);
});

test('does not modify a torn log at open; truncates it before the next append', async () => {
  const { roomId } = await store.createChannel('torn');
  await store.append(roomId, message('three'));
  await store.close();
  await fs.appendFile(logPath(roomId), '{"seq":4,"eventId":"$x');
  const bytes = await fs.readFile(logPath(roomId));
  await reopen();
  expect(store.eventsAfter(roomId, 0, 10)).toHaveLength(3);
  expect(await fs.readFile(logPath(roomId))).toEqual(bytes);
  expect((await store.append(roomId, message('four'))).seq).toBe(4);
  const lines = (await fs.readFile(logPath(roomId), 'utf8')).trimEnd().split('\n');
  expect(lines).toHaveLength(4);
  for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  await reopen();
  expect(store.eventsAfter(roomId, 0, 10)).toHaveLength(4);
});

test('skips invalid middle records and non-increasing or wrong-room records during replay', async () => {
  const { roomId } = await store.createChannel('mixed');
  const third = await store.append(roomId, message('valid'));
  await store.close();
  const lines = (await fs.readFile(logPath(roomId), 'utf8')).trimEnd().split('\n');
  await fs.writeFile(logPath(roomId), [lines[0], 'not json', JSON.stringify({ ...third, roomId: '!AAAAAAAAAAAAAAAAAAAAAA:local' }),
    lines[1], lines[0], lines[2], '{}', 'broken final line'].join('\n') + '\n');
  await reopen();
  expect(store.eventsAfter(roomId, 0, 10).map(e => e.seq)).toEqual([1, 2, 3]);
  expect((await store.append(roomId, message('next'))).seq).toBe(4);
  await reopen();
  expect(store.eventsAfter(roomId, 0, 10).map(e => e.seq)).toEqual([1, 2, 3, 4]);
});

test('opens without writing owner files; invalid owner and secrets use defaults', async () => {
  expect(store.owner()).toEqual(ownerDefault);
  await expect(fs.stat(path.join(root, 'owner.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  await store.setOwner(store.owner());
  expect((await fs.stat(path.join(root, 'owner.json'))).mode & 0o777).toBe(0o600);
  const { roomId } = await store.createChannel('invalid');
  await store.close();
  await fs.writeFile(path.join(root, 'owner.json'), JSON.stringify({ ...ownerDefault, initials: undefined }));
  await fs.writeFile(path.join(roomDir(roomId), 'secrets.json'), '{"bad":true}');
  await reopen();
  expect(store.owner()).toEqual(ownerDefault);
  expect(await fs.readFile(path.join(roomDir(roomId), 'secrets.json'), 'utf8')).toBe('{"bad":true}');
  expect(store.agentForToken('unknown')).toBeNull();
  await store.mintLink(roomId, 'join');
});

test('persists only link hashes and consumes each link at most once under concurrency and after restart', async () => {
  const { roomId } = await store.createChannel('link');
  const { token, expiresAt } = await store.mintLink(roomId, 'join');
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  const disk = await fs.readFile(path.join(roomDir(roomId), 'secrets.json'), 'utf8');
  expect(disk).toContain(sha256(token));
  expect(disk).not.toContain(token);
  expect(expiresAt).toBe(new Date(clock + LOCAL_LINK_TTL_MS).toISOString());
  const outcomes = await Promise.all([store.consumeLink(token), store.consumeLink(token)]);
  expect(outcomes.filter(Boolean)).toEqual([{ roomId }]);
  expect(outcomes.filter(v => v === null)).toHaveLength(1);
  await reopen();
  expect(await store.consumeLink(token)).toBeNull();
});

test('refuses expired links at the precise TTL boundary and unknown or malformed tokens', async () => {
  const { roomId } = await store.createChannel('expiry');
  const first = await store.mintLink(roomId, 'join');
  clock += LOCAL_LINK_TTL_MS;
  expect(await store.consumeLink(first.token)).toBeNull();
  const second = await store.mintLink(roomId, 'join');
  clock += LOCAL_LINK_TTL_MS - 1;
  expect(await store.consumeLink(second.token)).toEqual({ roomId });
  for (const token of ['short', 'x'.repeat(43), '+'.repeat(43)]) expect(await store.consumeLink(token)).toBeNull();
});

test('retains member tokens across leave and replay, revokes explicitly, and never authenticates the owner', async () => {
  const { roomId } = await store.createChannel('token');
  await membership(roomId);
  const token = 'T'.repeat(43);
  await store.setMemberToken(roomId, agent, sha256(token));
  expect(store.agentForToken(token)).toEqual({ roomId, userId: agent });
  expect(store.agentForToken('x'.repeat(43))).toBeNull();
  await membership(roomId, { membership: 'leave' });
  expect(store.member(roomId, agent)?.membership).toBe('leave');
  expect(store.members(roomId)).toHaveLength(1);
  expect(store.channelOfMember(agent)).toBe(roomId);
  expect(store.channelOfMember(LOCAL_OWNER_USER_ID)).toBeUndefined();
  await reopen();
  expect(store.member(roomId, agent)?.membership).toBe('leave');
  expect(store.agentForToken(token)).toEqual({ roomId, userId: agent });
  await store.setMemberToken(roomId, agent, null);
  expect(store.agentForToken(token)).toBeNull();
  await store.setMemberToken(roomId, LOCAL_OWNER_USER_ID, sha256(token));
  expect(store.agentForToken(token)).toBeNull();
});

test('deletes files and indexes, retains token tombstones and wakes waiters; unknown deletes are no-ops', async () => {
  const { roomId } = await store.createChannel('delete', 'delete-op');
  await membership(roomId);
  await store.setMemberToken(roomId, agent, sha256('token'));
  const { token } = await store.mintLink(roomId, 'join');
  const rev = store.revision();
  const signal = new AbortController().signal;
  const eventWait = store.waitForEvent(roomId, 3, 10000, signal);
  const revisionWait = store.waitForRevision(rev, 10000, signal);
  await store.deleteChannel(roomId);
  await Promise.all([eventWait, revisionWait]);
  expect(getEventListeners(signal, 'abort')).toEqual([]);
  await expect(fs.stat(roomDir(roomId))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(store.hasChannel(roomId)).toBe(false);
  expect(store.findByOperation('delete-op')).toBeUndefined();
  expect(store.channelOfMember(agent)).toBeUndefined();
  expect(store.agentForToken('token')).toEqual({ roomId, userId: agent });
  expect(store.agentForToken('unknown')).toBeNull();
  expect(await store.consumeLink(token)).toBeNull();
  await expect(store.append(roomId, message('gone'))).rejects.toMatchObject({ code: 'not_found' });
  expect(store.revision()).toBe(rev + 1);
  await store.deleteChannel(roomId);
  expect(store.revision()).toBe(rev + 1);
  await reopen();
  expect(store.listChannels()).toEqual([]);
  expect(store.agentForToken('token')).toBeNull();
});

test('uses 0700 directories and 0600 files, allowing a 0755 XDG parent and rejecting unsafe owned directories', async () => {
  const { roomId } = await store.createChannel('permissions');
  await store.mintLink(roomId, 'join');
  await store.setOwner(store.owner());
  for (const dir of [path.join(tmp, 'khala'), root, path.join(root, 'channels'), roomDir(roomId)]) {
    expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
  }
  for (const file of [logPath(roomId), path.join(roomDir(roomId), 'secrets.json'), path.join(root, 'owner.json')]) {
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  }
  await fs.chmod(tmp, 0o755);
  await reopen();
  await store.close();
  await fs.chmod(path.join(root, 'channels'), 0o755);
  await expect(openLocalStore({ root, ownerDefault })).rejects.toBeInstanceOf(StateError);
  await expect(openLocalStore({ root, ownerDefault })).rejects.toMatchObject({ code: 'unsafe_state_dir' });
});

test('waiters resolve on timeout, ready conditions, abort, append and close without timers or listeners', async () => {
  vi.useFakeTimers();
  const { roomId } = await store.createChannel('wait');
  const controller = new AbortController();
  const signal = controller.signal;
  const assertClean = () => { expect(getEventListeners(signal, 'abort')).toEqual([]); expect(vi.getTimerCount()).toBe(0); };
  for (const makeWait of [() => store.waitForRevision(store.revision(), 50, signal), () => store.waitForEvent(roomId, 2, 50, signal)]) {
    const waiting = makeWait();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(49);
    expect(getEventListeners(signal, 'abort')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await waiting; assertClean();
  }
  await store.waitForRevision(store.revision() - 1, 10000, signal);
  await store.waitForEvent(roomId, 1, 10000, signal);
  await store.waitForEvent('unknown', 2, 10000, signal); assertClean();
  const revisionWait = store.waitForRevision(store.revision(), 10000, signal);
  const eventWait = store.waitForEvent(roomId, 2, 10000, signal);
  await store.append(roomId, message('wake'));
  await Promise.all([revisionWait, eventWait]); assertClean();
  const abortWait = store.waitForRevision(store.revision(), 10000, signal);
  const abortEvent = store.waitForEvent(roomId, 3, 10000, signal);
  controller.abort();
  await Promise.all([abortWait, abortEvent]); assertClean();
  await store.waitForRevision(store.revision(), 10000, signal);
  await store.waitForEvent(roomId, 3, 10000, signal); assertClean();
  const closeSignal = new AbortController().signal;
  const closingWaits = [store.waitForRevision(store.revision(), 10000, closeSignal), store.waitForEvent(roomId, 3, 10000, closeSignal)];
  await store.close(); await Promise.all(closingWaits);
  expect(getEventListeners(closeSignal, 'abort')).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
  await store.close();
  await store.waitForRevision(store.revision(), 10000, closeSignal);
  await expect(store.append(roomId, message('closed'))).rejects.toMatchObject({ code: 'storage_failed' });
});

test('history pages only messages and channel events in chronological order and accepts any event as the cutoff', async () => {
  const { roomId } = await store.createChannel('history');
  const candidates: LocalEvent[] = [];
  for (let i = 0; i < 5; i++) {
    candidates.push(await store.append(roomId, message(String(i))));
    await membership(roomId);
  }
  candidates.push(await store.append(roomId, { type: 'com.khala.event.v1', sender: agent,
    content: { v: 1, kind: 'message', summary: 'channel event', body: 'channel event' } }));
  const first = store.history(roomId, undefined, 2);
  expect(first.events).toEqual(candidates.slice(-2));
  expect(first.nextBefore).toBe(candidates[4]!.eventId);
  let page = first;
  let all = [...page.events];
  while (page.nextBefore) { page = store.history(roomId, page.nextBefore, 2); all = [...page.events, ...all]; }
  expect(all).toEqual(candidates);
  expect(page).not.toHaveProperty('nextBefore');
  expect(store.history(roomId, '$unknown', 100)).toEqual({ events: [] });
  const memberEvent = store.eventsAfter(roomId, 0, 200)[3]!;
  expect(store.history(roomId, memberEvent.eventId, 100)).toEqual({ events: [candidates[0]] });
  expect(store.eventsAfter(roomId, 4, 2).map(e => e.seq)).toEqual([5, 6]);
});

test('orders channels by activity, sequence and room id', async () => {
  const a = await store.createChannel('a');
  clock++;
  const b = await store.createChannel('b');
  expect(store.listChannels().map(c => c.roomId)).toEqual([b.roomId, a.roomId]);
  clock++;
  await store.append(a.roomId, message('recent'));
  expect(store.listChannels().map(c => c.roomId)).toEqual([a.roomId, b.roomId]);
  await store.append(b.roomId, message('tie'));
  expect(store.listChannels().map(c => c.roomId)).toEqual([a.roomId, b.roomId].sort());
  await store.append(b.roomId, message('sequence'));
  expect(store.listChannels()[0]!.roomId).toBe(b.roomId);
});

test('uses live owner names and last member display names, default modes and first membership order', async () => {
  const { roomId } = await store.createChannel('names');
  await membership(roomId, { membership: 'invite' });
  const other = '@agent-11223344:local';
  await membership(roomId, { user: other, displayname: 'second', harness: 'codex' });
  await membership(roomId, { displayname: 'renamed' });
  expect(store.members(roomId).map(m => m.userId)).toEqual([LOCAL_OWNER_USER_ID, agent, other]);
  expect(store.member(roomId, agent)?.listeningMode).toBe('sync');
  await store.append(roomId, message('owner says'));
  const rev = store.revision();
  await store.setOwner({ ...store.owner(), username: 'kev' });
  expect(store.revision()).toBe(rev + 1);
  expect(store.members(roomId)[0]!.displayName).toBe('kev');
  expect(store.channelSummary(roomId)?.members[0]?.displayName).toBe('kev');
  expect(store.channelSummary(roomId)?.lastSender?.displayName).toBe('kev');
  expect(store.member(roomId, agent)?.ownerLabel).toBe('kev');
  await store.append(roomId, message('agent says', undefined, agent));
  expect(store.channelSummary(roomId)?.lastSender?.displayName).toBe('renamed');
});

test('maps failed atomic writes and recovers the queue without changing secrets or owner memory', async () => {
  const { roomId } = await store.createChannel('failure');
  const link = await store.mintLink(roomId, 'join');
  await store.close();
  await reopen();
  await fs.chmod(roomDir(roomId), 0o500);
  try {
    await expect(store.mintLink(roomId, 'join')).rejects.toMatchObject({ code: 'storage_failed' });
    await expect(store.consumeLink(link.token)).rejects.toBeInstanceOf(LocalStoreError);
  } finally { await fs.chmod(roomDir(roomId), 0o700); }
  expect(await store.consumeLink(link.token)).toEqual({ roomId });
  await fs.chmod(root, 0o500);
  const rev = store.revision();
  try { await expect(store.setOwner({ ...ownerDefault, username: 'failed' })).rejects.toMatchObject({ code: 'storage_failed' }); }
  finally { await fs.chmod(root, 0o700); }
  expect(store.owner()).toEqual(ownerDefault);
  expect(store.revision()).toBe(rev);
  await store.setOwner({ ...ownerDefault, username: 'recovered' });
  expect(store.owner().username).toBe('recovered');
});

test('returns empty values for missing rooms and rejects their writes', async () => {
  const roomId = '!unknownunknownunknown0:local';
  expect(store.channelSummary(roomId)).toBeUndefined();
  expect(store.member(roomId, agent)).toBeUndefined();
  expect(store.members(roomId)).toEqual([]);
  expect(store.eventsAfter(roomId, 0, 10)).toEqual([]);
  expect(store.history(roomId, undefined, 10)).toEqual({ events: [] });
  expect(store.channelName(roomId)).toBe('');
  for (const write of [store.append(roomId, message('missing')), store.mintLink(roomId, 'join'), store.setMemberToken(roomId, agent, sha256('token'))]) {
    await expect(write).rejects.toMatchObject({ code: 'not_found' });
  }
});

test('owns input and output values so callers cannot mutate persisted state', async () => {
  const { roomId } = await store.createChannel('copies');
  const input = message('original', 'copy');
  const pending = store.append(roomId, input);
  input.content.body = 'mutated';
  const event = await pending;
  expect(event.content.body).toBe('original');
  event.content.body = 'mutated output';
  store.eventsAfter(roomId, 0, 10)[0]!.content.name = 'mutated name';
  store.owner().username = 'mutated owner';
  expect(store.owner()).toEqual(ownerDefault);
  expect((await store.append(roomId, message('dup', 'copy'))).content.body).toBe('original');
  await reopen();
  expect(store.channelName(roomId)).toBe('copies');
  expect(store.history(roomId, undefined, 10).events[0]?.content.body).toBe('original');
});

test('skips orphan folders and avoids colliding with their room ids', async () => {
  await store.close();
  const key = 'AAAAAAAAAAAAAAAAAAAAAA';
  await fs.mkdir(path.join(root, 'channels', key), { mode: 0o700 });
  const badKey = 'BBBBBBBBBBBBBBBBBBBBBB';
  await fs.mkdir(path.join(root, 'channels', badKey), { mode: 0o700 });
  await fs.writeFile(path.join(root, 'channels', badKey, 'log.jsonl'), JSON.stringify({ seq: 1, eventId: newLocalEventId(random(16)),
    roomId: `!${badKey}:local`, type: 'm.room.message', sender: LOCAL_OWNER_USER_ID, ts: clock, content: { msgtype: 'm.text', body: 'orphan' } }) + '\n', { mode: 0o600 });
  let calls = 0;
  store = await openLocalStore({ root, ownerDefault, now: () => clock, random: n => ++calls === 1 ? new Uint8Array(n) : random(n) });
  expect(store.listChannels()).toEqual([]);
  const created = await store.createChannel('unique');
  expect(localRoomKey(created.roomId)).not.toBe(key);
  expect(store.listChannels()).toHaveLength(1);
});

test('future event cursors keep waiting until crossed, timeout, deletion or close', async () => {
  vi.useFakeTimers();
  const { roomId } = await store.createChannel('future');
  const signal = new AbortController().signal;
  let resolved = false;
  const waiting = store.waitForEvent(roomId, 4, 10000, signal).then(() => { resolved = true; });
  await store.append(roomId, message('three'));
  expect(resolved).toBe(false);
  await store.append(roomId, message('four'));
  expect(resolved).toBe(false);
  await store.append(roomId, message('five'));
  await waiting;
  expect(resolved).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  expect(getEventListeners(signal, 'abort')).toEqual([]);
  const deleteWait = store.waitForEvent(roomId, 100, 10000, signal);
  await store.deleteChannel(roomId);
  await deleteWait;
  expect(vi.getTimerCount()).toBe(0);
  const another = await store.createChannel('close');
  const closeWait = store.waitForEvent(another.roomId, 100, 10000, signal);
  await store.close();
  await closeWait;
  expect(vi.getTimerCount()).toBe(0);
  expect(getEventListeners(signal, 'abort')).toEqual([]);
});

test('normalizes initialization storage failures while preserving unsafe directory errors', async () => {
  await store.close();
  await fs.mkdir(path.join(root, 'owner.json'), { mode: 0o700 });
  await expect(openLocalStore({ root, ownerDefault })).rejects.toBeInstanceOf(LocalStoreError);
  await expect(openLocalStore({ root, ownerDefault })).rejects.toMatchObject({ code: 'storage_failed' });
  await fs.rm(path.join(root, 'owner.json'), { recursive: true });
  await fs.rm(root, { recursive: true, force: true });
  await fs.chmod(path.join(tmp, 'khala'), 0o500);
  try { await expect(openLocalStore({ root, ownerDefault })).rejects.toBeInstanceOf(LocalStoreError); }
  finally { await fs.chmod(path.join(tmp, 'khala'), 0o700); }
});

test('repairs a live partial append on retry without indexing or deduplicating the failed write', async () => {
  const { roomId } = await store.createChannel('partial');
  const events = store.eventsAfter(roomId, 0, 10);
  const revision = store.revision();
  // Fault injection stays on the real FileHandle prototype; all disk writes remain real.
  const probe = await fs.open(path.join(tmp, 'probe'), 'w', 0o600);
  const prototype = Object.getPrototypeOf(probe) as fs.FileHandle;
  await probe.close();
  const writeFile = prototype.writeFile;
  const spy = vi.spyOn(prototype, 'writeFile').mockImplementationOnce(async function (this: fs.FileHandle) {
    await this.write('{"seq":3,"partial":');
    throw Object.assign(new Error('injected disk failure'), { code: 'EIO' });
  });
  try {
    await expect(store.append(roomId, message('failed', 'retry'))).rejects.toMatchObject({ code: 'storage_failed' });
    expect(store.eventsAfter(roomId, 0, 10)).toEqual(events);
    expect(store.revision()).toBe(revision);
    spy.mockImplementation(writeFile);
    const retried = await store.append(roomId, message('recovered', 'retry'));
    expect(retried.seq).toBe(3);
    expect(retried.content.body).toBe('recovered');
    expect(store.revision()).toBe(revision + 1);
    expect(await store.append(roomId, message('duplicate', 'retry'))).toEqual(retried);
    const lines = (await fs.readFile(logPath(roomId), 'utf8')).trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines.map(line => JSON.parse(line))).toEqual([...events, retried]);
    await reopen();
    expect(store.eventsAfter(roomId, 0, 10)).toEqual([...events, retried]);
  } finally { spy.mockRestore(); }
});

test('rolls back a failed create and drains queued writes on close', async () => {
  const probe = await fs.open(path.join(tmp, 'probe'), 'w', 0o600);
  const prototype = Object.getPrototypeOf(probe) as fs.FileHandle;
  await probe.close();
  const writeFile = prototype.writeFile;
  let calls = 0;
  const spy = vi.spyOn(prototype, 'writeFile').mockImplementation(async function (this: fs.FileHandle, ...args: Parameters<fs.FileHandle['writeFile']>) {
    if (++calls === 2) throw new Error('injected second-event failure');
    return writeFile.apply(this, args);
  });
  try {
    await expect(store.createChannel('failed', 'failed-op')).rejects.toMatchObject({ code: 'storage_failed' });
    expect(store.listChannels()).toEqual([]);
    expect(store.findByOperation('failed-op')).toBeUndefined();
    expect(store.revision()).toBe(0);
    expect(await fs.readdir(path.join(root, 'channels'))).toEqual([]);
  } finally { spy.mockRestore(); }
  const { roomId } = await store.createChannel('recovered', 'failed-op');
  const pending = [store.append(roomId, message('queued one')), store.append(roomId, message('queued two'))];
  const closing = store.close();
  await expect(store.append(roomId, message('late'))).rejects.toMatchObject({ code: 'storage_failed' });
  await closing;
  const results = await Promise.all(pending);
  expect(results.map(e => e.seq)).toEqual([3, 4]);
  await reopen();
  expect(store.eventsAfter(roomId, 0, 10).map(e => e.seq)).toEqual([1, 2, 3, 4]);
});

test('persists session membership across helper restarts and rotates the credential', async () => {
  const { roomId } = await store.createChannel('Rejoin');
  await membership(roomId, { displayname: 'Helper', 'com.khala.listening_mode': 'async' });
  await store.setMemberToken(roomId, agent, sha256('old'), sha256('codex:thread'));
  await reopen();
  expect(store.memberForSession(roomId, sha256('codex:thread'))).toMatchObject({ userId: agent, displayName: 'Helper', listeningMode: 'async' });
  expect(store.memberForSession(roomId, sha256('codex:other'))).toBeUndefined();
  await store.setMemberToken(roomId, agent, sha256('new'), sha256('codex:thread'));
  expect(store.agentForToken('old')).toBeNull();
  expect(store.agentForToken('new')).toEqual({ roomId, userId: agent });
});

test('projects renames into history across pagination and helper restart', async () => {
  const { roomId } = await store.createChannel('renames');
  await membership(roomId);
  const first = await membership(roomId, { displayname: 'reviewer' });
  await membership(roomId, { displayname: 'reviewer', 'com.khala.listening_mode': 'async' });
  const second = await membership(roomId, { displayname: 'writer' });
  const expected = { events: [expect.objectContaining({ eventId: second.eventId, type: 'com.khala.event.v1', content: expect.objectContaining({ summary: 'reviewer is now writer' }) })], nextBefore: second.eventId };
  expect(store.history(roomId, undefined, 1)).toEqual(expected);
  expect(store.history(roomId, second.eventId, 1)).toEqual({ events: [expect.objectContaining({ eventId: first.eventId, content: expect.objectContaining({ summary: 'kevin-Claude is now reviewer' }) })] });
  await reopen();
  expect(store.history(roomId, undefined, 1)).toEqual(expected);
});

test('owner rename routes and username cascades produce readable rename events', async () => {
  const { profileRoutes } = await import('./routes/profile');
  const { ownerRoutes, serial } = await import('./routes/owner');
  const { roomRoutes } = await import('./routes/rooms');
  const { roomId } = await store.createChannel('cascade');
  await membership(roomId);
  const queue = serial();
  const routes = [...profileRoutes({ queue }), ...ownerRoutes({ queue }), ...roomRoutes()];
  const ctx = { store, now: () => clock } as unknown as import('./types').HelperContext;
  const call = async (method: import('./types').LocalRequest['method'], path: string, body?: unknown) => {
    const route = routes.find(r => r.method === method && r.pattern.test(path))!;
    const params = route.pattern.exec(path)!.slice(1);
    return route.handle({ method, path, body, query: new URLSearchParams(), headers: {},
      auth: { kind: 'owner', via: 'admin' }, origin: 'http://127.0.0.1:47830', signal: new AbortController().signal }, params, ctx);
  };
  expect((await call('POST', '/api/local/profile/username', { username: 'kev' })).status).toBe(200);
  expect((await call('POST', `/api/local/agents/${encodeURIComponent(agent)}/name`, { name: 'reviewer' })).status).toBe(200);
  const history = await call('GET', `/api/local/rooms/${encodeURIComponent(roomId)}/messages`);
  expect(history).toMatchObject({ status: 200, json: { events: [
    { type: 'com.khala.event.v1', content: { summary: 'kevin is now kev' } },
    { type: 'com.khala.event.v1', content: { summary: 'kevin-Claude is now kev-Claude' } },
    { type: 'com.khala.event.v1', content: { summary: 'kev-Claude is now reviewer' } },
  ] } });
  await call('POST', '/api/local/profile/username', { username: 'kev' });
  await call('POST', `/api/local/agents/${encodeURIComponent(agent)}/name`, { name: 'reviewer' });
  expect(store.history(roomId, undefined, 100).events).toHaveLength(3);
});

test('event delivery carries canonical previous membership across restarts', async () => {
  const { roomId } = await store.createChannel('race');
  const joined = await membership(roomId);
  const rename = await membership(roomId, { displayname: 'reviewer' });
  const result = () => store.eventsAfter(roomId, joined.seq, 10);
  const expected = [{ ...rename, previousContent: joined.content }];
  expect(result()).toEqual(expected);
  await reopen();
  expect(result()).toEqual(expected);
});
