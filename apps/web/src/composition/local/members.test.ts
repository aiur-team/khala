import { describe, expect, it, vi } from 'vitest';
import { LOCAL_OWNER_ID, LOCAL_OWNER_USER_ID, type LocalMember } from '@khala/contracts/m1/local';
import { decodeContentLimits } from '@khala/contracts/messaging/decode';
import { decodeRoomId } from '@khala/contracts/messaging/ids';
import { createLocalHttp, type LocalHttp } from './http';
import { createLocalMembers } from './members';

const room = decodeRoomId('!c7Kq2vXbT1nP0aZ9yW3eQw:local');
if (!room.ok) throw new Error('fixture room');
const roomId = room.value;
const decodedLimits = decodeContentLimits({ maxBodyBytes: 8000, maxDisplayNameBytes: 128, maxRoomTitleBytes: 256 });
if (!decodedLimits.ok) throw new Error('fixture limits');
const limits = decodedLimits.value;
const owner: LocalMember = { userId: LOCAL_OWNER_USER_ID, participantId: LOCAL_OWNER_USER_ID,
  ownerId: LOCAL_OWNER_ID, deviceId: 'KH_LOCAL_OWNER', displayName: 'kevin', kind: 'human', membership: 'join' };
const agent: LocalMember = { userId: '@agent-b2c3d4e5:local', participantId: '@agent-b2c3d4e5:local',
  ownerId: LOCAL_OWNER_ID, deviceId: 'KH_LOCAL_b2c3d4e5', displayName: 'kevin-Codex', kind: 'agent',
  harness: 'codex', ownerLabel: 'kevin', membership: 'join', listeningMode: 'sync' };
const claude: LocalMember = { ...agent, userId: '@agent-a1b2c3d4:local', participantId: '@agent-a1b2c3d4:local',
  deviceId: 'KH_LOCAL_a1b2c3d4', displayName: 'kevin-Claude', harness: 'claude' };
function setup() {
  let payload: unknown = { members: [owner, agent, claude] };
  let failure = false;
  const get = vi.fn<LocalHttp['get']>().mockImplementation(async (...args) => {
    const decode = args[1];
    if (failure) return { kind: 'unavailable' };
    const result = decode(payload);
    return result.ok ? { kind: 'ok', value: result.value } : { kind: 'error', status: 200, code: 'invalid_response' };
  });
  const send = vi.fn<LocalHttp['send']>().mockImplementation(async (...args) => {
    const decode = args[3];
    const result = decode({ eventId: '$c7Kq2vXbT1nP0aZ9yW3eQw' });
    return result.ok ? { kind: 'ok', value: result.value } : { kind: 'unavailable' };
  });
  const cache = createLocalMembers({ origin: 'http://localhost:47830', get: get as LocalHttp['get'], send: send as LocalHttp['send'] }, limits);
  return { cache, get, send, payload: (value: unknown) => { payload = value; }, fail: () => { failure = true; } };
}

describe('local members', () => {
  it('loads room members and stable known participants with Matrix user ids', async () => {
    const { cache, get } = setup();
    expect(cache.members(roomId)).toBeUndefined();
    expect(cache.describe(agent.userId)).toBeUndefined();
    expect(cache.listeningMode(roomId, agent.userId)).toBe('sync');
    expect(get).not.toHaveBeenCalled();
    await cache.refresh(roomId);
    expect(get).toHaveBeenCalledWith('/api/local/rooms/!c7Kq2vXbT1nP0aZ9yW3eQw%3Alocal/members', expect.any(Function));
    expect(cache.members(roomId)).toEqual([owner, agent, claude]);
    expect(cache.describe(agent.userId)).toEqual({ matrixUserId: agent.userId, participantId: agent.userId,
      ownerId: LOCAL_OWNER_ID, displayName: 'kevin-Codex', kind: 'agent', ownerLabel: 'kevin', harness: 'codex' });
    expect(cache.describeMatrixUser(agent.userId)).toBe(cache.describe(agent.userId));
    expect(cache.describe(owner.userId)).toEqual({ matrixUserId: owner.userId, participantId: owner.userId,
      ownerId: LOCAL_OWNER_ID, displayName: 'kevin', kind: 'human' });
  });
  it('shares concurrent refreshes and only notifies on room signature changes', async () => {
    const { cache, get, payload } = setup();
    const listener = vi.fn(); const unsubscribe = cache.subscribeListeningModes(roomId, listener);
    const first = cache.refresh(roomId); const second = cache.refresh(roomId);
    expect(first).toBe(second);
    await Promise.all([first, second]);
    expect(get).toHaveBeenCalledTimes(1); expect(listener).toHaveBeenCalledTimes(1);
    await cache.refresh(roomId); expect(listener).toHaveBeenCalledTimes(1);
    payload({ members: [claude, agent, owner] });
    await cache.refresh(roomId); expect(listener).toHaveBeenCalledTimes(1);
    payload({ members: [owner, { ...agent, listeningMode: 'steer' }, claude] });
    await cache.refresh(roomId); expect(listener).toHaveBeenCalledTimes(2);
    expect(cache.listeningMode(roomId, agent.userId)).toBe('steer');
    expect(cache.listeningMode(roomId, 'unknown')).toBe('sync');
    unsubscribe(); payload({ members: [] }); await cache.refresh(roomId);
    expect(listener).toHaveBeenCalledTimes(2);
  });
  it('keeps attribution for departed members and updates names on refresh', async () => {
    const { cache, payload, fail } = setup(); await cache.refresh(roomId);
    payload({ members: [owner, { ...agent, displayName: 'new-name' }] }); await cache.refresh(roomId);
    expect(cache.describe(agent.userId)?.displayName).toBe('new-name');
    payload({ members: [owner] }); await cache.refresh(roomId);
    expect(cache.members(roomId)).toEqual([owner]);
    expect(cache.describe(agent.userId)?.displayName).toBe('new-name');
    const previous = cache.members(roomId); fail(); await cache.refresh(roomId);
    expect(cache.members(roomId)).toBe(previous);
  });
  it('keeps a newer subscription when an old disposer is called twice', async () => {
    const { cache } = setup(); const old = cache.subscribe(roomId, vi.fn()); old();
    const listener = vi.fn(); cache.subscribe(roomId, listener); old();
    await cache.refresh(roomId); expect(listener).toHaveBeenCalledTimes(1);
  });
  it('does not fabricate a participant without a harness and falls back to the owner label', async () => {
    const { cache, payload } = setup();
    const { harness: _harness, ownerLabel: _label, ...bare } = agent;
    void _harness; void _label;
    payload({ members: [owner, bare] }); await cache.refresh(roomId);
    expect(cache.members(roomId)).toEqual([owner, bare]); expect(cache.describe(agent.userId)).toBeUndefined();
    payload({ members: [owner, { ...bare, harness: 'codex' }] }); await cache.refresh(roomId);
    expect(cache.describe(agent.userId)).toMatchObject({ ownerLabel: 'kevin' });
    payload({ members: [{ ...bare, harness: 'codex' }] }); await cache.refresh(roomId);
    expect(cache.describe(agent.userId)).toMatchObject({ ownerLabel: 'owner' });
  });
  it('sends modes without optimistically changing the confirmed mode', async () => {
    const { cache, send } = setup(); await cache.refresh(roomId);
    expect(await cache.setListeningMode(roomId, agent.userId, 'steer', 'txn_9f')).toBe('sent');
    expect(send).toHaveBeenCalledExactlyOnceWith('POST', '/api/local/channels/!c7Kq2vXbT1nP0aZ9yW3eQw%3Alocal/mode',
      { agent: agent.userId, mode: 'steer', txnId: 'txn_9f' }, expect.any(Function));
    expect(cache.listeningMode(roomId, agent.userId)).toBe('sync');
    send.mockResolvedValue({ kind: 'error', status: 404, code: 'not_found' });
    expect(await cache.setListeningMode(roomId, agent.userId, 'async', 'txn_2')).toBe('failed');
    send.mockRejectedValue(new Error('transport'));
    expect(await cache.setListeningMode(roomId, agent.userId, 'async', 'txn_3')).toBe('failed');
  });
  it.each([['not-an-id', 'txn_1'], [agent.userId, ''], [agent.userId, 'a'.repeat(65)], [agent.userId, 'invalid txn']])(
    'rejects invalid mode command %s %s without a request', async (id, txn) => {
      const { cache, send } = setup(); expect(await cache.setListeningMode(roomId, id, 'steer', txn)).toBe('failed');
      expect(send).not.toHaveBeenCalled();
    });
  it('refreshes and validates participant views, preserving prior data after failure', async () => {
    const { cache, get, fail } = setup();
    expect(await cache.roomParticipants(roomId)).toEqual([owner, agent, claude].map(m => ({ participantId: m.userId,
      kind: m.kind, ownerId: LOCAL_OWNER_ID, displayName: m.displayName, deviceIds: [m.deviceId] })));
    await cache.roomParticipants(roomId); expect(get).toHaveBeenCalledTimes(2);
    fail(); expect(await cache.roomParticipants(roomId)).toHaveLength(3);
    const controller = new AbortController(); controller.abort();
    expect(await cache.roomParticipants(roomId, controller.signal)).toBeNull();
    const fresh = setup(); fresh.fail(); expect(await fresh.cache.roomParticipants(roomId)).toBeNull();
    expect(fresh.cache.members(roomId)).toBeUndefined();
    fresh.get.mockRejectedValue(new Error('transport')); await expect(fresh.cache.refresh(roomId)).resolves.toBeUndefined();
  });
  it('rejects the entire roster when a view violates content limits', async () => {
    const { get, send } = setup();
    const small = decodeContentLimits({ maxBodyBytes: 8000, maxDisplayNameBytes: 5, maxRoomTitleBytes: 256 });
    if (!small.ok) throw new Error('limits');
    const cache = createLocalMembers({ origin: 'http://localhost:47830', get: get as LocalHttp['get'], send: send as LocalHttp['send'] }, small.value);
    expect(await cache.roomParticipants(roomId)).toBeNull();
  });
  it('uses the real HTTP mutation header and strict response decoder', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({ eventId: '$c7Kq2vXbT1nP0aZ9yW3eQw' }),
      { headers: { 'content-type': 'application/json' } }));
    const cache = createLocalMembers(createLocalHttp({ origin: 'http://localhost:47830', fetch }), limits);
    expect(await cache.setListeningMode(roomId, agent.userId, 'async', 'txn_4')).toBe('sent');
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/mode'), expect.objectContaining({
      headers: expect.objectContaining({ 'x-khala-local': '1' }), credentials: 'same-origin',
    }));
  });
});
