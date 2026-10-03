import { describe, expect, it, vi } from 'vitest';
import { LOCAL_OWNER_ID, LOCAL_OWNER_USER_ID, decodeOwnerProfileView, type LocalMember, type OwnerProfile } from '@khala/contracts/m1/local';
import { LISTENING_MODE_MEMBER_KEY } from '@khala/contracts/m1/listening-mode';
import type { HelperContext, LocalAuth, LocalRequest, LocalStore } from '../types';
import { serial, type SerialQueue } from './owner';
import { profileRoutes } from './profile';

const now = Date.parse('2026-10-02T09:00:00.000Z');
function member(userId: string, displayName: string, harness?: 'claude' | 'codex'): LocalMember {
  return { userId, participantId: userId, ownerId: LOCAL_OWNER_ID, deviceId: userId === LOCAL_OWNER_USER_ID ? 'KH_LOCAL_OWNER' : `KH_LOCAL_${userId.slice(7, 15)}`,
    displayName, kind: harness ? 'agent' : 'human', membership: 'join', ...(harness ? { harness } : {}) };
}
function setup(channels: Record<string, LocalMember[]> = {}, queue?: SerialQueue) {
  let owner: OwnerProfile = { v: 1, username: 'kevin', color: 'blue', initials: null, updatedAt: '2026-10-01T00:00:00.000Z' };
  const writes: OwnerProfile[] = [];
  let seq = 0;
  const append = vi.fn<LocalStore['append']>(async (roomId, input) => {
    const m = channels[roomId]?.find(m => m.userId === input.content['user']);
    if (m) m.displayName = input.content['displayname'] as string;
    return { seq: ++seq, eventId: '$AAAAAAAAAAAAAAAAAAAAAA', roomId, type: input.type, sender: input.sender, ts: now, content: input.content };
  });
  const store = {
    owner: vi.fn(() => owner),
    setOwner: vi.fn(async (next: OwnerProfile) => { owner = next; writes.push(next); }),
    listChannels: vi.fn(() => Object.keys(channels).map(roomId => ({ roomId }))),
    members: vi.fn((roomId: string) => (channels[roomId] ?? []).map(m => ({ ...m }))), append,
  };
  // The routes depend only on these store/context capabilities; no HTTP or disk store is imported.
  const ctx = { store, now: () => now } as unknown as HelperContext;
  const routes = queue ? profileRoutes({ queue }) : profileRoutes();
  async function request(path = '', body?: unknown, auth: LocalAuth = { kind: 'owner', via: 'cookie' }) {
    const req: LocalRequest = { method: path ? 'POST' : 'GET', path: `/api/local/profile${path}`, query: new URLSearchParams(),
      headers: {}, body, auth, origin: 'http://127.0.0.1:47830', signal: new AbortController().signal };
    const route = routes.find(r => r.method === req.method && r.pattern.test(req.path));
    if (!route) throw new Error('route_missing');
    const response = await route.handle(req, [], ctx);
    if ('location' in response) throw new Error('unexpected_redirect');
    return response;
  }
  return { request, store, writes, append, owner: () => owner, routes };
}

describe('local owner profile routes', () => {
  it('exposes four exact routes and a contract-compatible session profile', async () => {
    const s = setup();
    expect(s.routes).toHaveLength(4);
    for (const r of s.routes) {
      expect(r.pattern.test('/api/local/profile/username/extra')).toBe(false);
      expect(r.pattern.test('/api/local/profile/')).toBe(false);
    }
    const response = await s.request();
    expect(response).toEqual({ status: 200, json: { userId: LOCAL_OWNER_USER_ID, ownerId: LOCAL_OWNER_ID,
      username: 'kevin', suggestion: 'kevin', color: 'blue', initials: null } });
    expect(decodeOwnerProfileView(response.json).ok).toBe(true);
    await s.request('/initials', { initials: 'kw' });
    expect((await s.request()).json).toMatchObject({ initials: 'KW' });
  });

  it.each(['', '/username', '/color', '/initials'])('gates %s before reading or changing the store', async path => {
    const s = setup();
    expect(await s.request(path, {}, { kind: 'none' })).toEqual({ status: 401, json: { error: 'unauthorized' } });
    expect(await s.request(path, {}, { kind: 'agent', userId: '@agent-a1b2c3d4:local', roomId: 'a' }))
      .toEqual({ status: 403, json: { error: 'forbidden' } });
    expect(s.store.owner).not.toHaveBeenCalled();
    expect(s.store.setOwner).not.toHaveBeenCalled();
  });

  it.each(['cookie', 'admin'] as const)('accepts owner auth via %s', async via => {
    const s = setup();
    const auth: LocalAuth = { kind: 'owner', via };
    expect((await s.request('', undefined, auth)).status).toBe(200);
    expect(await s.request('/username', { username: 'kev' }, auth)).toEqual({ status: 200, json: { username: 'kev' } });
    expect(await s.request('/color', { color: 'teal' }, auth)).toEqual({ status: 200, json: { color: 'teal' } });
    expect(await s.request('/initials', { initials: 'kw' }, auth)).toEqual({ status: 200, json: { initials: 'KW' } });
  });

  it.each(['/username', '/color', '/initials'])('requires an exact single-key body for %s', async path => {
    const s = setup();
    for (const body of [undefined, null, [], 'value', {}, { [path.slice(1)]: 'kw', extra: true }]) {
      expect(await s.request(path, body)).toEqual({ status: 400, json: { error: 'invalid_request' } });
    }
    expect(s.writes).toEqual([]);
  });

  it.each([
    ['k', 'too_short'], ['k'.repeat(25), 'too_long'], ['bad name', 'invalid_characters'],
    [42, 'invalid_characters'], ['kevin-Claude', 'reserved'],
  ])('returns the hosted username error for %s', async (username, reason) => {
    const s = setup();
    expect(await s.request('/username', { username })).toEqual({ status: 400, json: { error: 'invalid_username', reason } });
    expect(s.writes).toEqual([]);
  });

  it('normalizes usernames and timestamps only actual changes', async () => {
    const s = setup();
    expect(await s.request('/username', { username: ' kev ' })).toEqual({ status: 200, json: { username: 'kev' } });
    await s.request('/color', { color: 'teal' });
    await s.request('/initials', { initials: 'kw' });
    expect(s.owner()).toEqual({ v: 1, username: 'kev', color: 'teal', initials: 'KW', updatedAt: new Date(now).toISOString() });
    await s.request('/username', { username: 'kev' });
    await s.request('/color', { color: 'teal' });
    await s.request('/initials', { initials: 'KW' });
    expect(s.writes).toHaveLength(3);
    expect(s.store.listChannels).toHaveBeenCalledTimes(1);
  });

  it.each(['mauve', null, 1])('rejects invalid color %s', async color => {
    expect(await setup().request('/color', { color })).toEqual({ status: 400, json: { error: 'invalid_color' } });
  });

  it.each([['kw', 'KW'], ['e\u0301w', 'ÉW'], ['k2', 'K2'], ['猫犬', '猫犬']])('normalizes initials %s', async (initials, expected) => {
    const s = setup();
    expect(await s.request('/initials', { initials })).toEqual({ status: 200, json: { initials: expected } });
    expect(s.owner().initials).toBe(expected);
    expect(await s.request('/initials', { initials: null })).toEqual({ status: 200, json: { initials: null } });
    expect(s.owner().initials).toBeNull();
    expect(Object.hasOwn(s.owner(), 'initials')).toBe(true);
    await s.request('/initials', { initials: null });
    expect(s.writes).toHaveLength(2);
  });

  it.each(['K', 'ABC', 'K!', '🙂K', '', 42, undefined])('rejects invalid initials %s', async initials => {
    expect(await setup().request('/initials', { initials })).toEqual({ status: 400, json: { error: 'invalid_initials' } });
  });

  it('renames owners and default agents across channels, preserving suffixes, invitations and modes', async () => {
    const s = setup({
      a: [member(LOCAL_OWNER_USER_ID, 'kevin'), { ...member('@agent-a1b2c3d4:local', 'kevin-Claude', 'claude'), listeningMode: 'steer' },
        { ...member('@agent-b2c3d4e5:local', 'kevin-Codex-2', 'codex'), membership: 'invite' }, member('@agent-c3d4e5f6:local', 'reviewer', 'claude')],
      b: [member(LOCAL_OWNER_USER_ID, 'kevin'), member('@agent-d4e5f6a7:local', 'kevin-Claude', 'claude'), member('@agent-e5f6a7b8:local', 'KEV-Claude', 'codex')],
      c: [member('@agent-f6a7b8c9:local', 'kevin-Codex-3', 'codex')],
    });
    expect(await s.request('/username', { username: 'kev' })).toEqual({ status: 200, json: { username: 'kev' } });
    expect(s.append.mock.calls.map(([room, event]) => [room, event.content])).toEqual([
      ['a', { user: LOCAL_OWNER_USER_ID, membership: 'join', displayname: 'kev', kind: 'human' }],
      ['a', { user: '@agent-a1b2c3d4:local', membership: 'join', displayname: 'kev-Claude', kind: 'agent', harness: 'claude', [LISTENING_MODE_MEMBER_KEY]: 'steer' }],
      ['a', { user: '@agent-b2c3d4e5:local', membership: 'invite', displayname: 'kev-Codex-2', kind: 'agent', harness: 'codex', [LISTENING_MODE_MEMBER_KEY]: 'sync' }],
      ['b', { user: LOCAL_OWNER_USER_ID, membership: 'join', displayname: 'kev', kind: 'human' }],
      ['b', { user: '@agent-d4e5f6a7:local', membership: 'join', displayname: 'kev-Claude-2', kind: 'agent', harness: 'claude', [LISTENING_MODE_MEMBER_KEY]: 'sync' }],
      ['c', { user: '@agent-f6a7b8c9:local', membership: 'join', displayname: 'kev-Codex-3', kind: 'agent', harness: 'codex', [LISTENING_MODE_MEMBER_KEY]: 'sync' }],
    ]);
    expect(s.append.mock.calls.every(([, e]) => e.sender === LOCAL_OWNER_USER_ID && e.type === 'm.room.member')).toBe(true);
  });

  it('skips unsafe suffixes, mismatched harnesses and missing harnesses', async () => {
    const s = setup({ a: [member('@agent-a1b2c3d4:local', 'kevin-Claude-0', 'claude'),
      member('@agent-b2c3d4e5:local', 'kevin-Claude-99999999999999999999', 'claude'),
      member('@agent-c3d4e5f6:local', 'kevin-Claude', 'codex'), { ...member('@agent-d4e5f6a7:local', 'kevin-Claude'), kind: 'agent' }] });
    await s.request('/username', { username: 'kev' });
    expect(s.append).not.toHaveBeenCalled();
  });

  it('keeps failed agent names reserved and continues agents and channels after failures', async () => {
    const s = setup({
      broken: [member(LOCAL_OWNER_USER_ID, 'kevin')],
      a: [member('@agent-a1b2c3d4:local', 'kevin-Claude', 'claude'), member('@agent-b2c3d4e5:local', 'kevin-Claude-2', 'claude')],
      b: [member(LOCAL_OWNER_USER_ID, 'kevin')],
    });
    s.store.members.mockImplementation(room => {
      if (room === 'broken') throw new Error('unavailable');
      if (room === 'a') return [member('@agent-a1b2c3d4:local', 'kevin-Claude', 'claude'), member('@agent-b2c3d4e5:local', 'kevin-Claude-2', 'claude')];
      return [member(LOCAL_OWNER_USER_ID, 'kevin')];
    });
    s.append.mockRejectedValueOnce(new Error('unavailable'));
    expect((await s.request('/username', { username: 'KEVIN' })).status).toBe(200);
    expect(s.append.mock.calls.map(([, e]) => e.content['displayname'])).toEqual(['KEVIN-Claude', 'KEVIN-Claude-2', 'KEVIN']);
  });

  it('continues agents when an owner member append fails', async () => {
    const s = setup({ a: [member(LOCAL_OWNER_USER_ID, 'kevin'), member('@agent-a1b2c3d4:local', 'kevin-Claude', 'claude')] });
    s.append.mockRejectedValueOnce(new Error('unavailable'));
    expect((await s.request('/username', { username: 'kev' })).status).toBe(200);
    expect(s.append.mock.calls.map(([, e]) => e.content['displayname'])).toEqual(['kev', 'kev-Claude']);
  });

  it('reserves each successful fallback for later agents', async () => {
    const s = setup({ a: [member('@agent-a1b2c3d4:local', 'kevin-Claude-2', 'claude'),
      member('@agent-b2c3d4e5:local', 'kevin-Claude', 'claude'), member('@agent-c3d4e5f6:local', 'KEV-Claude-2', 'codex'),
      { ...member('@agent-d4e5f6a7:local', 'custom', 'codex'), listeningMode: 'async' }] });
    await s.request('/username', { username: 'kev' });
    expect(s.append.mock.calls.map(([, e]) => e.content['displayname'])).toEqual(['kev-Claude', 'kev-Claude-3']);
  });

  it('restores a failed rename reservation before allocating another agent', async () => {
    const s = setup({ a: [member('@agent-a1b2c3d4:local', 'kevin-Claude', 'claude'),
      member('@agent-b2c3d4e5:local', 'kevin-Claude-1', 'claude')] });
    s.append.mockRejectedValueOnce(new Error('unavailable'));
    await s.request('/username', { username: 'KEVIN' });
    expect(s.append.mock.calls.map(([, e]) => e.content['displayname'])).toEqual(['KEVIN-Claude', 'KEVIN-Claude-2']);
  });

  it('returns success if channel listing fails after persisting the username', async () => {
    const s = setup();
    s.store.listChannels.mockImplementation(() => { throw new Error('unavailable'); });
    expect(await s.request('/username', { username: 'kev' })).toEqual({ status: 200, json: { username: 'kev' } });
    expect(s.owner().username).toBe('kev');
  });

  it.each(['', '/username', '/color', '/initials'])('maps owner read failure for %s to unavailable', async path => {
    const s = setup();
    s.store.owner.mockImplementation(() => { throw new Error('unavailable'); });
    const body = path === '/username' ? { username: 'kev' } : path === '/color' ? { color: 'teal' } : { initials: 'kw' };
    expect(await s.request(path, body)).toEqual({ status: 503, json: { error: 'unavailable' } });
  });

  it('recovers the queue after a write fails', async () => {
    const s = setup();
    s.store.setOwner.mockRejectedValueOnce(new Error('unavailable'));
    expect(await s.request('/username', { username: 'kev' })).toEqual({ status: 503, json: { error: 'unavailable' } });
    expect(await s.request('/color', { color: 'teal' })).toEqual({ status: 200, json: { color: 'teal' } });
  });

  it('waits for an injected queue before persisting or appending a username cascade', async () => {
    const queue = serial();
    let release!: () => void;
    const held = queue(() => new Promise<void>(resolve => { release = resolve; }));
    await Promise.resolve();
    const s = setup({ a: [member(LOCAL_OWNER_USER_ID, 'kevin'), member('@agent-a1b2c3d4:local', 'kevin-Claude', 'claude')] }, queue);
    const pending = s.request('/username', { username: 'kev' });
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(s.store.setOwner).not.toHaveBeenCalled();
      expect(s.append).not.toHaveBeenCalled();
    } finally { release(); }
    await held;
    expect(await pending).toEqual({ status: 200, json: { username: 'kev' } });
    expect(s.owner().username).toBe('kev');
    expect(s.append.mock.calls.map(([, event]) => event.content['displayname'])).toEqual(['kev', 'kev-Claude']);
  });

  it('serializes reads and all mutations through the entire username cascade', async () => {
    const s = setup({ a: [member(LOCAL_OWNER_USER_ID, 'kevin'), member('@agent-a1b2c3d4:local', 'kevin-Claude', 'claude')] });
    let release!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const entered = new Promise<void>(resolve => { started = resolve; });
    const original = s.append.getMockImplementation()!;
    s.append.mockImplementationOnce(async (...args) => { started(); await blocked; return original(...args); });
    const first = s.request('/username', { username: 'kev' });
    await entered;
    const second = s.request('/username', { username: 'sam' });
    const color = s.request('/color', { color: 'teal' });
    const initials = s.request('/initials', { initials: 'kw' });
    const read = s.request();
    await Promise.resolve();
    expect(s.writes).toHaveLength(1);
    release();
    expect((await Promise.all([first, second, color, initials])).every(r => r.status === 200)).toBe(true);
    expect((await read).json).toMatchObject({ username: 'sam', color: 'teal', initials: 'KW' });
    expect(s.append.mock.calls.map(([, e]) => e.content['displayname'])).toEqual(['kev', 'kev-Claude', 'sam', 'sam-Claude']);
  });
});
