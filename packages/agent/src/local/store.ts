import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ensureStateDir, readJson, writeJsonAtomic, StateError } from '../state';
import { memberListeningMode } from '@khala/contracts/m1/listening-mode';
import {
  base64url, decodeChannelSecrets, decodeLocalEvent, decodeOwnerProfile, isLocalRoomId,
  newLocalRoomId, localRoomKey, newLocalEventId, LOCAL_OWNER_USER_ID, LOCAL_OWNER_ID,
  LOCAL_OWNER_DEVICE_ID, LOCAL_AGENT_DEVICE_PREFIX, LOCAL_LINK_TTL_MS, LOCAL_TOKEN_BYTES,
  type ChannelSecrets, type LocalEvent, type LocalMember, type LocalMemberContent,
  type LocalChannelSummary, type OwnerProfile,
} from '@khala/contracts/m1/local';
import type { LocalStore } from './types';

export class LocalStoreError extends Error {
  readonly code: 'not_found' | 'storage_failed';
  constructor(code: LocalStoreError['code']) { super(code); this.name = 'LocalStoreError'; this.code = code; }
}
export type OpenLocalStoreInput = {
  root: string;
  ownerDefault: OwnerProfile;
  now?: () => number;
  random?: (bytes: number) => Uint8Array;
};
export type OpenedLocalStore = LocalStore & { close(): Promise<void> };
type AppendInput = Parameters<LocalStore['append']>[1];
type StoredMember = NonNullable<ReturnType<LocalStore['member']>>;
type Channel = {
  roomId: string; dir: string; events: LocalEvent[]; byEventId: Map<string, LocalEvent>;
  byTxn: Map<string, LocalEvent>; lastMember: Map<string, { event: LocalEvent; firstSeq: number }>;
  name: string; operationId?: string; secrets: ChannelSecrets; handle?: fs.FileHandle;
  validBytes?: number; waiters: Set<() => void>;
};
const sha256 = (token: string) => createHash('sha256').update(token).digest('hex');
const emptySecrets = (): ChannelSecrets => ({ v: 1, links: {}, members: {} });
const lastSeq = (channel: Channel) => channel.events.at(-1)?.seq ?? 0;
const fire = (waiters: Set<() => void>) => { for (const done of [...waiters]) done(); };

export async function openLocalStore(input: OpenLocalStoreInput): Promise<OpenedLocalStore> {
  const { root, now = Date.now, random = randomBytes } = input;
  const channelsDir = path.join(root, 'channels');
  const channels = new Map<string, Channel>();
  const operations = new Map<string, string>();
  const agentChannel = new Map<string, string>();
  const deletedAgentTokens = new Map<string, { roomId: string; userId: string }>();
  const revisionWaiters = new Set<() => void>();
  let revision = 0;
  let queue: Promise<unknown> = Promise.resolve();
  let closed = false;
  let closing: Promise<void> | undefined;
  let owner: OwnerProfile;

  function makeChannel(roomId: string): Channel {
    return { roomId, dir: path.join(channelsDir, localRoomKey(roomId)), name: '',
      events: [], byEventId: new Map(), byTxn: new Map(), lastMember: new Map(),
      secrets: emptySecrets(), waiters: new Set() };
  }
  function indexEvent(channel: Channel, event: LocalEvent): void {
    channel.events.push(event);
    channel.byEventId.set(event.eventId, event);
    if (event.txnId !== undefined) channel.byTxn.set(`${event.sender}\u0000${event.txnId}`, event);
    if (event.type === 'm.room.create') {
      channel.name = event.content.name as string;
      if (typeof event.content.operationId === 'string') channel.operationId = event.content.operationId;
    } else if (event.type === 'm.room.name') channel.name = event.content.name as string;
    else if (event.type === 'm.room.member') {
      const user = event.content.user as string;
      const firstSeq = channel.lastMember.get(user)?.firstSeq ?? event.seq;
      channel.lastMember.set(user, { event, firstSeq });
    }
  }
  function register(channel: Channel): void {
    channels.set(channel.roomId, channel);
    if (channel.operationId !== undefined) operations.set(channel.operationId, channel.roomId);
    for (const user of channel.lastMember.keys()) {
      if (user !== LOCAL_OWNER_USER_ID) agentChannel.set(user, channel.roomId);
    }
  }
  try {
    // This checks only Khala-owned levels, not the commonly 0755 XDG state home.
    await ensureStateDir(channelsDir);
    const decodedOwner = decodeOwnerProfile(await readJson(path.join(root, 'owner.json')));
    owner = structuredClone(decodedOwner.ok ? decodedOwner.value : input.ownerDefault);
    for (const entry of await fs.readdir(channelsDir, { withFileTypes: true })) {
      const roomId = `!${entry.name}:local`;
      if (!isLocalRoomId(roomId) || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
      const channel = makeChannel(roomId);
      await ensureStateDir(channel.dir);
      let buffer: Buffer;
      try { buffer = await fs.readFile(path.join(channel.dir, 'log.jsonl')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      const completeBytes = buffer.lastIndexOf(0x0a) + 1;
      if (completeBytes < buffer.length) channel.validBytes = completeBytes;
      for (const line of buffer.subarray(0, completeBytes).toString('utf8').split('\n')) {
        let parsed: unknown;
        try { parsed = JSON.parse(line); } catch { continue; }
        const decoded = decodeLocalEvent(parsed);
        if (decoded.ok && decoded.value.roomId === roomId && decoded.value.seq > lastSeq(channel)) indexEvent(channel, decoded.value);
      }
      if (channel.events[0]?.type !== 'm.room.create') continue;
      const secrets = decodeChannelSecrets(await readJson(path.join(channel.dir, 'secrets.json')));
      channel.secrets = secrets.ok ? secrets.value : emptySecrets();
      register(channel);
    }
  } catch (error) {
    if (error instanceof StateError && error.code === 'unsafe_state_dir') throw error;
    throw new LocalStoreError('storage_failed');
  }

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    if (closed) return Promise.reject(new LocalStoreError('storage_failed'));
    const run = queue.then(task).catch(error => {
      if (error instanceof LocalStoreError) throw error;
      throw new LocalStoreError('storage_failed');
    });
    queue = run.catch(() => undefined);
    return run;
  }
  function requireChannel(roomId: string): Channel {
    const channel = channels.get(roomId);
    if (!channel) throw new LocalStoreError('not_found');
    return channel;
  }
  function bump(): void { revision++; fire(revisionWaiters); }
  async function writeEvent(channel: Channel, eventInput: AppendInput): Promise<LocalEvent> {
    const event: LocalEvent = { seq: lastSeq(channel) + 1, eventId: newLocalEventId(random(16)),
      roomId: channel.roomId, type: eventInput.type, sender: eventInput.sender, ts: now(),
      ...(eventInput.txnId !== undefined ? { txnId: eventInput.txnId } : {}), content: eventInput.content };
    // Own the input before the first await, so later caller mutations cannot alter replay.
    const stored = structuredClone(event);
    const logPath = path.join(channel.dir, 'log.jsonl');
    if (channel.validBytes !== undefined) {
      await fs.truncate(logPath, channel.validBytes);
      delete channel.validBytes;
    }
    channel.handle ??= await fs.open(logPath, 'a', 0o600);
    const start = (await channel.handle.stat()).size;
    try { await channel.handle.writeFile(JSON.stringify(stored) + '\n', 'utf8'); }
    catch (error) {
      // A failed append may have written a partial line. Retry must not append onto it.
      channel.validBytes = start;
      throw error;
    }
    indexEvent(channel, stored);
    return stored;
  }
  function waitUntil(ready: () => boolean, waiters: Set<() => void>, timeoutMs: number, signal: AbortSignal): Promise<void> {
    if (ready() || signal.aborted || closed) return Promise.resolve();
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); waiters.delete(wake); resolve(); };
      const wake = () => { if (ready() || closed) done(); };
      const timer = setTimeout(done, Math.max(0, timeoutMs));
      signal.addEventListener('abort', done, { once: true });
      waiters.add(wake);
    });
  }
  function member(channel: Channel, userId: string): StoredMember | undefined {
    const event = channel.lastMember.get(userId)?.event;
    if (!event) return undefined;
    const content = event.content as LocalMemberContent;
    const human = userId === LOCAL_OWNER_USER_ID;
    return { userId, participantId: userId, ownerId: LOCAL_OWNER_ID,
      deviceId: human ? LOCAL_OWNER_DEVICE_ID : LOCAL_AGENT_DEVICE_PREFIX + userId.slice(7, 15),
      displayName: human ? owner.username : content.displayname, kind: content.kind, membership: content.membership,
      ...(!human ? { ownerLabel: owner.username, listeningMode: memberListeningMode(content),
        ...(content.harness !== undefined ? { harness: content.harness } : {}) } : {}) };
  }
  function members(channel: Channel): LocalMember[] {
    const result: LocalMember[] = [];
    const ordered = [...channel.lastMember.entries()].sort(([a, av], [b, bv]) =>
      a === LOCAL_OWNER_USER_ID ? -1 : b === LOCAL_OWNER_USER_ID ? 1 : av.firstSeq - bv.firstSeq);
    for (const [userId] of ordered) {
      const value = member(channel, userId);
      if (value && (value.membership === 'invite' || value.membership === 'join')) result.push({ ...value, membership: value.membership });
    }
    return result;
  }
  function summary(channel: Channel): LocalChannelSummary {
    let message: LocalEvent | undefined;
    for (let i = channel.events.length - 1; i >= 0; i--) {
      const event = channel.events[i]!;
      if (event.type === 'm.room.message' && event.content.msgtype === 'm.text' && typeof event.content.body === 'string') { message = event; break; }
    }
    return { roomId: channel.roomId, name: channel.name, createdAt: new Date(channel.events[0]!.ts).toISOString(),
      lastSeq: lastSeq(channel), lastTs: channel.events.at(-1)!.ts, preview: message ? message.content.body as string : null,
      ...(message ? { lastSender: { userId: message.sender, displayName: member(channel, message.sender)?.displayName ?? message.sender } } : {}),
      members: members(channel).map(m => ({ userId: m.userId, displayName: m.displayName, kind: m.kind,
        ...(m.harness !== undefined ? { harness: m.harness } : {}) })) };
  }
  async function saveSecrets(channel: Channel, secrets: ChannelSecrets): Promise<void> {
    await writeJsonAtomic(path.join(channel.dir, 'secrets.json'), secrets);
    channel.secrets = secrets;
  }

  return {
    listChannels: () => [...channels.values()].map(summary).sort((a, b) => b.lastTs - a.lastTs || b.lastSeq - a.lastSeq || (a.roomId < b.roomId ? -1 : a.roomId > b.roomId ? 1 : 0)),
    channelSummary: roomId => { const c = channels.get(roomId); return c ? summary(c) : undefined; },
    createChannel: (name, operationId) => enqueue(async () => {
      const existing = operationId !== undefined ? operations.get(operationId) : undefined;
      if (existing) return { roomId: existing, created: false };
      let channel: Channel;
      while (true) {
        channel = makeChannel(newLocalRoomId(random(16)));
        if (channels.has(channel.roomId)) continue;
        try { await fs.lstat(channel.dir); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') break; throw error; }
      }
      await ensureStateDir(channel.dir);
      try {
        await writeEvent(channel, { type: 'm.room.create', sender: LOCAL_OWNER_USER_ID,
          content: { name, createdBy: LOCAL_OWNER_USER_ID, ...(operationId !== undefined ? { operationId } : {}) } });
        await writeEvent(channel, { type: 'm.room.member', sender: LOCAL_OWNER_USER_ID,
          content: { user: LOCAL_OWNER_USER_ID, membership: 'join', displayname: owner.username, kind: 'human' } });
        await saveSecrets(channel, emptySecrets());
      } catch (error) {
        await channel.handle?.close();
        await fs.rm(channel.dir, { recursive: true, force: true });
        throw error;
      }
      register(channel);
      bump(); bump();
      return { roomId: channel.roomId, created: true };
    }),
    findByOperation: operationId => operations.get(operationId),
    deleteChannel: roomId => enqueue(async () => {
      const channel = channels.get(roomId);
      if (!channel) return;
      await channel.handle?.close();
      delete channel.handle;
      await fs.rm(channel.dir, { recursive: true, force: true });
      // Keep only hashed agent credentials so subsequent calls report channel deletion.
      // Tombstones are process-local; deleting the directory still removes all persisted secrets.
      for (const [userId, secret] of Object.entries(channel.secrets.members)) {
        if (userId !== LOCAL_OWNER_USER_ID) deletedAgentTokens.set(secret.tokenSha256, { roomId, userId });
      }
      channels.delete(roomId);
      if (channel.operationId !== undefined) operations.delete(channel.operationId);
      for (const [user, room] of agentChannel) if (room === roomId) agentChannel.delete(user);
      bump(); fire(channel.waiters);
    }),
    hasChannel: roomId => channels.has(roomId),
    channelOfMember: userId => agentChannel.get(userId),
    revision: () => revision,
    waitForRevision: (since, timeoutMs, signal) => waitUntil(() => revision !== since, revisionWaiters, timeoutMs, signal),
    append: (roomId, eventInput) => {
      const ownedInput = structuredClone(eventInput);
      return enqueue(async () => {
        const channel = requireChannel(roomId);
        const existing = ownedInput.txnId !== undefined ? channel.byTxn.get(`${ownedInput.sender}\u0000${ownedInput.txnId}`) : undefined;
        if (existing) return structuredClone(existing);
        const event = await writeEvent(channel, ownedInput);
        if (event.type === 'm.room.member' && event.content.user !== LOCAL_OWNER_USER_ID) agentChannel.set(event.content.user as string, roomId);
        bump(); fire(channel.waiters);
        return structuredClone(event);
      });
    },
    eventsAfter: (roomId, after, limit) => {
      const events = channels.get(roomId)?.events ?? [];
      let lo = 0;
      let hi = events.length;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (events[mid]!.seq <= after) lo = mid + 1; else hi = mid;
      }
      return structuredClone(events.slice(lo, lo + Math.max(0, limit)));
    },
    waitForEvent: (roomId, after, timeoutMs, signal) => {
      const channel = channels.get(roomId);
      return channel ? waitUntil(() => !channels.has(roomId) || lastSeq(channel) > after, channel.waiters, timeoutMs, signal) : Promise.resolve();
    },
    history: (roomId, before, limit) => {
      const channel = channels.get(roomId);
      const cutoff = before !== undefined ? channel?.byEventId.get(before)?.seq : Infinity;
      if (!channel || cutoff === undefined || limit <= 0) return { events: [] };
      const candidates = channel.events.filter(e => e.seq < cutoff && (e.type === 'm.room.message' || e.type === 'com.khala.event.v1'));
      const events = candidates.slice(-limit);
      return { events: structuredClone(events), ...(candidates.length > events.length ? { nextBefore: events[0]!.eventId } : {}) };
    },
    members: roomId => { const c = channels.get(roomId); return c ? members(c) : []; },
    member: (roomId, userId) => { const c = channels.get(roomId); return c ? member(c, userId) : undefined; },
    channelName: roomId => channels.get(roomId)?.name ?? '',
    mintLink: (roomId, kind) => enqueue(async () => {
      const channel = requireChannel(roomId);
      const token = base64url(random(LOCAL_TOKEN_BYTES));
      const expiresAt = new Date(now() + LOCAL_LINK_TTL_MS).toISOString();
      await saveSecrets(channel, { ...channel.secrets, links: { ...channel.secrets.links, [sha256(token)]: { expiresAt, kind } } });
      return { token, expiresAt };
    }),
    consumeLink: token => enqueue(async () => {
      if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) return null;
      const hash = sha256(token);
      for (const channel of channels.values()) {
        const link = channel.secrets.links[hash];
        if (!link || link.consumedAt !== undefined || Date.parse(link.expiresAt) <= now()) continue;
        const consumedAt = new Date(now()).toISOString();
        await saveSecrets(channel, { ...channel.secrets, links: { ...channel.secrets.links, [hash]: { ...link, consumedAt } } });
        return { roomId: channel.roomId };
      }
      return null;
    }),
    setMemberToken: (roomId, userId, tokenSha256) => enqueue(async () => {
      const channel = requireChannel(roomId);
      const next = { ...channel.secrets.members };
      if (tokenSha256 === null) delete next[userId];
      else if (userId !== LOCAL_OWNER_USER_ID) next[userId] = { tokenSha256 };
      await saveSecrets(channel, { ...channel.secrets, members: next });
    }),
    agentForToken: token => {
      const hash = Buffer.from(sha256(token), 'hex');
      let result: { roomId: string; userId: string } | null = null;
      for (const [tokenSha256, agent] of deletedAgentTokens) {
        const candidate = Buffer.from(tokenSha256, 'hex');
        if (candidate.length === hash.length && timingSafeEqual(hash, candidate)) result = { ...agent };
      }
      for (const channel of channels.values()) for (const [userId, secret] of Object.entries(channel.secrets.members)) {
        const candidate = Buffer.from(secret.tokenSha256, 'hex');
        if (candidate.length === hash.length && timingSafeEqual(hash, candidate) && userId !== LOCAL_OWNER_USER_ID) result = { roomId: channel.roomId, userId };
      }
      return result;
    },
    owner: () => structuredClone(owner),
    setOwner: next => {
      const owned = structuredClone(next);
      return enqueue(async () => { await writeJsonAtomic(path.join(root, 'owner.json'), owned); owner = owned; bump(); });
    },
    close: () => {
      if (!closing) {
        closed = true;
        closing = (async () => {
          await queue;
          try { await Promise.all([...channels.values()].map(c => c.handle?.close())); }
          finally { fire(revisionWaiters); for (const channel of channels.values()) fire(channel.waiters); }
        })();
      }
      return closing;
    },
  };
}
