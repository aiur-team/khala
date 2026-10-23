import { channelKey, listChannels, migrateLegacy, resolveChannel, type ChannelRef } from './channels';
import path from 'node:path';
import * as fs from 'node:fs/promises';
import { decodeListeningModeCommand, type ListeningMode } from '@khala/contracts/m1/listening-mode';
import { applyArchived, applyListeningMode, delegateChannel, isDelegated, readModeState } from './mode';
import { createHash, randomBytes } from 'node:crypto';
import { encodeChannelEvent, foldCoordination, type CoordinationEvent } from '@khala/contracts/m1/channel-event';
import { validAgentRejoinSecret, type AgentCredentials, type AgentJoinCreated, type Harness } from '@khala/contracts/m1/agent-join';
import type { InboxEntry } from '@khala/contracts/m1/inbox';
import { CHANNEL_EVENT_TYPE } from '@khala/contracts/m1/channel-event';
import { createEventKeyFilter, isWakeEntry, mentions, toEventInboxEntry, wakesAgent } from './events/receive';
import { memberRenameContent } from './events/member-rename';
import { KhalaClientError, type KhalaAgentClient, type ReadFilter } from './client';
import { readActivity, usageLimited } from './activity';
import { advanceCursor, appendInbox, readCursor, readEntries, unread, unreadCount } from './inbox';
import { requestJoin, pollJoin, reportReady } from './join';
import { adapterFor } from './harness';
import { RESTORE_HISTORY_MAX_PAGES, type ChannelSession, type SessionMessage, type SessionModeCommand, type StartSession } from './transport';
import { startChannelSession } from './transport';
import { toInboxEntry, withReplyContext } from './sender';
import { LOCAL_OWNER_USER_ID } from '@khala/contracts/m1/local';
import { hostedUsernameFromAgentName, saveHostedUsername } from './local/identity';
import { TERMINAL_SESSION_DETAILS, stateRoot, ensureStateDir, filesForDir, readStateFile, removeStateFile, resolveStateDir, writeStateFile, StateError, channelFiles, readJoinFile, writeJoinFile, removeJoinFile, type SessionFiles, type StatusFile } from './state';

export type KhalaAgentClientOptions = {
  harness: Harness; sessionId: string; rejoinable?: boolean; env?: NodeJS.ProcessEnv;
  now?: () => Date; startSession?: StartSession;
  joinApi?: { requestJoin: typeof requestJoin; pollJoin: typeof pollJoin; reportReady: typeof reportReady };
  fetch?: typeof fetch; inviteTimeoutMs?: number; autoConfirmWaitMs?: number; onInboxAppend?: (entry: InboxEntry) => void;
};
type ResumeAuthorization = { link: string; label: string; workspace: string; secretHash: string; roomId: string; localCredentials?: AgentCredentials };
const terminal: readonly string[] = TERMINAL_SESSION_DETAILS;
type Attempt = {
  label: string; restore?: ResumeAuthorization; link: string; created: AgentJoinCreated & { origin: string }; controller: AbortController;
  task: Promise<void>; session?: ChannelSession; credentials?: AgentCredentials;
  failure?: KhalaClientError; files?: SessionFiles; status: StatusFile; appends: Promise<void>; acceptEventKey: ReturnType<typeof createEventKeyFilter>;
  cryptoReset?: boolean; readReceipt?: string; typingSince?: number | undefined; unsubscribe?: () => void; unsubscribeMode?: () => void; unsubscribeEnded?: () => void; joined: boolean;
};
function safeError(error: unknown): KhalaClientError {
  return error instanceof KhalaClientError ? error : new KhalaClientError('internal_error',
    error instanceof StateError ? error.code : undefined);
}

function errorDetail(error: unknown, fallback: string): string {
  const failure = safeError(error);
  if (terminal.includes(failure.message)) return failure.message;
  return ['unsafe_state_dir', 'storage_failed'].includes(failure.message) ? failure.message : fallback;
}

const TYPING_CAP_MS = 10 * 60_000;
const TYPING_STALE_BUSY_MS = 120_000;
const TYPING_WAKE_GRACE_MS = 10_000;

/** How long a delegated channel stays async to the session after a background agent's wait ends. */
const DELEGATE_GRACE_MS = 120_000;
export function createKhalaAgentClient(options: KhalaAgentClientOptions): KhalaAgentClient {
  const asyncOnly = !adapterFor(options.harness)?.codec;
  const defaultMode: ListeningMode = asyncOnly ? 'async' : 'sync';
  const dir = resolveStateDir(options.harness, options.sessionId, options.env);
  const now = options.now ?? (() => new Date());
  const fetchDeps = options.fetch ? { fetch: options.fetch } : {};
  const api = options.joinApi ?? { requestJoin, pollJoin, reportReady };
  let status: StatusFile = { state: 'idle', updatedAt: now().toISOString() };
  let initialization: Promise<void> | undefined;
  const rejoinable = options.rejoinable ?? adapterFor(options.harness)?.sessionSources[0]?.rejoinable(options.sessionId) ?? false;
  let rejoinSecret: string | undefined;
  let savedSecret: string | undefined;
  let resuming: Promise<void> | undefined;
  const restores = new Map<string, Promise<unknown>>();
  const workspace = path.resolve(options.env?.PWD ?? process.cwd());
  const secretHash = () => rejoinSecret === undefined ? '' : createHash('sha256').update(rejoinSecret).digest('hex');
  const attempts = new Map<string, Attempt>();
  const channels = new Map<string, Attempt>();
  const stored = new Map<string, ChannelRef>();
  const roomSlots = new Set<string>();
  const priorStatuses = new Map<string, StatusFile>();
  const roomChanges = new Map<string, Promise<void>>();
  let closed = false;
  let closing: Promise<void> | undefined;
  const joins = new Map<string, Promise<unknown>>();
  let statusWrites: Promise<void> = Promise.resolve();
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let heartbeatTask: Promise<void> = Promise.resolve();
  function startHeartbeat(): void {
    if (heartbeatTimer || closed) return;
    heartbeatTimer = setInterval(() => {
      heartbeatTask = heartbeatTask.catch(() => {}).then(async () => {
        // A usage limit keeps this process and its sync alive, so presence alone would still say online.
        const away = await usageLimited(dir).catch(() => false) ? 'usage limit' : undefined;
        for (const attempt of channels.values()) {
          if (current(attempt) && ['connected', 'send_failed'].includes(attempt.status.state)) {
            await setStatus(attempt, attempt.status.state, attempt.status.detail);
            if (await markDelivered(attempt)) attempt.typingSince ??= now().getTime();
            await updateTyping(attempt);
            attempt.session?.setAway?.(away);
          }
        }
      });
      void heartbeatTask.catch(() => {});
    }, 15_000);
    heartbeatTimer.unref();
  }

  /** Delivery hooks run in other processes; the read receipt for what they delivered goes from here. */
  async function markDelivered(attempt: Attempt): Promise<boolean> {
    const { session, files, credentials } = attempt;
    if (!session?.markRead || !files || !credentials) return false;
    const eventId = (await readCursor(files).catch(() => undefined))?.shownEventId;
    if (!eventId || eventId === attempt.readReceipt) return false;
    attempt.readReceipt = eventId;
    await session.markRead(credentials.roomId, eventId).catch(() => {});
    return true;
  }

  /** Web-only "typing…": shown from when channel content reaches the agent while its hook-tracked turn stays busy,
   * capped at 10 min; khala_send clears it. Typing is never delivered to agents. */
  async function updateTyping(attempt: Attempt): Promise<void> {
    const { session, credentials } = attempt;
    if (attempt.typingSince === undefined || !session?.setTyping || !credentials) return;
    const activity = await readActivity(filesForDir(dir)).catch(() => undefined);
    const since = attempt.typingSince;
    if (since === undefined) return; // khala_send cleared it during the read.
    const t = now().getTime();
    const at = activity ? Date.parse(activity.updatedAt) : 0;
    // Busy goes stale like the hooks' own fallback (Esc skips Stop). Idle since before typing started is a
    // wake still landing: it gets one heartbeat to turn busy. Idle after the start is the turn's end.
    const working = t - since < TYPING_CAP_MS && (activity?.state === 'busy'
      ? t - Math.max(at, since) < TYPING_STALE_BUSY_MS : at <= since && t - since < TYPING_WAKE_GRACE_MS);
    if (!working) attempt.typingSince = undefined;
    await session.setTyping(credentials.roomId, working).catch(() => {});
  }

  function inboxEntry(message: SessionMessage, session: ChannelSession, acceptKey: ReturnType<typeof createEventKeyFilter>): InboxEntry | null {
    const entry = toInboxEntry(message, session.displayName(message.sender));
    if (message.type === 'm.room.message') return entry;
    if (message.type !== CHANNEL_EVENT_TYPE && message.type !== 'm.room.member') return null;
    const { eventId, roomId, ts, sender, senderLabel, senderKind } = entry;
    const base = { eventId, roomId, ts, sender, senderLabel, senderKind };
    const content = message.type === 'm.room.member' ? memberRenameContent(message.content, message.previousContent) : message.content;
    const event = toEventInboxEntry(base, content, ownName(session));
    return event && acceptKey(event.key) ? event.entry : null;
  }
  // ponytail: the fold sees the newest FOLD_PAGES x 100 events; older claims, handoffs and notes are forgotten.
  const FOLD_PAGES = 5;
  /** Pages back from `before` (newest when undefined), oldest entry first, until `enough` holds or pages run out. */
  async function scan(session: ChannelSession, roomId: string, before?: string, enough: (entries: InboxEntry[]) => boolean = () => false) {
    let entries: InboxEntry[] = [];
    let cursor = before;
    const acceptKey = createEventKeyFilter();
    for (let page = 0; page < FOLD_PAGES; page++) {
      const result = await session.history(roomId, 100, cursor);
      entries = [...result.messages.filter(m => m.roomId === roomId).map(m => inboxEntry(m, session, acceptKey))
        .filter((entry): entry is InboxEntry => entry !== null), ...entries];
      cursor = result.nextBefore;
      if (cursor === undefined || enough(entries)) break;
    }
    return { entries, ...(cursor !== undefined ? { nextBefore: cursor } : {}) };
  }
  function coordination(events: readonly CoordinationEvent[]) {
    const state = foldCoordination(events);
    return { ...(state.openHandoffs.length ? { openHandoffs: state.openHandoffs } : {}),
      ...(state.activeClaims.length ? { activeClaims: state.activeClaims } : {}),
      ...(Object.keys(state.notes).length ? { notes: state.notes } : {}) };
  }
  // ponytail: fold.json keeps the newest FOLD_EVENTS coordination events; older ones are forgotten.
  const FOLD_EVENTS = 1000;
  /** Folds coordination state incrementally: pages back only to the newest entry fold.json has seen. */
  async function foldedState(session: ChannelSession, roomId: string, dir: string | undefined) {
    type Fold = { lastEventId: string; events: CoordinationEvent[] };
    const cached = dir ? await readStateFile<Fold>(dir, 'fold.json').catch(() => null) : null;
    const valid = cached && typeof cached.lastEventId === 'string' && Array.isArray(cached.events) ? cached : null;
    const scanned = await scan(session, roomId, undefined, entries => valid !== null && entries.some(entry => entry.eventId === valid.lastEventId));
    const seen = valid ? scanned.entries.findIndex(entry => entry.eventId === valid.lastEventId) : -1;
    const events = [...(seen >= 0 ? valid!.events : []), ...(seen >= 0 ? scanned.entries.slice(seen + 1) : scanned.entries).flatMap(entry =>
      entry.eventKind && entry.data ? [{ sender: entry.sender, by: entry.senderLabel, at: entry.ts, content: { kind: entry.eventKind, data: entry.data } }] : [])]
      .slice(-FOLD_EVENTS);
    const newest = scanned.entries.at(-1)?.eventId;
    if (dir && newest && newest !== valid?.lastEventId) await writeStateFile(dir, 'fold.json', { lastEventId: newest, events }).catch(() => {});
    return coordination(events);
  }

  function refs(): ChannelRef[] {
    return [...stored.values()].sort((a, b) => (a.channelName ?? '').localeCompare(b.channelName ?? '') || a.roomId.localeCompare(b.roomId));
  }
  function writeAggregate(detail?: string): Promise<void> {
    if (closed) detail = 'closed';
    const values = [...new Set([...channels.values(), ...attempts.values()])].map(channel => channel.status);
    const state = closed ? 'disconnected' : values.some(item => item.state === 'connected') ? 'connected'
      : values.some(item => item.state === 'send_failed') ? 'send_failed'
      : [...attempts.values()].some(item => current(item) && item.status.state === 'joining') ? 'joining'
      : values.some(item => item.state === 'disconnected') ? 'disconnected' : 'idle';
    const single: Partial<StatusFile> | undefined = channels.size === 1 ? [...channels.values()][0]!.status : stored.size === 1 ? priorStatuses.get(refs()[0]!.key) : undefined;
    status = { state, ...(single?.channelName !== undefined ? { channelName: single.channelName } : {}),
      ...(single?.displayName !== undefined ? { displayName: single.displayName } : {}),
      ...(detail !== undefined ? { detail } : single?.detail !== undefined ? { detail: single.detail } : {}), updatedAt: now().toISOString() };
    if (['connected', 'send_failed'].includes(state)) status.heartbeatAt = status.updatedAt;
    const next = status;
    statusWrites = statusWrites.catch(() => {}).then(() => writeStateFile(dir, 'status.json', next));
    return statusWrites;
  }
  async function setStatus(attempt: Attempt, state: StatusFile['state'], detail?: string): Promise<void> {
    attempt.status = { state, ...(attempt.status.channelName !== undefined ? { channelName: attempt.status.channelName } : {}),
      ...(attempt.status.displayName !== undefined ? { displayName: attempt.status.displayName } : {}),
      ...(detail !== undefined ? { detail } : {}), updatedAt: now().toISOString() };
    if (['connected', 'send_failed'].includes(state)) {
      attempt.status.heartbeatAt = attempt.status.updatedAt;
      startHeartbeat();
    }
    const snapshot = attempt.status;
    if (attempt.files) {
      statusWrites = statusWrites.catch(() => {}).then(() => writeStateFile(attempt.files!.dir, 'status.json', snapshot));
      await statusWrites;
    }
    await writeAggregate(channels.size === 0 ? detail : undefined);
  }
  /**
   * The agent's own current name, as `khala_status.displayName` reports it; a rename event names it first.
   * Only the local helper's owner may name another subject in `content.user`. Hosted member content is
   * member-controlled, so there a rename counts only when the agent itself sent it (owner cascades do).
   */
  function ownName(session: ChannelSession, message?: SessionMessage, local = false): string | undefined {
    if (message?.type === 'm.room.member') {
      const subject = local && message.sender === LOCAL_OWNER_USER_ID && typeof message.content.user === 'string'
        ? message.content.user : message.sender;
      const renamed = message.content.displayname;
      if (subject === session.userId && typeof renamed === 'string' && renamed.trim()) return renamed;
    }
    return session.displayName(session.userId);
  }
  /** Persists the own name for hooks, which run in another process and read status.json. */
  async function trackOwnName(attempt: Attempt, session: ChannelSession, message: SessionMessage, local: boolean): Promise<void> {
    const name = ownName(session, message, local);
    if (name === undefined || name === attempt.status.displayName) return;
    attempt.status.displayName = name;
    await setStatus(attempt, attempt.status.state, attempt.status.detail);
  }
  function initialize(): Promise<void> {
    return initialization ??= (async () => {
      await ensureStateDir(dir);
      await migrateLegacy(filesForDir(dir));
      if (rejoinable) {
        // A missing, unparsable or malformed secret is replaced: the worst case is one fresh "-N" member.
        const saved = (await readStateFile<{ secret?: unknown } | null>(dir, 'rejoin.json'))?.secret;
        if (validAgentRejoinSecret(saved)) savedSecret = rejoinSecret = saved;
        else await writeStateFile(dir, 'rejoin.json', { secret: rejoinSecret = randomBytes(32).toString('base64url') });
      }
      // Re-joining requires fresh credentials; the server reuses membership by session.
      for (const ref of await listChannels(filesForDir(dir))) {
        const existing = stored.get(ref.key);
        if (!existing || existing.legacy && !ref.legacy) stored.set(ref.key, ref);
        roomSlots.add(ref.key);
        await removeStateFile(ref.files.dir, 'session.json');
        const previous = await readStateFile<StatusFile>(ref.files.dir, 'status.json');
        const snapshot: StatusFile = { ...previous, state: 'disconnected', ...(previous?.channelName ?? ref.channelName ? { channelName: (previous?.channelName ?? ref.channelName)! } : {}), updatedAt: now().toISOString() };
        priorStatuses.set(ref.key, snapshot);
        await writeStateFile(ref.files.dir, 'status.json', snapshot);
      }
      await removeStateFile(dir, 'session.json');
      await writeAggregate();
    })();
  }
  function current(attempt: Attempt): boolean {
    return attempts.get(attempt.link) === attempt && !closed && !attempt.controller.signal.aborted;
  }
  async function cleanup(attempt: Attempt, discardResume = terminal.includes(attempt.status.detail ?? '')): Promise<void> {
    attempt.unsubscribe?.();
    attempt.unsubscribeMode?.();
    attempt.unsubscribeEnded?.();
    const session = attempt.session;
    delete attempt.session;
    await session?.stop().catch(() => { console.error('khala: crypto_cleanup_failed'); });
    if (attempt.files) {
      await removeStateFile(attempt.files.dir, 'session.json');
      if (discardResume) await removeStateFile(attempt.files.dir, 'resume.json');
      if (discardResume && attempt.credentials?.transport !== 'local' && !attempt.restore?.localCredentials) {
        await (await import('./matrix/crypto-store')).wipeCryptoStore(attempt.files.dir, stateRoot(options.env), options.fetch ?? fetch);
      }
    }
  }
  async function cancel(attempt: Attempt): Promise<void> {
    attempt.controller.abort();
    await attempt.task;
    await attempt.appends;
    await cleanup(attempt);
    if (attempts.get(attempt.link) === attempt) attempts.delete(attempt.link);
  }
  function pendingAttempts(): Attempt[] {
    return [...attempts.values()].filter(attempt => current(attempt) && !attempt.joined
      && (!attempt.restore || !stored.has(channelKey(attempt.restore.roomId)))
      && (!attempt.credentials || !stored.has(channelKey(attempt.credentials.roomId))));
  }
  function select(channel?: string): ChannelRef {
    const pending = pendingAttempts();
    if (channel === undefined && stored.size + pending.length > 1) {
      throw new KhalaClientError('channel_required', undefined, { channels: [
        ...refs().map(ref => ({ channel: ref.channelName ?? ref.roomId, roomId: ref.roomId })),
        ...pending.map(attempt => ({ channel: attempt.link, roomId: attempt.credentials?.roomId ?? attempt.link })),
      ] });
    }
    const result = resolveChannel(refs(), channel);
    if (!result.ok) {
      if (channel === undefined && stored.size === 0) throw new KhalaClientError('not_connected');
      throw new KhalaClientError(result.code, undefined, { channels: result.channels });
    }
    return result.channel;
  }
  function requireSession(channel?: string): { session: ChannelSession; credentials: AgentCredentials; attempt: Attempt } {
    const ref = select(channel);
    const attempt = channels.get(ref.key);
    if (closed || !attempt?.joined || attempt.controller.signal.aborted || !attempt.session || !attempt.credentials) throw new KhalaClientError('not_connected');
    return { session: attempt.session, credentials: attempt.credentials, attempt };
  }
  async function publishMode(attempt: Attempt, session: ChannelSession, roomId: string, mode: ListeningMode): Promise<boolean> {
    const controller = new AbortController();
    let release = () => {};
    const aborted = new Promise<boolean>(resolve => { release = () => resolve(false); });
    const abort = () => { controller.abort(); release(); };
    const timer = setTimeout(abort, 5000);
    attempt.controller.signal.addEventListener('abort', abort, { once: true });
    try {
      if (attempt.controller.signal.aborted) { abort(); return false; }
      return await Promise.race([session.publishListeningMode(roomId, mode, controller.signal).then(() => true, () => false), aborted]);
    } finally {
      clearTimeout(timer);
      attempt.controller.signal.removeEventListener('abort', abort);
    }
  }
  async function background(attempt: Attempt): Promise<void> {
    const { signal } = attempt.controller;
    let abort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new KhalaClientError('internal_error'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
    void aborted.catch(() => {});
    const wait = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, aborted]);
    try {
      // joinedAt renews wake budgets on reconnect; keep a separate history boundary.
      let originalJoinedAt = now().toISOString();
      let savedEntries: InboxEntry[] = [];
      let savedJoinBoundary = false;
      if (attempt.restore && attempt.files) {
        const metadata = await readStateFile<{ joinedAt?: string; originalJoinedAt?: string }>(attempt.files.dir, 'channel.json');
        const boundary = metadata?.originalJoinedAt ?? metadata?.joinedAt;
        if (boundary && Number.isFinite(Date.parse(boundary))) { originalJoinedAt = boundary; savedJoinBoundary = true; }
        savedEntries = await readEntries(attempt.files);
      }
      const input = { origin: attempt.created.origin, joinId: attempt.created.joinId, pollSecret: attempt.created.pollSecret };
      const issuedCredentials = attempt.restore?.localCredentials ?? await wait(api.pollJoin(input, { signal, ...fetchDeps }));
      // Confirmed: the agent now connects, waits for its invite and syncs, so status says so (no silent 'joining').
      if (!attempt.restore && current(attempt)) await setStatus(attempt, 'joining', 'confirmed_syncing');
      let credentials = issuedCredentials;
      if (attempt.restore && credentials.roomId !== attempt.restore.roomId) {
        await removeStateFile(attempt.files!.dir, 'resume.json');
        await (await import('./matrix/crypto-store')).wipeCryptoStore(attempt.files!.dir, stateRoot(options.env), options.fetch ?? fetch);
        throw new KhalaClientError('not_connected', 'unauthorized');
      }
      if (attempt.restore && !attempt.restore.localCredentials) {
        const cryptoStore = await import('./matrix/crypto-store');
        try { credentials = await cryptoStore.restoredCredentials(attempt.files!.dir, credentials); }
        catch (error) {
          if (!(error instanceof cryptoStore.CryptoStoreCorruptError)) throw error;
          await cryptoStore.wipeCryptoStore(attempt.files!.dir, stateRoot(options.env), options.fetch ?? fetch);
          attempt.cryptoReset = true;
        }
      }
      if (!current(attempt)) return;
      const key = channelKey(credentials.roomId);
      const claim = (roomChanges.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
        if (!current(attempt)) return;
        if (!roomSlots.has(key) && roomSlots.size >= 16) throw new KhalaClientError('channel_limit');
        // Claim the distinct room before any filesystem or cancellation await.
        roomSlots.add(key);
        const previous = channels.get(key);
        if (previous && previous !== attempt) await cancel(previous);
        if (!current(attempt)) return;
        attempt.credentials = credentials;
        attempt.files = channelFiles(filesForDir(dir), credentials.roomId);
        await ensureStateDir(attempt.files.dir);
        channels.set(key, attempt);
        const old = stored.get(key);
        stored.set(key, { key, roomId: credentials.roomId, ...(old?.channelName ? { channelName: old.channelName } : {}), files: attempt.files, legacy: false });
        await writeStateFile(attempt.files.dir, 'channel.json', { roomId: credentials.roomId, channelName: old?.channelName, joinedAt: now().toISOString(), originalJoinedAt });
      });
      roomChanges.set(key, claim);
      try { await wait(claim); } catch (error) {
        if (!stored.has(key)) roomSlots.delete(key);
        throw error;
      }
      if (!current(attempt) || !attempt.files) return;
      const channelDir = attempt.files.dir;
      await writeStateFile(channelDir, 'session.json', credentials);
      if (!current(attempt)) return;
      const restoreStopAtEventId = savedEntries.at(-1)?.eventId;
      const start = () => (options.startSession ?? startChannelSession)(credentials, { ...(credentials.transport === 'local' ? {} : { cryptoStore: { dir: channelDir, root: stateRoot(options.env) } }), ...(restoreStopAtEventId ? { restoreStopAtEventId } : {}), checkRemoved: async () => {
        try {
          const url = new URL('/api/agent/session/status', attempt.created.origin);
          url.searchParams.set('userId', credentials.userId);
          url.searchParams.set('roomId', credentials.roomId);
          const response = await (options.fetch ?? fetch)(url, {
            headers: { authorization: `Bearer ${credentials.accessToken}` }, signal: AbortSignal.timeout(5000),
          });
          if (!response.ok) return false;
          const body: unknown = await response.json();
          return typeof body === 'object' && body !== null && 'removed' in body && body.removed === true;
        } catch { return false; }
      } }).then(async session => {
        if (!current(attempt)) { await session.stop(); throw new KhalaClientError('internal_error'); }
        attempt.session = session;
        return session;
      });
      let session: ChannelSession;
      try { session = await wait(start()); }
      catch (error) {
        const cryptoStore = await import('./matrix/crypto-store');
        if (!(error instanceof cryptoStore.CryptoStoreCorruptError) || credentials.accessToken === issuedCredentials.accessToken) throw error;
        await cryptoStore.wipeCryptoStore(channelDir, stateRoot(options.env), options.fetch ?? fetch);
        credentials = issuedCredentials;
        attempt.credentials = credentials;
        attempt.cryptoReset = true;
        await writeStateFile(channelDir, 'session.json', credentials);
        session = await wait(start());
      }
      if (session.onEnded) attempt.unsubscribeEnded = session.onEnded(reason => {
        if (!current(attempt)) return;
        // Serialize terminal writes with intake so a new room claim waits for
        // all old-attempt writes before creating its replacement session.
        attempt.appends = attempt.appends.then(async () => {
          if (terminal.includes(reason)) await cleanup(attempt, true);
          await setStatus(attempt, 'disconnected', reason);
        }).catch(() => {});
        attempt.controller.abort();
      });
      const buffered: (() => void)[] = [];
      const intake = (message: SessionMessage): void => {
        if (!current(attempt) || message.roomId !== credentials.roomId || (message.sender === session.userId && message.type !== 'm.room.member')) return;
        if (!attempt.joined) { buffered.push(() => intake(message)); return; }
        attempt.appends = attempt.appends.then(async () => {
          if (!current(attempt)) return;
          // Before the entry lands, so the frame that delivers a rename already says the new name.
          if (message.type === 'm.room.member') await trackOwnName(attempt, session, message, credentials.transport === 'local');
          const entry = inboxEntry(message, session, attempt.acceptEventKey);
          if (!entry) return;
          if (await appendInbox(channelDir, entry) && current(attempt) && isWakeEntry(entry)) {
            try { options.onInboxAppend?.(entry); } catch { /* A waker cannot break intake. */ }
          }
        }).catch(async () => {
          if (current(attempt)) await setStatus(attempt, 'disconnected', 'internal_error').catch(() => {});
        });
      };
      const intakeMode = (command: SessionModeCommand): void => {
        if (!current(attempt) || command.roomId !== credentials.roomId) return;
        if (!attempt.joined) { buffered.push(() => intakeMode(command)); return; }
        if (command.sender !== session.inviter(credentials.roomId)) return;
        const decoded = decodeListeningModeCommand(command.content);
        if (!decoded.ok || decoded.value.agent !== session.userId) return;
        attempt.appends = attempt.appends.then(async () => {
          if (!current(attempt)) return;
          const previous = await readStateFile<{ eventId?: string; eventTs?: number; pendingPublish?: boolean }>(channelDir, 'mode.json');
          if ((previous?.eventId === command.eventId && !previous.pendingPublish) || (previous?.eventTs !== undefined && command.ts < previous.eventTs)) return;
          const mode = asyncOnly ? 'async' : decoded.value.mode;
          const published = await publishMode(attempt, session, credentials.roomId, mode);
          await applyListeningMode(attempt.files!, mode, { changedBy: 'owner', eventId: command.eventId, eventTs: command.ts, ...(published ? {} : { pendingPublish: true }) }, now);
        }).catch(async () => {
          if (current(attempt)) await setStatus(attempt, 'disconnected', 'internal_error').catch(() => {});
        });
      };
      attempt.unsubscribe = session.onMessage(intake);
      const stopMode = session.onListeningModeCommand(intakeMode);
      const intakeArchived = (roomId: string, archived: boolean): void => {
        if (!current(attempt) || roomId !== credentials.roomId) return;
        // Join writes mode.json directly; queue behind it like owner mode commands.
        if (!attempt.joined) { buffered.push(() => intakeArchived(roomId, archived)); return; }
        attempt.appends = attempt.appends.then(async () => { if (current(attempt)) await applyArchived(attempt.files!, archived); })
          .catch(async () => { if (current(attempt)) await setStatus(attempt, 'disconnected', 'internal_error').catch(() => {}); });
      };
      const stopArchive = session.onOwnerArchived?.(intakeArchived);
      attempt.unsubscribeMode = () => { stopMode(); stopArchive?.(); };
      if (!attempt.restore?.localCredentials) await wait(api.reportReady(input, { signal, timeoutMs: options.inviteTimeoutMs ?? 120_000, ...fetchDeps }));
      await wait(session.waitForInvite(credentials.roomId, options.inviteTimeoutMs ?? 120_000));
      await wait(session.join(credentials.roomId));
      if (!current(attempt)) return;
      const membershipTime = session.joinedAt?.(credentials.roomId);
      if (!savedJoinBoundary && membershipTime !== undefined) originalJoinedAt = new Date(membershipTime).toISOString();
      if (asyncOnly) {
        await writeStateFile(channelDir, 'mode.json', { mode: 'async' });
        await publishMode(attempt, session, credentials.roomId, 'async');
      } else if (session.listeningMode) {
        const previous = await readStateFile<Record<string, unknown>>(channelDir, 'mode.json');
        await writeStateFile(channelDir, 'mode.json', { ...previous, mode: session.listeningMode(credentials.roomId) });
      } else await removeStateFile(channelDir, 'mode.json');
      if (session.ownerArchived && !asyncOnly) await applyArchived(attempt.files!, session.ownerArchived(credentials.roomId));
      // Subscribe first and hold live events until older gap messages are queued.
      // The inbox tail (not the delivery cursor) is the durable intake boundary.
      const missed: SessionMessage[][] = [];
      if (attempt.restore && !session.recoversOnJoin) {
        const lastEventId = savedEntries.at(-1)?.eventId;
        const cutoff = Date.parse(originalJoinedAt);
        let before: string | undefined;
        const visited = new Set<string>();
        while (current(attempt)) {
          const page = await wait(session.history(credentials.roomId, 100, before, { includeUnavailable: false, ...(lastEventId ? { stopAtEventId: lastEventId } : {}) }));
          const boundary = page.messages.findIndex(message => message.eventId === lastEventId);
          missed.push(page.messages.slice(boundary + 1).filter(message => message.ts >= cutoff));
          if (page.reachedBoundary || (page.oldestTs !== undefined && page.oldestTs < cutoff) || boundary !== -1 || page.messages.some(message => message.ts < cutoff) || !page.nextBefore || visited.has(page.nextBefore)) break;
          if (missed.length >= RESTORE_HISTORY_MAX_PAGES) {
            process.stderr.write(`restore_catchup_truncated pages=${missed.length}\n`);
            break;
          }
          visited.add(page.nextBefore);
          before = page.nextBefore;
        }
      }
      if (!current(attempt)) return;
      attempt.joined = true;
      for (const page of missed.reverse()) for (const message of page) intake(message);
      for (const deliver of buffered) deliver();
      attempt.status.channelName = session.roomName(credentials.roomId) ?? credentials.roomId;
      stored.set(key, { ...stored.get(key)!, channelName: attempt.status.channelName });
      await writeStateFile(channelDir, 'channel.json', { roomId: credentials.roomId, channelName: attempt.status.channelName, joinedAt: now().toISOString(), originalJoinedAt });
      const own = ownName(session);
      if (own !== undefined) attempt.status.displayName = own;
      if (credentials.transport !== 'local') {
        const username = own === undefined ? null : hostedUsernameFromAgentName(own, options.harness);
        if (username !== null) attempt.appends = attempt.appends.then(() => saveHostedUsername(username, options.env)).catch(() => {});
      }
      await wait(attempt.appends);
      await removeJoinFile(filesForDir(dir), attempt.link);
      if (current(attempt)) {
        if (rejoinable && rejoinSecret) await writeStateFile(channelDir, 'resume.json', { link: attempt.link, label: attempt.label, workspace, secretHash: secretHash(), roomId: credentials.roomId, ...(credentials.transport === 'local' ? { localCredentials: credentials } : {}) } satisfies ResumeAuthorization);
        await setStatus(attempt, 'connected', attempt.cryptoReset || session.cryptoReset ? 'crypto_reset' : undefined);
        if (credentials.accessToken !== issuedCredentials.accessToken) {
          // Control currently creates a device for each rejoin. Once the saved
          // device has joined successfully, retire that unused replacement.
          try {
            const response = await (options.fetch ?? fetch)(`${issuedCredentials.homeserver}/_matrix/client/v3/logout`, {
              method: 'POST', headers: { authorization: `Bearer ${issuedCredentials.accessToken}`, 'content-type': 'application/json' },
              body: '{}', signal: AbortSignal.timeout(5000),
            });
            if (!response.ok && response.status !== 401) console.error('khala: unused_device_logout_failed');
          } catch { console.error('khala: unused_device_logout_failed'); }
        }
      }
    } catch (error) {
      if (current(attempt)) {
        attempt.joined = false;
        const localStatus = attempt.restore?.localCredentials && typeof error === 'object' && error !== null && 'status' in error ? error.status : undefined;
        const failure = localStatus === 401 || localStatus === 403 || localStatus === 404
          ? new KhalaClientError('not_connected', localStatus === 401 ? 'unauthorized' : localStatus === 403 ? 'removed' : 'channel_deleted') : safeError(error);
        const inviteTimeout = error instanceof Error && error.message === 'invite_timeout';
        attempt.failure = new KhalaClientError(failure.code, failure.code === 'join_expired' ? 'join_expired' : inviteTimeout ? 'invite_timeout' : errorDetail(failure, failure.code));
        await cleanup(attempt, terminal.includes(failure.message));
        await setStatus(attempt, failure.code === 'join_expired' ? 'idle' : 'disconnected',
          failure.code === 'join_expired' ? 'join_expired' : inviteTimeout ? 'invite_timeout' : errorDetail(failure, failure.code));
        attempt.controller.abort();
      }
    } finally {
      if (abort) signal.removeEventListener('abort', abort);
    }
  }

  async function settleAutoConfirmed(attempt: Attempt): Promise<'connected' | 'failed' | 'pending'> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>(resolve => { timer = setTimeout(resolve, options.autoConfirmWaitMs ?? 15_000); });
    try { await Promise.race([attempt.task, timeout]); } finally { clearTimeout(timer); }
    if (closed || attempt.controller.signal.aborted) return 'failed';
    if (current(attempt) && attempt.joined) return 'connected';
    return current(attempt) ? 'pending' : 'failed';
  }

  function join(link: string, label: string, restore?: ResumeAuthorization): ReturnType<KhalaAgentClient['join']> {
      const task = (joins.get(link) ?? Promise.resolve()).catch(() => {}).then(async () => {
        await initialize();
        if (closed) throw new KhalaClientError('not_connected');
        const existing = attempts.get(link);
        if (existing && current(existing)) {
          if (existing.joined) return { state: 'connected' as const, channelName: existing.status.channelName!, channels: refs().map(ref => ref.roomId) };
          return { state: 'awaiting_confirmation' as const, confirmUrl: existing.created.confirmUrl, ...(existing.created.autoConfirmed === true ? { autoConfirmed: true as const } : {}) };
        }
        if (existing) await cancel(existing);
        const saved = await readJoinFile(filesForDir(dir), link);
        if (saved?.link === link && Date.parse(saved.expiresAt) <= now().getTime()) {
          await removeJoinFile(filesForDir(dir), link);
          await writeAggregate('join_expired');
          throw new KhalaClientError('join_expired');
        }
        if (closed) throw new KhalaClientError('not_connected');
        // Track the pending link before requestJoin yields; room capacity is checked on credentials.
        const attempt: Attempt = { link, label, ...(restore ? { restore, files: channelFiles(filesForDir(dir), restore.roomId) } : {}), created: { origin: '', joinId: '', pollSecret: '', confirmUrl: '', expiresAt: '' },
          controller: new AbortController(), task: Promise.resolve(), joined: false,
          status: { state: 'joining', updatedAt: now().toISOString() }, appends: Promise.resolve(), acceptEventKey: createEventKeyFilter() };
        if (restore) attempt.status = { ...(await readStateFile<StatusFile>(attempt.files!.dir, 'status.json')), state: 'joining', updatedAt: now().toISOString() };
        attempts.set(link, attempt);
        if (restore) { channels.set(channelKey(restore.roomId), attempt); await setStatus(attempt, 'joining'); }
        try {
          if (restore && !restore.localCredentials) {
            const state = await (await import('./matrix/crypto-store')).validateCryptoToken(attempt.files!.dir, options.fetch ?? fetch);
            if (state === 'corrupt') {
              await (await import('./matrix/crypto-store')).wipeCryptoStore(attempt.files!.dir, stateRoot(options.env), options.fetch ?? fetch);
              attempt.cryptoReset = true;
            }
            if (state === 'revoked') throw new KhalaClientError('not_connected', 'unauthorized');
            if (state === 'unavailable') throw new KhalaClientError('not_connected', 'link_unavailable');
          }
          const signal = restore ? AbortSignal.any([attempt.controller.signal, AbortSignal.timeout(10_000)]) : attempt.controller.signal;
          let releaseAbort: (() => void) | undefined;
          const aborted = new Promise<never>((_, reject) => {
            releaseAbort = () => reject(new KhalaClientError('not_connected'));
            signal.addEventListener('abort', releaseAbort, { once: true });
            if (signal.aborted) releaseAbort();
          });
          const request = restore?.localCredentials ? Promise.resolve({ ...attempt.created, origin: new URL(link).origin, autoConfirmed: true as const })
            : api.requestJoin({ link, harness: options.harness, label, ...(rejoinSecret === undefined ? {} : { sessionId: options.sessionId, rejoinSecret }) }, { ...(options.env ? { env: options.env } : {}), ...(restore ? { fetch: (input, init) => (options.fetch ?? fetch)(input, { ...init, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal }) } : fetchDeps) });
          const created = await Promise.race([request, aborted]).finally(() => { if (releaseAbort) signal.removeEventListener('abort', releaseAbort); });
          if (closed) throw new KhalaClientError('not_connected');
          if (restore && created.autoConfirmed !== true) {
            // Old control has no cancellation endpoint. Abandon this unconfirmed
            // request without polling; it expires server-side. Keep authorization
            // and the reminder so an explicit authorized join can still proceed.
            throw new KhalaClientError('not_connected', 'rejoin_needed');
          }
          attempt.created = created;
          const { joinId, pollSecret, confirmUrl, expiresAt } = created;
          if (!restore?.localCredentials) await writeJoinFile(filesForDir(dir), link, { joinId, pollSecret, confirmUrl, expiresAt, link });
          await writeAggregate();
          attempt.task = background(attempt).catch(() => {});
          if (created.autoConfirmed !== true) return { state: 'awaiting_confirmation' as const, confirmUrl };
        } catch (error) {
          if (restore && terminal.includes(safeError(error).message)) {
            await removeStateFile(attempt.files!.dir, 'resume.json');
            if (!restore.localCredentials) await (await import('./matrix/crypto-store')).wipeCryptoStore(attempt.files!.dir, stateRoot(options.env), options.fetch ?? fetch);
          }
          if (restore && !closed && !attempt.controller.signal.aborted) await setStatus(attempt, 'disconnected', safeError(error).message);
          attempts.delete(link);
          if (!closed) await writeAggregate(safeError(error).message);
          throw safeError(error);
        }
        const outcome = await settleAutoConfirmed(attempt);
        if (outcome === 'connected') return { state: 'connected' as const, channelName: attempt.status.channelName ?? attempt.credentials!.roomId, channels: refs().map(ref => ref.roomId) };
        if (outcome === 'failed') {
          if (closed) throw new KhalaClientError('not_connected');
          throw attempt.failure ?? new KhalaClientError('internal_error', attempt.status.detail ?? 'internal_error');
        }
        return { state: 'awaiting_confirmation' as const, confirmUrl: attempt.created.confirmUrl, autoConfirmed: true as const };
      });
      joins.set(link, task);
      const release = () => { if (joins.get(link) === task) joins.delete(link); };
      void task.then(release, release);
      return task;
  }
  async function readOne(limit: number, before: string | undefined, channel: string | undefined, filter: ReadFilter | undefined): ReturnType<KhalaAgentClient['read']> {
    const { session, credentials, attempt } = requireSession(channel);
    try {
      const you = ownName(session);
      // Folding pages back through history, so it runs only when the caller asks for state (or filters by kind).
      const state = filter?.include?.includes('state') || filter?.kinds
        ? await foldedState(session, credentials.roomId, attempt.files?.dir) : {};
      // Hosted only: who is around, who has read your messages, and a read receipt for what you just read.
      const presence = (messages: InboxEntry[]) => {
        const newest = messages.at(-1);
        if (before === undefined && newest && session.markRead) void session.markRead(credentials.roomId, newest.eventId).catch(() => {});
        if (before === undefined && newest && newest.sender !== session.userId && session.setTyping) {
          attempt.typingSince = now().getTime();
          void session.setTyping(credentials.roomId, true).catch(() => {});
        }
        return { ...(you !== undefined ? { you } : {}), ...(session.members ? { members: session.members(credentials.roomId) } : {}),
          messages: withReplyContext(messages).map(entry => {
            const seenBy = entry.sender === session.userId ? session.seenBy?.(credentials.roomId, entry.eventId) ?? [] : [];
            return seenBy.length ? { ...entry, seenBy } : entry;
          }) };
      };
      if (filter?.kinds || filter?.mentionsOnly) {
        const matches = (entry: InboxEntry) => (!filter.kinds || filter.kinds.includes(entry.kind === 'message' ? 'message' : entry.eventKind ?? 'event'))
          && (!filter.mentionsOnly || entry.mention === true || mentions(entry, you));
        const found = await scan(session, credentials.roomId, before, entries => entries.filter(matches).length > limit);
        const selected = found.entries.filter(matches);
        const messages = selected.slice(-limit);
        const nextBefore = selected.length > limit ? messages[0]!.eventId : found.nextBefore;
        return { ...presence(messages), ...(nextBefore !== undefined ? { nextBefore } : {}), ...state };
      }
      const page = await session.history(credentials.roomId, limit, before);
      const acceptKey = createEventKeyFilter();
      const messages = page.messages.filter(m => m.roomId === credentials.roomId).map(m => inboxEntry(m, session, acceptKey)).filter((entry): entry is InboxEntry => entry !== null);
      return { ...presence(messages), ...(page.nextBefore !== undefined ? { nextBefore: page.nextBefore } : {}), ...state };
    } catch (error) { throw safeError(error); }
  }
  return {
    join,
    resume() {
      return resuming ??= (async () => {
        await initialize();
        if (closed || !rejoinable) return;
        await Promise.all(refs().map(async ref => {
          const authorization = await readStateFile<ResumeAuthorization>(ref.files.dir, 'resume.json');
          if (!authorization) return;
          const previous = priorStatuses.get(ref.key);
          if (terminal.includes(previous?.detail ?? '')) {
            await removeStateFile(ref.files.dir, 'resume.json');
            await (await import('./matrix/crypto-store')).wipeCryptoStore(ref.files.dir, stateRoot(options.env), options.fetch ?? fetch);
            return;
          }
          if (!savedSecret || authorization.secretHash !== secretHash() || authorization.workspace !== workspace || authorization.roomId !== ref.roomId || authorization.localCredentials && (authorization.localCredentials.transport !== 'local' || authorization.localCredentials.roomId !== ref.roomId) || typeof authorization.link !== 'string' || typeof authorization.label !== 'string') {
            await removeStateFile(ref.files.dir, 'resume.json');
            await (await import('./matrix/crypto-store')).wipeCryptoStore(ref.files.dir, stateRoot(options.env), options.fetch ?? fetch);
            return;
          }
          const restoring = join(authorization.link, authorization.label, authorization).catch(() => {});
          restores.set(ref.key, restoring);
          void restoring.then(() => { if (restores.get(ref.key) === restoring) restores.delete(ref.key); });
        }));
      })();
    },
    async status(channel) {
      await initialize();
      const selected = channel === undefined ? refs() : [select(channel)];
      const pendingRestores = selected.flatMap(ref => { const restoring = restores.get(ref.key); return restoring ? [restoring] : []; });
      if (pendingRestores.length) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([Promise.all(pendingRestores), new Promise<void>(resolve => { timer = setTimeout(resolve, 1_000); })]);
        } finally { if (timer) clearTimeout(timer); }
      }
      await Promise.all(selected.map(ref => { const attempt = channels.get(ref.key); return attempt?.joined && !attempt.restore ? attempt.task : undefined; }));
      await Promise.all(selected.map(ref => channels.get(ref.key)?.appends));
      const items: import('./client').ChannelStatus[] = await Promise.all(selected.map(async ref => {
        const attempt = channels.get(ref.key);
        const session = attempt?.joined && current(attempt) ? attempt.session : undefined;
        const you = session ? ownName(session) : undefined;
        const modeState = await readModeState(ref.files);
        return { channel: attempt?.status.channelName ?? ref.channelName ?? ref.roomId, roomId: ref.roomId,
          state: attempt?.status.state ?? 'disconnected', ...(attempt?.status.detail ? { detail: attempt.status.detail } : {}),
          ...(you !== undefined ? { you } : {}), ...(session ? { agentUserId: session.userId } : {}),
          unread: (await unreadCount(ref.files.dir)).total, listeningMode: modeState.mode,
          ...(modeState.archived ? { archived: true } : {}), ...(await isDelegated(ref.files) ? { delegated: true } : {}),
          ...(session?.members ? { members: session.members(ref.roomId) } : {}) };
      }));
      if (channel === undefined) {
        for (const attempt of pendingAttempts()) {
          items.push({ channel: attempt.link, ...(attempt.credentials ? { roomId: attempt.credentials.roomId } : {}),
            link: attempt.link, state: 'joining', ...(attempt.status.detail ? { detail: attempt.status.detail } : {}), unread: 0, listeningMode: defaultMode });
        }
      }
      await statusWrites;
      const single = items.length === 1 && items[0]?.roomId ? items[0] : undefined;
      return { state: channel === undefined ? status.state : single!.state,
        ...(single?.detail !== undefined ? { detail: single.detail } : channel === undefined && status.detail ? { detail: status.detail } : {}),
        ...(single ? { channelName: single.channel, ...(single.you !== undefined ? { displayName: single.you, you: single.you } : {}),
          ...(single.agentUserId !== undefined ? { agentUserId: single.agentUserId } : {}) } : {}),
        unread: items.reduce((sum, item) => sum + item.unread, 0),
        ...(single?.archived ? { archived: true } : {}),
        ...(single ? { listeningMode: single.listeningMode } : items.length === 0 ? { listeningMode: defaultMode } : {}), channels: items };
    },
    async read(limit, before, channel, filter) {
      await initialize();
      const { wait, ...rest } = filter ?? {};
      const options = Object.keys(rest).length ? rest : undefined;
      if (wait !== undefined) {
        const { session, attempt } = requireSession(channel);
        const files = attempt.files;
        if (!files) throw new KhalaClientError('not_connected');
        const deadline = Date.now() + wait * 1000;
        let consumed = 0;
        try {
          await delegateChannel(files, wait * 1000 + DELEGATE_GRACE_MS);
          for (;;) {
            const state = await readModeState(files), pending = await unread(files);
            const mode = state.archived ? 'async' : state.mode;
            if (mode !== 'async' && pending.entries.some(entry => wakesAgent(entry, mode, ownName(session)))) {
              if (await advanceCursor(files, pending.cursor, pending.entries, true) !== 'conflict') { consumed = pending.entries.length; break; }
            } else if (!current(attempt)) throw new KhalaClientError('not_connected');
            const left = deadline - Date.now();
            if (left <= 0) { const you = ownName(session); return { ...(you !== undefined ? { you } : {}), messages: [] }; }
            await new Promise(resolve => setTimeout(resolve, Math.min(1000, left)));
          }
        } catch (error) { throw safeError(error); }
        // Show at least everything just consumed, so nothing is marked delivered unseen (up to the page cap).
        return readOne(Math.min(100, Math.max(limit, consumed)), undefined, channel, options);
      }
      // Without a channel, read every joined channel: the constant nudge says only "Call khala_read".
      if (channel === undefined && before === undefined && stored.size && stored.size + pendingAttempts().length > 1) {
        const sections = await Promise.all(refs().map(async ref => {
          const name = channels.get(ref.key)?.status.channelName ?? ref.channelName ?? ref.roomId;
          // A background agent owns a delegated channel; the main session leaves it alone.
          if (await isDelegated(ref.files)) return { section: { channel: name, roomId: ref.roomId, delegated: true as const }, messages: [] };
          try {
            const { messages, ...section } = await readOne(limit, undefined, ref.roomId, options);
            return { section: { channel: name, roomId: ref.roomId, ...section }, messages: messages.map(entry => ({ ...entry, channel: name })) };
          } catch (error) {
            return { section: { channel: name, roomId: ref.roomId, error: error instanceof KhalaClientError ? error.code : 'internal_error' }, messages: [] };
          }
        }));
        return { messages: sections.flatMap(item => item.messages).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts)),
          channels: sections.map(item => item.section) };
      }
      return readOne(limit, before, channel, options);
    },
    async send(text, channel) {
      await initialize();
      const { session, credentials, attempt } = requireSession(channel);
      try {
        const sent = await session.send(credentials.roomId, text);
        if (attempt.typingSince !== undefined) {
          attempt.typingSince = undefined;
          void session.setTyping?.(credentials.roomId, false).catch(() => {});
        }
        if (current(attempt) && attempt.status.state === 'send_failed') await setStatus(attempt, 'connected');
        return sent;
      } catch (error) {
        if (!current(attempt)) throw new KhalaClientError('not_connected');
        if (current(attempt)) await setStatus(attempt, 'send_failed', errorDetail(error, 'send_failed'));
        throw new KhalaClientError('send_failed');
      }
    },
    async sendChannelEvent(content, channel) {
      await initialize();
      const { session, credentials, attempt } = requireSession(channel);
      const encoded = encodeChannelEvent(content);
      if (!encoded.ok) throw new KhalaClientError('internal_error', 'invalid_event');
      const txnId = encoded.value.key === undefined ? undefined
        : 'khev-' + createHash('sha256').update(encoded.value.key).digest('hex').slice(0, 32);
      // Claims are a race-tolerant convention over E2EE content, not a lock: the earliest claim
      // by room order wins. Check before posting, and again after, in case an earlier claim raced ours.
      const claimKey = encoded.value.kind === 'claim' ? encoded.value.data?.key : undefined;
      const holder = async () => {
        if (claimKey === undefined) return undefined;
        const claim = (await foldedState(session, credentials.roomId, attempt.files?.dir)).activeClaims?.find(item => item.key === claimKey);
        return claim && claim.sender !== session.userId ? { error: 'claimed' as const, by: claim.by, at: claim.at } : undefined;
      };
      try {
        const held = await holder();
        if (held) return held;
        const sent = await session.sendChannelEvent(credentials.roomId, encoded.value, txnId);
        if (current(attempt) && attempt.status.state === 'send_failed') await setStatus(attempt, 'connected');
        // The event is posted; a failed recheck must not report the send as failed.
        return await holder().catch(() => undefined) ?? sent;
      } catch (error) {
        if (!current(attempt)) throw new KhalaClientError('not_connected');
        if (current(attempt)) await setStatus(attempt, 'send_failed', errorDetail(error, 'send_failed'));
        throw new KhalaClientError('send_failed');
      }
    },
    async leave(channel) {
      await initialize();
      const ref = select(channel);
      const leaving = (roomChanges.get(ref.key) ?? Promise.resolve()).catch(() => {}).then(async () => {
        if (!stored.has(ref.key)) throw new KhalaClientError('channel_unknown', undefined, { channels: refs().map(item => ({ channel: item.channelName ?? item.roomId, roomId: item.roomId })) });
        const attempt = channels.get(ref.key);
        if (attempt) {
          await cancel(attempt);
          await setStatus(attempt, 'disconnected', 'left');
          await removeJoinFile(filesForDir(dir), attempt.link);
        }
        await statusWrites;
        await ensureStateDir(ref.files.dir);
        if (ref.legacy) {
          for (const name of ['inbox.jsonl', 'cursor.json', 'mode.json', 'session.json', 'fold.json', 'delegate.json']) {
            await removeStateFile(ref.files.dir, name);
          }
        } else {
          const expected = channelFiles(filesForDir(dir), ref.roomId).dir;
          if (ref.files.dir !== expected) throw new KhalaClientError('internal_error', 'unsafe_state_dir');
          await fs.rm(ref.files.dir, { recursive: true, force: true });
        }
        channels.delete(ref.key);
        stored.delete(ref.key);
        roomSlots.delete(ref.key);
        await writeAggregate();
      });
      roomChanges.set(ref.key, leaving);
      await leaving;
      return { left: ref.channelName ?? ref.roomId, channels: refs().map(item => item.roomId) };
    },
    close() {
      if (closing) return closing;
      closed = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
      for (const attempt of attempts.values()) attempt.controller.abort();
      closing = (async () => {
        await heartbeatTask.catch(() => {});
        await initialize();
        await Promise.all([...joins.values()].map(task => task.catch(() => {})));
        await Promise.all([...roomChanges.values()].map(task => task.catch(() => {})));
        await Promise.all([...attempts.values()].map(async attempt => {
          await cancel(attempt);
          await setStatus(attempt, 'disconnected', terminal.includes(attempt.status.detail ?? '') ? attempt.status.detail : 'closed');
          await removeJoinFile(filesForDir(dir), attempt.link);
        }));
        await removeStateFile(dir, 'session.json');
        await writeAggregate('closed');
      })();
      return closing;
    },
  };
}
