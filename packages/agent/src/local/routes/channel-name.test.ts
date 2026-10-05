import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { localChannelNamePath } from '@khala/contracts/m1/channel-names';
import { LOCAL_OWNER_USER_ID, type OwnerProfile } from '@khala/contracts/m1/local';
import { openLocalStore, type OpenedLocalStore } from '../store';
import type { HelperContext, LocalAuth, LocalRequest, LocalRoute } from '../types';
import { agentJoinRoutes } from './agent-join';
import { ownerRoutes } from './owner';
import { profileRoutes } from './profile';

const AGENT = '@agent-a1b2c3d4:local';
const ADMIN: LocalAuth = { kind: 'owner', via: 'admin' };
const ownerDefault: OwnerProfile = { v: 1, username: 'kevin', color: 'teal', initials: null, updatedAt: '2025-10-02T09:00:00.000Z' };
let tmp: string;
let store: OpenedLocalStore;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'khala-channel-name-'));
  let counter = 0;
  store = await openLocalStore({ root: path.join(tmp, 'local'), ownerDefault, now: () => 1759395600000,
    random: n => { const bytes = new Uint8Array(n); new DataView(bytes.buffer).setUint32(0, ++counter); return bytes; } });
});
afterEach(async () => {
  await store.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

function helper() {
  let counter = 1000;
  const ctx: HelperContext = { store, origin: 'http://127.0.0.1:47830', now: () => 1759395600000, version: 'test', joins: new Map(),
    random: n => { const bytes = new Uint8Array(n); new DataView(bytes.buffer).setUint32(0, ++counter); return bytes; },
    mintOpenToken: () => ({ token: '', expiresAt: '' }), consumeOpenToken: () => null, createOwnerSession: () => '', shutdown: () => {} };
  const routes: LocalRoute[] = [...ownerRoutes(), ...profileRoutes(), ...agentJoinRoutes()];
  return async (method: LocalRequest['method'], url: string, auth: LocalAuth, body?: unknown) => {
    const parsed = new URL(url, ctx.origin);
    const route = routes.find(r => r.method === method && r.pattern.test(parsed.pathname))!;
    return await route.handle({ method, path: parsed.pathname, query: parsed.searchParams, headers: {}, body, auth, origin: ctx.origin,
      signal: new AbortController().signal }, route.pattern.exec(parsed.pathname)!.slice(1), ctx) as { status: number; json?: unknown };
  };
}
const ownerName = (roomId: string) => store.members(roomId).find(m => m.userId === LOCAL_OWNER_USER_ID)!.displayName;

async function withAgentNamed(name: string) {
  const { roomId } = await store.createChannel('refactor');
  await store.append(roomId, { type: 'm.room.member', sender: LOCAL_OWNER_USER_ID, content: {
    user: AGENT, membership: 'join', displayname: name, kind: 'agent', harness: 'codex' } });
  return roomId;
}

it('sets the owner name in one channel only and announces it', async () => {
  const call = helper();
  const roomId = await withAgentNamed('kevin');
  const { roomId: other } = await store.createChannel('other');
  expect(await call('POST', localChannelNamePath(roomId), ADMIN, { name: 'kevin2' })).toEqual({ status: 200, json: { name: 'kevin2' } });
  expect([ownerName(roomId), ownerName(other)]).toEqual(['kevin2', 'kevin']);
  expect(store.history(roomId, undefined, 10).events.at(-1)?.content['body']).toBe('kevin is now kevin2');
});

it('refuses a name someone else in the channel holds, and invalid names', async () => {
  const call = helper();
  const roomId = await withAgentNamed('reviewer');
  expect(await call('POST', localChannelNamePath(roomId), ADMIN, { name: 'Reviewer' })).toEqual({ status: 409, json: { error: 'name_taken' } });
  expect(await call('POST', localChannelNamePath(roomId), ADMIN, { name: 'a b' })).toMatchObject({ status: 400, json: { error: 'invalid_name' } });
  expect(await call('POST', localChannelNamePath(roomId), ADMIN, { name: 'kevin2', user: AGENT })).toEqual({ status: 400, json: { error: 'invalid_request' } });
  expect(await call('POST', localChannelNamePath('!missing:local'), ADMIN, { name: 'kevin2' })).toEqual({ status: 404, json: { error: 'not_found' } });
  expect(ownerName(roomId)).toBe('kevin');
});

it('lets no agent set a channel name', async () => {
  const call = helper();
  const roomId = await withAgentNamed('kevin');
  const agent: LocalAuth = { kind: 'agent', userId: AGENT, roomId };
  expect(await call('POST', localChannelNamePath(roomId), agent, { name: 'kevin9' })).toEqual({ status: 403, json: { error: 'forbidden' } });
  expect(await call('POST', localChannelNamePath(roomId), { kind: 'none' }, { name: 'kevin9' })).toEqual({ status: 401, json: { error: 'unauthorized' } });
  expect(ownerName(roomId)).toBe('kevin');
});

it('choosing the username again clears the override, and a new username replaces it', async () => {
  const call = helper();
  const roomId = await withAgentNamed('bot');
  await call('POST', localChannelNamePath(roomId), ADMIN, { name: 'kev' });
  await call('POST', localChannelNamePath(roomId), ADMIN, { name: 'kevin' });
  expect(store.ownerChannelName(roomId)).toBeUndefined();
  await call('POST', localChannelNamePath(roomId), ADMIN, { name: 'kev' });
  expect((await call('POST', '/api/local/profile/username', ADMIN, { username: 'kw' })).status).toBe(200);
  expect(ownerName(roomId)).toBe('kw');
  expect(store.ownerChannelName(roomId)).toBeUndefined();
  expect(store.history(roomId, undefined, 20).events.at(-1)?.content['body']).toBe('kev is now kw');
});

it('auto-suffixes an agent whose default name is taken in its channel only', async () => {
  const call = helper();
  const taken = await withAgentNamed('kevin-Codex');
  const { roomId: fresh } = await store.createChannel('fresh');
  for (const roomId of [taken, fresh]) {
    const link = `http://127.0.0.1:47830/join/${(await store.mintLink(roomId, 'join')).token}`;
    expect((await call('POST', '/api/agent/join', { kind: 'none' }, { link, harness: 'codex', label: 'Codex' })).status).toBe(201);
  }
  expect(store.members(taken).map(m => m.displayName)).toEqual(['kevin', 'kevin-Codex', 'kevin-Codex-2']);
  expect(store.members(fresh).map(m => m.displayName)).toEqual(['kevin', 'kevin-Codex']);
});
