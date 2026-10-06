import { LEGACY_HARNESSES } from '@khala/contracts/m1/harness';
import type { Harness } from '@khala/contracts/m1/agent-join';
// An in-memory fake of the local helper's owner-facing API (contracts L5/L6).
// State is the per-channel event log; members, names, modes and summaries are
// derived from it by the L3 replay rules. Long-polls are held until an append
// or the wait expires. Transport-agnostic: the browser spec routes requests in.
import { encodeChannelEvent, memberRenameContent } from '@khala/contracts/m1/channel-event';
import { isHumanColorId, type HumanColorId } from '@khala/contracts/m1/colors';
import { isCanonicalInitials } from '@khala/contracts/m1/initials';
import { DEFAULT_LISTENING_MODE, LISTENING_MODE_COMMAND_TYPE, LISTENING_MODE_MEMBER_KEY, type ListeningMode } from '@khala/contracts/m1/listening-mode';
import {
  LOCAL_OWNER_DEVICE_ID, LOCAL_OWNER_ID, LOCAL_OWNER_USER_ID, isLocalTxnId,
  type LocalChannelSummary, type LocalEvent, type LocalEventType, type LocalMember, type OwnerProfileView,
} from '@khala/contracts/m1/local';
import { checkName, checkNewUsername, isDefaultAgentName } from '@khala/contracts/m1/names';

function harnessView<T extends object>(content: T, query: URLSearchParams): T {
  if (query.get('wire') === '2' || !('harness' in content) || content.harness === undefined
    || (LEGACY_HARNESSES as readonly unknown[]).includes(content.harness)) return content;
  const view = { ...content };
  delete (view as { harness?: unknown }).harness;
  return view;
}
function summaryView(value: LocalChannelSummary, query: URLSearchParams): LocalChannelSummary {
  return { ...value, members: value.members.map(member => harnessView(member, query)) };
}

export type FakeRequest = Readonly<{ method: string; path: string; query: URLSearchParams; headers: Readonly<Record<string, string>>; body: unknown }>;
export type FakeResponse = Readonly<{ status: number; json?: unknown }>;
export type FakeModeCommand = Readonly<{ roomId: string; agent: string; mode: string; txnId: string }>;
export type FakeLocalHelper = Readonly<{
  handle(request: FakeRequest): Promise<FakeResponse>;
  log: readonly FakeRequest[];
  unhandled: readonly string[];
  violations: readonly string[];
  modeCommands: readonly FakeModeCommand[];
  agentSays(roomId: string, userId: string, body: string): LocalEvent;
  /** A `com.khala.event.v1` announcement from the owner, as the helper posts for a join. */
  announce(roomId: string, summary: string): LocalEvent;
  /** The agent's member-event echo after it applied a mode command. */
  echoMode(roomId: string, userId: string, mode: ListeningMode): LocalEvent;
  /** Releases every held long-poll with an empty answer and refuses new holds. */
  close(): void;
}>;

export const FAKE_R1 = '!c7Kq2vXbT1nP0aZ9yW3eQw:local';
export const FAKE_R2 = '!r2Kq2vXbT1nP0aZ9yW3eQw:local';
export const FAKE_CLAUDE = '@agent-a1b2c3d4:local';
export const FAKE_CODEX = '@agent-e5f6a7b8:local';
export const FAKE_RELEASE_AGENT = '@agent-c9d0e1f2:local';
export const FAKE_LINK_ORIGIN = 'http://127.0.0.1:47830';

type Channel = { roomId: string; events: LocalEvent[]; operationId?: string; createdAt: string };
type MemberContent = { user: string; membership: 'invite' | 'join' | 'leave'; displayname: string; kind: 'human' | 'agent';
  harness?: Harness; [LISTENING_MODE_MEMBER_KEY]?: ListeningMode };

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const token = (n: number, counter: number) => Array.from({ length: n }, (_, i) => BASE64URL[(counter * 7 + i * 13) % 64]).join('');

const eventsRoute = /^\/api\/local\/rooms\/([^/]+)\/events$/;
const messagesRoute = /^\/api\/local\/rooms\/([^/]+)\/messages$/;
const sendRoute = /^\/api\/local\/rooms\/([^/]+)\/send$/;
const membersRoute = /^\/api\/local\/rooms\/([^/]+)\/members$/;
const channelsRoute = /^\/api\/local\/channels$/;
const byOperationRoute = /^\/api\/local\/channels\/by-operation\/([^/]+)$/;
const channelRoute = /^\/api\/local\/channels\/([^/]+)$/;
const linksRoute = /^\/api\/local\/channels\/([^/]+)\/links$/;
const modeRoute = /^\/api\/local\/channels\/([^/]+)\/mode$/;
const agentNameRoute = /^\/api\/local\/agents\/([^/]+)\/name$/;
const profileRoute = /^\/api\/local\/profile$/;
const profileFieldRoute = /^\/api\/local\/profile\/(username|color|initials)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
const ok = (json: unknown): FakeResponse => ({ status: 200, json });
const error = (status: number, code: string, reason?: string): FakeResponse => ({ status, json: { error: code, ...(reason ? { reason } : {}) } });

export function createFakeLocalHelper(seed?: { maxWaitMs?: number }): FakeLocalHelper {
  const maxWaitMs = seed?.maxWaitMs ?? 3000;
  const log: FakeRequest[] = [];
  const unhandled: string[] = [];
  const violations: string[] = [];
  const modeCommands: FakeModeCommand[] = [];
  const channels = new Map<string, Channel>();
  const waiters = new Set<() => void>();
  const owner: { username: string; suggestion: string; color: HumanColorId; initials: string | null } = { username: 'kevin', suggestion: 'kevin', color: 'blue', initials: null };
  let revision = 0;
  let seq = 0;
  let rooms = 0;
  let links = 0;
  let closed = false;
  let clock = 1759395601000;

  function bump(): void {
    revision += 1;
    const released = [...waiters];
    waiters.clear();
    for (const release of released) release();
  }
  function channel(roomId: string): Channel | undefined { return channels.get(roomId); }
  function append(roomId: string, type: LocalEventType, sender: string, content: Record<string, unknown>, options?: { txnId?: string; ts?: number }): LocalEvent {
    const target = channel(roomId);
    if (!target) throw new Error(`fake: unknown channel ${roomId}`);
    seq += 1;
    // Seeded events keep their worked-example time; live ones are monotonic wall-clock.
    const ts = options?.ts ?? Math.max(clock + 1, Date.now());
    clock = Math.max(clock, ts);
    const event: LocalEvent = { seq: target.events.length + 1, eventId: `$${String(seq).padStart(22, '0')}`, roomId, type, sender, ts,
      ...(options?.txnId ? { txnId: options.txnId } : {}), content };
    target.events.push(event);
    bump();
    return event;
  }
  function create(roomId: string, name: string, ts: number, operationId?: string): Channel {
    const created: Channel = { roomId, events: [], createdAt: new Date(ts).toISOString(), ...(operationId ? { operationId } : {}) };
    channels.set(roomId, created);
    append(roomId, 'm.room.create', LOCAL_OWNER_USER_ID, { name, createdBy: LOCAL_OWNER_USER_ID, ...(operationId ? { operationId } : {}) }, { ts });
    append(roomId, 'm.room.member', LOCAL_OWNER_USER_ID, { user: LOCAL_OWNER_USER_ID, membership: 'join', displayname: owner.username, kind: 'human' }, { ts: ts + 1 });
    return created;
  }

  // L3 replay: the last member event per user; present = invite or join.
  function memberContents(target: Channel): MemberContent[] {
    const last = new Map<string, MemberContent>();
    for (const event of target.events) if (event.type === 'm.room.member') last.set(String(event.content['user']), event.content as MemberContent);
    const present = [...last.values()].filter(m => m.membership === 'invite' || m.membership === 'join');
    return [...present.filter(m => m.user === LOCAL_OWNER_USER_ID), ...present.filter(m => m.user !== LOCAL_OWNER_USER_ID)];
  }
  function member(target: Channel, userId: string): MemberContent | undefined {
    return memberContents(target).find(m => m.user === userId);
  }
  function members(target: Channel): LocalMember[] {
    return memberContents(target).map(m => m.kind === 'human'
      ? { userId: m.user, participantId: m.user, ownerId: LOCAL_OWNER_ID, deviceId: LOCAL_OWNER_DEVICE_ID, displayName: m.displayname, kind: 'human', membership: m.membership as 'invite' | 'join' }
      : { userId: m.user, participantId: m.user, ownerId: LOCAL_OWNER_ID, deviceId: `KH_LOCAL_${m.user.slice(7, 15)}`, displayName: m.displayname,
        kind: 'agent', ...(m.harness ? { harness: m.harness } : {}), ownerLabel: owner.username, membership: m.membership as 'invite' | 'join',
        listeningMode: m[LISTENING_MODE_MEMBER_KEY] ?? DEFAULT_LISTENING_MODE });
  }
  function name(target: Channel): string {
    const renamed = target.events.filter(e => e.type === 'm.room.name').at(-1);
    return String((renamed ?? target.events[0]!).content['name']);
  }
  function summary(target: Channel): LocalChannelSummary {
    const last = target.events.at(-1)!;
    const message = target.events.filter(e => e.type === 'm.room.message' && e.content['msgtype'] === 'm.text').at(-1);
    const sender = message ? member(target, message.sender) : undefined;
    return { roomId: target.roomId, name: name(target), createdAt: target.createdAt, lastSeq: last.seq, lastTs: last.ts,
      preview: message ? String(message.content['body']) : null,
      ...(message ? { lastSender: { userId: message.sender, displayName: sender?.displayname ?? message.sender.slice(1).split(':')[0]! } } : {}),
      members: memberContents(target).map(m => ({ userId: m.user, displayName: m.displayname, kind: m.kind, ...(m.harness ? { harness: m.harness } : {}) })) };
  }
  function summaries(): LocalChannelSummary[] {
    return [...channels.values()].map(summary).sort((a, b) => b.lastTs - a.lastTs);
  }
  function profile(): OwnerProfileView {
    return { userId: LOCAL_OWNER_USER_ID, ownerId: LOCAL_OWNER_ID, username: owner.username, suggestion: owner.suggestion, color: owner.color, initials: owner.initials };
  }
  /** Holds until `ready()` holds, the wait expires or the fake closes. */
  async function hold(waitSeconds: number, ready: () => boolean): Promise<void> {
    const deadline = Date.now() + Math.min(Math.max(waitSeconds, 0) * 1000, maxWaitMs);
    while (!closed && !ready() && Date.now() < deadline) {
      await new Promise<void>(resolve => {
        const release = () => { clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => { waiters.delete(release); resolve(); }, deadline - Date.now());
        waiters.add(release);
      });
    }
  }
  function previousMember(target: Channel, event: LocalEvent): Record<string, unknown> | undefined {
    return target.events.filter(e => e.type === 'm.room.member' && e.seq < event.seq && e.content['user'] === event.content['user']).at(-1)?.content;
  }
  function memberEvent(roomId: string, sender: string, current: MemberContent, changes: Partial<MemberContent>): LocalEvent {
    return append(roomId, 'm.room.member', sender, { ...current, ...changes });
  }
  function shareLink(): string { links += 1; return `${FAKE_LINK_ORIGIN}/join/${token(43, links)}`; }

  // The worked example (KI-145): two channels, three agents, one message.
  create(FAKE_R1, 'refactor', 1759395601000);
  append(FAKE_R1, 'm.room.member', FAKE_CLAUDE, { user: FAKE_CLAUDE, membership: 'join', displayname: 'kevin-Claude', kind: 'agent', harness: 'claude', [LISTENING_MODE_MEMBER_KEY]: 'sync' }, { ts: 1759395632000 });
  append(FAKE_R1, 'm.room.member', FAKE_CODEX, { user: FAKE_CODEX, membership: 'join', displayname: 'kevin-Codex', kind: 'agent', harness: 'codex', [LISTENING_MODE_MEMBER_KEY]: 'async' }, { ts: 1759395640000 });
  append(FAKE_R1, 'm.room.message', LOCAL_OWNER_USER_ID, { msgtype: 'm.text', body: '@kevin-Codex can you review PR #12?' }, { txnId: 'web-7b1e', ts: 1759395700000 });
  create(FAKE_R2, 'release', 1759395500000);
  append(FAKE_R2, 'm.room.member', FAKE_RELEASE_AGENT, { user: FAKE_RELEASE_AGENT, membership: 'join', displayname: 'kevin-Claude', kind: 'agent', harness: 'claude' }, { ts: 1759395510000 });

  async function route(request: FakeRequest): Promise<FakeResponse | null> {
    const { method, path, query } = request;
    const body = isRecord(request.body) ? request.body : {};
    let match: RegExpExecArray | null;
    if (method === 'GET') {
      if (profileRoute.test(path)) return ok(profile());
      if (channelsRoute.test(path)) {
        const since = query.get('since');
        if (since !== null) await hold(Number(query.get('wait') ?? 0), () => String(revision) !== since);
        return ok({ revision, channels: summaries().map(value => summaryView(value, query)) });
      }
      if ((match = byOperationRoute.exec(path))) {
        const operationId = decodeURIComponent(match[1]!);
        const found = [...channels.values()].find(c => c.operationId === operationId);
        return found ? ok({ roomId: found.roomId }) : error(404, 'not_found');
      }
      if ((match = channelRoute.exec(path))) {
        const target = channel(decodeURIComponent(match[1]!));
        return target ? ok(summaryView(summary(target), query)) : error(404, 'not_found');
      }
      if ((match = eventsRoute.exec(path))) {
        const target = channel(decodeURIComponent(match[1]!));
        if (!target) return error(404, 'not_found');
        const after = Number(query.get('after') ?? 0);
        await hold(Number(query.get('wait') ?? 0), () => target.events.length > after);
        const events = target.events.filter(e => e.seq > after).slice(0, 200).map(e => {
          // Like the real helper, the preceding membership only goes to clients that ask (prev=1).
          const previous = query.get('prev') === '1' && e.type === 'm.room.member' ? previousMember(target, e) : undefined;
          return { ...e, content: harnessView(e.content, query), ...(previous ? { previousContent: harnessView(previous, query) } : {}) };
        });
        return ok({ events, next: events.at(-1)?.seq ?? after });
      }
      if ((match = messagesRoute.exec(path))) {
        const target = channel(decodeURIComponent(match[1]!));
        if (!target) return error(404, 'not_found');
        const limit = Math.min(Math.max(Number(query.get('limit') ?? 50), 1), 100);
        const before = query.get('before');
        // History carries name changes as event pills, as the real helper derives them from membership.
        const visible = target.events.flatMap((e): LocalEvent[] => {
          if (e.type !== 'm.room.member') return e.type === 'm.room.message' || e.type === 'com.khala.event.v1' ? [e] : [];
          const renamed = memberRenameContent(e.content, previousMember(target, e));
          return renamed ? [{ ...e, type: 'com.khala.event.v1', content: renamed as unknown as Record<string, unknown> }] : [];
        });
        const end = before ? visible.findIndex(e => e.eventId === before) : visible.length;
        const older = visible.slice(0, end < 0 ? 0 : end);
        const page = older.slice(-limit);
        return ok({ events: page.map(e => ({ ...e, content: harnessView(e.content, query) })), ...(older.length > page.length ? { nextBefore: page[0]!.eventId } : {}) });
      }
      if ((match = membersRoute.exec(path))) {
        const target = channel(decodeURIComponent(match[1]!));
        return target ? ok({ members: members(target).map(member => harnessView(member, query)) }) : error(404, 'not_found');
      }
      return null;
    }
    if (method !== 'POST') return null;
    if ((match = sendRoute.exec(path))) {
      const target = channel(decodeURIComponent(match[1]!));
      if (!target) return error(404, 'not_found');
      const txnId = body['txnId'];
      const type = body['type'];
      if (typeof txnId !== 'string' || !isLocalTxnId(txnId) || (type !== 'm.room.message' && type !== 'com.khala.event.v1') || !isRecord(body['content'])) return error(400, 'invalid_request');
      const replay = target.events.find(e => e.sender === LOCAL_OWNER_USER_ID && e.txnId === txnId);
      if (replay) return ok({ eventId: replay.eventId });
      return ok({ eventId: append(target.roomId, type, LOCAL_OWNER_USER_ID, body['content'], { txnId }).eventId });
    }
    if (channelsRoute.test(path)) {
      const title = typeof body['name'] === 'string' ? body['name'].trim() : '';
      const operationId = body['operationId'];
      if (!title || [...title].length > 64 || (operationId !== undefined && (typeof operationId !== 'string' || !isLocalTxnId(operationId)))) return error(400, 'invalid_request');
      const existing = operationId ? [...channels.values()].find(c => c.operationId === operationId) : undefined;
      if (!existing) rooms += 1;
      const created = existing ?? create(`!new${String(rooms).padStart(19, '0')}:local`, title, Date.now(), operationId as string | undefined);
      return ok({ roomId: created.roomId, name: name(created), selfLink: shareLink(), shareLink: shareLink(),
        openUrl: `${FAKE_LINK_ORIGIN}/open/${token(43, links + 100)}`, expiresAt: new Date(Date.now() + 600_000).toISOString() });
    }
    if ((match = linksRoute.exec(path))) {
      if (!channel(decodeURIComponent(match[1]!))) return error(404, 'not_found');
      return ok({ shareLink: shareLink(), expiresAt: new Date(Date.now() + 600_000).toISOString() });
    }
    if ((match = modeRoute.exec(path))) {
      const target = channel(decodeURIComponent(match[1]!));
      if (!target) return error(404, 'not_found');
      const { agent, mode, txnId } = body;
      if (typeof agent !== 'string' || typeof txnId !== 'string' || !isLocalTxnId(txnId) || (mode !== 'steer' && mode !== 'sync' && mode !== 'async')) return error(400, 'invalid_request');
      if (member(target, agent)?.kind !== 'agent') return error(404, 'not_found');
      const replay = target.events.find(e => e.sender === LOCAL_OWNER_USER_ID && e.txnId === txnId);
      if (replay) return ok({ eventId: replay.eventId });
      modeCommands.push({ roomId: target.roomId, agent, mode, txnId });
      return ok({ eventId: append(target.roomId, LISTENING_MODE_COMMAND_TYPE, LOCAL_OWNER_USER_ID, { v: 1, agent, mode }, { txnId }).eventId });
    }
    if ((match = agentNameRoute.exec(path))) {
      const userId = decodeURIComponent(match[1]!);
      const checked = checkName(body['name'], 'agent');
      if (!checked.ok) return error(400, 'invalid_name', checked.error);
      const holding = [...channels.values()].filter(c => member(c, userId)?.kind === 'agent');
      if (!holding.length) return error(404, 'not_found');
      for (const target of holding) memberEvent(target.roomId, LOCAL_OWNER_USER_ID, member(target, userId)!, { displayname: checked.name });
      return ok({ matrixUserId: userId, name: checked.name });
    }
    if ((match = profileFieldRoute.exec(path))) {
      if (match[1] === 'username') {
        const checked = checkNewUsername(body['username']);
        if (!checked.ok) return error(400, 'invalid_username', checked.error);
        const previous = owner.username;
        owner.username = checked.name;
        // Agents still on a default name follow the owner (hosted renameDefaultAgents).
        for (const target of channels.values()) {
          for (const m of memberContents(target)) {
            if (m.user === LOCAL_OWNER_USER_ID) { memberEvent(target.roomId, LOCAL_OWNER_USER_ID, m, { displayname: checked.name }); continue; }
            if (!m.harness || !isDefaultAgentName(m.displayname, previous, m.harness)) continue;
            memberEvent(target.roomId, LOCAL_OWNER_USER_ID, m, { displayname: `${checked.name}${m.displayname.slice(previous.length)}` });
          }
        }
        bump();
        return ok({ username: owner.username });
      }
      if (match[1] === 'color') {
        if (!isHumanColorId(body['color'])) return error(400, 'invalid_color');
        owner.color = body['color'];
        bump();
        return ok({ color: owner.color });
      }
      const initials = body['initials'];
      if (initials !== null && !isCanonicalInitials(initials)) return error(400, 'invalid_initials');
      owner.initials = initials as string | null;
      bump();
      return ok({ initials: owner.initials });
    }
    return null;
  }

  return {
    log, unhandled, violations, modeCommands,
    async handle(request) {
      log.push(request);
      if (request.method !== 'GET' && request.headers['x-khala-local'] !== '1') {
        violations.push(`${request.method} ${request.path}`);
        return error(403, 'forbidden_origin');
      }
      const response = await route(request);
      if (response) return response;
      unhandled.push(`${request.method} ${request.path}`);
      return error(404, 'not_found');
    },
    agentSays(roomId, userId, body) {
      return append(roomId, 'm.room.message', userId, { msgtype: 'm.text', body });
    },
    announce(roomId, summary) {
      const content = encodeChannelEvent({ kind: 'member', summary, status: 'info', source: { system: 'khala-local' } });
      if (!content.ok) throw new Error('fake: invalid announcement');
      return append(roomId, 'com.khala.event.v1', LOCAL_OWNER_USER_ID, content.value as unknown as Record<string, unknown>);
    },
    echoMode(roomId, userId, mode) {
      const target = channel(roomId);
      const current = target && member(target, userId);
      if (!current || current.kind !== 'agent') throw new Error(`fake: ${userId} is not an agent in ${roomId}`);
      return memberEvent(roomId, userId, current, { [LISTENING_MODE_MEMBER_KEY]: mode });
    },
    close() {
      closed = true;
      bump();
    },
  };
}
