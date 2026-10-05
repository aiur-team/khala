import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MatrixEvent } from 'matrix-js-sdk';
import { localChannelNamePath } from '@khala/contracts/m1/channel-names';
import { LOCAL_OWNER_USER_ID, decodeLocalEventsPage, type OwnerProfile } from '@khala/contracts/m1/local';
import { decodeLocalEventsPage as frozenEventsPage, decodeLocalHistoryPage as frozenHistoryPage } from './local-decoder.main.frozen';
import { decodeLocalEventsPage as releasedEventsPage } from './local-decoder.0-4.frozen';
import { frozenMainMatrixMessage } from './matrix-message.main.frozen';
import { memberRenameContent } from '../events/member-rename';
import { openLocalStore, type OpenedLocalStore } from '../local/store';
import { ownerRoutes } from '../local/routes/owner';
import { profileRoutes } from '../local/routes/profile';
import { roomRoutes } from '../local/routes/rooms';
import { agentJoinRoutes } from '../local/routes/agent-join';
import type { HelperContext, LocalAuth, LocalRequest, LocalRoute } from '../local/types';

// One helper process serves every CLI on the machine and is reused regardless of
// version (ensureHelper checks pid only). Its default responses must therefore
// keep decoding with the strict decoder older CLIs ship. Strict decoders reject
// unknown fields, and a rejected /events page is retried forever, silencing the
// agent. These tests feed the real helper routes' default output to frozen
// pre-#1078 decoders for each membership transition the PR touches.

const AGENT = '@agent-a1b2c3d4:local';
const NOW = 1759395600000;
const ownerDefault: OwnerProfile = { v: 1, username: 'kevin', color: 'teal', initials: null, updatedAt: '2025-10-02T09:00:00.000Z' };
const ADMIN: LocalAuth = { kind: 'owner', via: 'admin' };

let tmp: string;
let store: OpenedLocalStore;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'khala-compat-'));
  let counter = 0;
  store = await openLocalStore({ root: path.join(tmp, 'khala/local'), ownerDefault, now: () => NOW,
    random: n => { const bytes = new Uint8Array(n); new DataView(bytes.buffer).setUint32(0, ++counter); return bytes; } });
});
afterEach(async () => {
  await store.close();
  await fs.rm(tmp, { recursive: true, force: true });
});

function helper() {
  const ctx: HelperContext = { store, origin: 'http://127.0.0.1:47830', now: () => NOW, random: n => new Uint8Array(n), version: 'test',
    joins: new Map(), mintOpenToken: () => ({ token: '', expiresAt: '' }), consumeOpenToken: () => null, createOwnerSession: () => '', shutdown: () => {} };
  const routes: LocalRoute[] = [...roomRoutes(), ...ownerRoutes(), ...profileRoutes(), ...agentJoinRoutes()];
  return async (method: LocalRequest['method'], url: string, auth: LocalAuth, body?: unknown): Promise<{ status: number; json?: unknown }> => {
    const parsed = new URL(url, ctx.origin);
    const route = routes.find(r => r.method === method && r.pattern.test(parsed.pathname));
    if (!route) throw new Error(`route_missing ${method} ${parsed.pathname}`);
    return await route.handle({ method, path: parsed.pathname, query: parsed.searchParams, headers: {}, body, auth, origin: ctx.origin,
      signal: new AbortController().signal }, route.pattern.exec(parsed.pathname)!.slice(1), ctx) as { status: number; json?: unknown };
  };
}

async function joinedAgent() {
  const call = helper();
  const { roomId } = await store.createChannel('refactor');
  await store.append(roomId, { type: 'm.room.member', sender: LOCAL_OWNER_USER_ID, content: {
    user: AGENT, membership: 'invite', displayname: 'kevin-Codex', kind: 'agent', harness: 'codex', invitedBy: LOCAL_OWNER_USER_ID } });
  const auth: LocalAuth = { kind: 'agent', userId: AGENT, roomId };
  const room = (tail: string) => `/api/local/rooms/${encodeURIComponent(roomId)}/${tail}`;
  expect((await call('POST', room('join'), auth)).status).toBe(200);
  return { call, auth, room, roomId, after: store.eventsAfter(roomId, 0, 200).at(-1)!.seq };
}
type Agent = Awaited<ReturnType<typeof joinedAgent>>;

const transitions: Record<string, (agent: Agent) => Promise<void>> = {
  // A second CLI joins with a stable session, restarts and rejoins as the same member
  // while the original agent keeps reading the default /events feed.
  'session rejoin': async ({ call, room, roomId }) => {
    const session = { harness: 'codex', label: 'Codex', sessionId: 'thread-1', rejoinSecret: 'S'.repeat(43) };
    const joinAs = async () => {
      const link = `http://127.0.0.1:47830/join/${(await store.mintLink(roomId, 'join')).token}`;
      const created = await call('POST', '/api/agent/join', { kind: 'none' }, { link, ...session });
      expect(created.status).toBe(201);
      const userId = store.members(roomId).filter(m => m.harness === 'codex' && m.membership === 'invite').at(-1)!.userId;
      expect((await call('POST', room('join'), { kind: 'agent', userId, roomId })).status).toBe(200);
      return userId;
    };
    expect(await joinAs()).toBe(await joinAs());
    expect(store.history(roomId, undefined, 100).events.map(e => e.content['summary'])).toEqual(expect.arrayContaining(['kevin-Codex-2 joined', 'kevin-Codex-2 rejoined']));
  },
  'listening-mode change': async ({ call, auth, room }) => {
    expect((await call('PUT', room(`members/${encodeURIComponent(AGENT)}`), auth, { listeningMode: 'async' })).status).toBe(204);
  },
  'roster rename': async ({ call }) => {
    expect((await call('POST', `/api/local/agents/${encodeURIComponent(AGENT)}/name`, ADMIN, { name: 'reviewer' })).status).toBe(200);
  },
  'owner username cascade': async ({ call }) => {
    expect((await call('POST', '/api/local/profile/username', ADMIN, { username: 'kev' })).status).toBe(200);
  },
  // A per-channel name travels as the owner's ordinary m.room.member displayname: no new field or event kind.
  'owner per-channel name': async ({ call, roomId }) => {
    expect((await call('POST', localChannelNamePath(roomId), ADMIN, { name: 'kevin2' })).status).toBe(200);
    expect(store.eventsAfter(roomId, 0, 200).at(-1)?.content).toEqual(
      { user: LOCAL_OWNER_USER_ID, membership: 'join', displayname: 'kevin2', kind: 'human' });
  },
};

describe('local helper default wire stays decodable by pre-#1078 CLIs', () => {
  it.each(Object.keys(transitions))('%s', async name => {
    const agent = await joinedAgent();
    await transitions[name]!(agent);

    const plain = await agent.call('GET', agent.room(`events?after=${agent.after}`), agent.auth);
    expect(plain.status).toBe(200);
    const page = frozenEventsPage(plain.json);
    expect(page).toMatchObject({ ok: true });
    expect(page.ok && page.value.events.some(e => e.type === 'm.room.member')).toBe(true);

    const history = await agent.call('GET', agent.room('messages?limit=100'), agent.auth);
    expect(history.status).toBe(200);
    expect(frozenHistoryPage(history.json)).toMatchObject({ ok: true });

    // Opted-in clients (prev=1) still receive canonical previous membership; the
    // frozen decoder rejecting that page proves this test catches a default leak.
    const opted = await agent.call('GET', agent.room(`events?after=${agent.after}&prev=1`), agent.auth);
    expect(decodeLocalEventsPage(opted.json)).toMatchObject({ ok: true });
    expect(releasedEventsPage(opted.json)).toMatchObject({ ok: true });
    expect(frozenEventsPage(opted.json)).toMatchObject({ ok: false, error: { code: 'unknown_field' } });
  });

  it('history carries renames as channel events old CLIs already accept, never mode changes', async () => {
    const agent = await joinedAgent();
    await transitions['listening-mode change']!(agent);
    await transitions['roster rename']!(agent);
    const history = frozenHistoryPage((await agent.call('GET', agent.room('messages?limit=100'), agent.auth)).json);
    expect(history.ok).toBe(true);
    expect(history.ok && history.value.events.map(e => [e.type, e.content['body']])).toEqual([
      ['com.khala.event.v1', 'kevin-Codex joined'], ['com.khala.event.v1', 'kevin-Codex is now reviewer']]);
  });
});

describe('frozen local harness ids', () => {
  it.each([['pre-#1078', frozenEventsPage], ['0.4.x', releasedEventsPage]] as const)('%s rejects a Gemini member', async (_version, decode) => {
    const agent = await joinedAgent();
    const response = await agent.call('GET', agent.room('events?after=0'), agent.auth);
    expect(response.status).toBe(200);
    const page = response.json as { events: Record<string, unknown>[]; next: number };
    const member = page.events.find(event => event['type'] === 'm.room.member' && (event['content'] as Record<string, unknown>)['kind'] === 'agent')!;
    const content = member['content'] as Record<string, unknown>;
    for (const harness of ['claude', 'codex', 'cursor']) {
      expect(decode({ events: [{ ...member, content: { ...content, harness } }], next: member['seq'] })).toMatchObject({ ok: true });
    }
    expect(decode({ events: [{ ...member, content: { ...content, harness: 'gemini' } }], next: member['seq'] }))
      .toMatchObject({ ok: false, error: { path: 'events[0].content.harness', code: 'invalid_value' } });
  });

  it('0.4.x accepts the helper prev=1 page with previous membership', async () => {
    const agent = await joinedAgent();
    const response = await agent.call('GET', agent.room('events?after=0&prev=1'), agent.auth);
    expect(response.status).toBe(200);
    const decoded = releasedEventsPage(response.json);
    expect(decoded).toMatchObject({ ok: true });
    expect(decoded.ok && decoded.value.events.some(event => event.previousContent?.membership === 'invite')).toBe(true);
  });
});

describe('hosted Matrix events stay mappable by pre-#1078 CLIs', () => {
  const raw = (id: string, content: Record<string, unknown>, prev: Record<string, unknown>) => new MatrixEvent({
    event_id: id, room_id: '!r:hs', sender: '@owner:hs', origin_server_ts: 100, type: 'm.room.member', state_key: '@agent:hs',
    content, unsigned: { prev_content: prev } });
  const base = { membership: 'join', displayname: 'kevin-Codex', 'com.khala.listening_mode': 'sync' };
  const rename = raw('$rename', { ...base, displayname: 'reviewer' }, base);
  const mode = raw('$mode', { ...base, 'com.khala.listening_mode': 'async' }, base);

  // Hosted renames arrive from the homeserver as standard m.room.member events with
  // unsigned.prev_content; #1078 adds no hosted event type or field. Old mappers drop
  // member events, so older CLIs keep receiving messages (just without rename news).
  // A per-channel name is the member's own room-scoped displayname: the same standard event, sent by the member.
  const channelName = raw('$channel-name', { membership: 'join', displayname: 'kevin-Codex-2' }, { membership: 'join', displayname: 'kevin-Codex' });
  it.each([['rename', rename], ['mode change', mode], ['per-channel name', channelName]] as const)('old mapper drops a %s member event cleanly', (_name, event) => {
    expect(() => frozenMainMatrixMessage(event)).not.toThrow();
    expect(frozenMainMatrixMessage(event)).toBeUndefined();
  });

  it('new projection announces the rename and stays silent for the mode change', () => {
    expect(memberRenameContent(rename.getContent(), rename.getPrevContent())).toMatchObject({ kind: 'member', body: 'kevin-Codex is now reviewer' });
    expect(memberRenameContent(mode.getContent(), mode.getPrevContent())).toBeNull();
    expect(memberRenameContent(channelName.getContent(), channelName.getPrevContent())).toMatchObject({ body: 'kevin-Codex is now kevin-Codex-2' });
  });
});
