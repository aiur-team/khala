import { CHANNEL_EVENT_TYPE, decodeChannelEvent } from '@khala/contracts/m1/channel-event';
import {
  LOCAL_OWNER_DEVICE_ID, LOCAL_OWNER_ID, LOCAL_OWNER_USER_ID,
  decodeLocalChannelCreated, decodeLocalChannelSummary, decodeLocalEventsPage, decodeLocalHistoryPage, decodeLocalRoomRef, decodeLocalSendResult,
  type LocalChannelSummary, type LocalEvent,
} from '@khala/contracts/m1/local';
import { decodeChannelSummary, decodeParticipantView, type ChannelRejection, type ChannelSummary, type ContentLimits, type DeviceId, type EventId, type ParticipantView, type RoomId } from '@khala/contracts/messaging/index';
import type { ChannelSubstrate, SubstrateEvent } from '@khala/messaging/channels/index';
import { encodeMessageContent, projectWireEvent } from '../human/message-wire';
import { LOCAL_CHANNELS_PATH, localChannelPath, localRoomPath, type LocalHttp, type LocalHttpResult } from './http';
import type { LocalMembersCache } from './types';

function abortableTimeout(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}
function rejectedFrom(result: LocalHttpResult<unknown>): ChannelRejection | null {
  if (result.kind !== 'error' || result.code === 'invalid_response') return null;
  switch (result.status) {
    case 400: case 409: return 'invalid_request';
    case 403: return 'forbidden';
    case 404: return 'not_found';
    case 413: return 'too_large';
    default: return null;
  }
}

export function createLocalSubstrate(input: {
  http: LocalHttp; limits: ContentLimits; members: LocalMembersCache; generation: () => number;
  onEvent?: (event: LocalEvent) => void;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>; now?: () => Date;
}): ChannelSubstrate {
  const sleep = input.sleep ?? abortableTimeout;
  function viewFor(roomId: RoomId, userId: string): ParticipantView {
    const member = input.members.members(roomId)?.find(value => value.userId === userId);
    const detail = input.members.describe(userId);
    const localpart = userId.slice(1).split(':')[0]!;
    const view = { participantId: userId, kind: userId === LOCAL_OWNER_USER_ID ? 'human' : member?.kind ?? (detail?.kind === 'human' ? 'human' : 'agent'),
      ownerId: LOCAL_OWNER_ID, displayName: member?.displayName ?? (detail && detail.kind !== 'unknown' ? detail.displayName : localpart),
      deviceIds: [member?.deviceId ?? (userId === LOCAL_OWNER_USER_ID ? LOCAL_OWNER_DEVICE_ID : 'KH_LOCAL_UNKNOWN')] };
    const decoded = decodeParticipantView(view, input.limits);
    if (decoded.ok) return decoded.value;
    const fallback = decodeParticipantView({ ...view, displayName: localpart }, input.limits);
    if (!fallback.ok) throw new Error('invalid local participant');
    return fallback.value;
  }
  function project(roomId: RoomId, event: LocalEvent): SubstrateEvent | null {
    input.onEvent?.(event);
    const participant = viewFor(roomId, event.sender);
    const projected = projectWireEvent({ type: event.type, content: event.content, eventId: event.eventId as EventId, participant,
      authorDeviceId: participant.deviceIds[0] ?? null, clientTxnId: event.sender === LOCAL_OWNER_USER_ID ? event.txnId ?? null : null,
      receivedAt: new Date(event.ts).toISOString(),
      ...(event.previousContent ? { previousContent: event.previousContent } : {}) }, input.limits);
    return projected?.kind === 'message' && projected.content.kind !== 'text'
      ? { ...projected, targetParticipant: viewFor(roomId, projected.content.agentParticipantId) } : projected;
  }
  function channel(roomId: string, title: string | null, revision: string): ChannelSummary {
    const decoded = decodeChannelSummary({ roomId, title, membership: 'joined', revision }, input.limits);
    if (decoded.ok) return decoded.value;
    const fallback = decodeChannelSummary({ roomId, title: null, membership: 'joined', revision }, input.limits);
    if (!fallback.ok) throw new Error('invalid local channel');
    return fallback.value;
  }
  const summary = (value: LocalChannelSummary, lastSeq = value.lastSeq) => channel(value.roomId, value.name, `local:${lastSeq}`);
  const substrate: ChannelSubstrate = {
    async createRoom(value, options) {
      const result = await input.http.send('POST', LOCAL_CHANNELS_PATH,
        { name: value.title ?? `local-${(input.now ?? (() => new Date()))().toISOString().slice(0, 10)}`, operationId: value.operationId }, decodeLocalChannelCreated, options?.signal);
      if (result.kind === 'ok') return { kind: 'done', value: channel(result.value.roomId, result.value.name, `local:${result.value.roomId}:created`) };
      const code = rejectedFrom(result);
      return code ? { kind: 'rejected', code } : { kind: result.kind === 'error' && result.status === 401 ? 'unavailable' : 'unknown' };
    },
    async findCreatedRoom(value, options) {
      const result = await input.http.get(`${LOCAL_CHANNELS_PATH}/by-operation/${encodeURIComponent(value.operationId)}`, decodeLocalRoomRef, options?.signal);
      if (result.kind === 'error' && result.status === 404) return { kind: 'absent' };
      if (result.kind !== 'ok') return { kind: 'unavailable' };
      const found = await substrate.room(result.value.roomId as RoomId, options);
      return found.kind === 'done' ? { kind: 'found', room: found.value } : { kind: 'unavailable' };
    },
    async room(roomId, options) {
      const result = await input.http.get(localChannelPath(roomId, '?wire=2'), decodeLocalChannelSummary, options?.signal);
      if (result.kind === 'ok') return { kind: 'done', value: summary(result.value) };
      return result.kind === 'error' && result.status === 404 ? { kind: 'rejected', code: 'not_found' } : { kind: 'unavailable' };
    },
    async sendEvent(value, options) {
      const result = await input.http.send('POST', localRoomPath(value.roomId, '/send'),
        { txnId: value.clientTxnId, type: 'm.room.message', content: encodeMessageContent(value.content) }, decodeLocalSendResult, options?.signal);
      if (result.kind === 'ok') return { kind: 'done', value: { eventId: result.value.eventId as EventId, authorDeviceId: LOCAL_OWNER_DEVICE_ID as DeviceId } };
      const code = rejectedFrom(result);
      return code ? { kind: 'rejected', code } : { kind: result.kind === 'error' && result.status === 401 ? 'unavailable' : 'unknown' };
    },
    async timeline(value, options) {
      if (input.members.members(value.roomId) === undefined) await input.members.refresh(value.roomId).catch(() => undefined);
      const query = new URLSearchParams({ limit: String(Math.min(Math.max(value.limit, 1), 100)), ...(value.cursor ? { before: value.cursor } : {}) });
      const result = await input.http.get(localRoomPath(value.roomId, `/messages?${query}&wire=2`), decodeLocalHistoryPage, options?.signal);
      if (result.kind === 'ok') return { kind: 'done', value: { events: result.value.events.flatMap(event => project(value.roomId, event) ?? []),
        nextCursor: result.value.nextBefore ?? null, revision: `local:${value.roomId}:${result.value.events.at(-1)?.eventId ?? 'empty'}` } };
      const code = rejectedFrom(result);
      return code ? { kind: 'rejected', code } : { kind: 'unavailable' };
    },
    subscribe(roomId, listener) {
      const abort = new AbortController();
      let disposed = false;
      const window = new Map<string, LocalEvent>();
      let after = 0;
      let current: ChannelSummary | null = null;
      let backoff = 1000;
      const publish = () => {
        if (disposed) return;
        const events = [...window.values()].flatMap(event => project(roomId, event) ?? []);
        const ignored = [...window.values()].filter(event => event.type === CHANNEL_EVENT_TYPE && !decodeChannelEvent(event.content).ok).map(event => event.eventId as EventId);
        listener({ generation: input.generation(), room: current, events, ...(ignored.length ? { ignoredEventIds: ignored } : {}) });
      };
      const pause = async () => { await sleep(backoff, abort.signal); backoff = Math.min(backoff * 2, 10_000); };
      async function run() {
        while (!disposed) {
          try {
            const result = await input.http.get(localChannelPath(roomId, '?wire=2'), decodeLocalChannelSummary, abort.signal);
            if (disposed) return;
            if (result.kind === 'error' && result.status === 404) { publish(); return; }
            if (result.kind !== 'ok') { await pause(); continue; }
            current = summary(result.value); after = result.value.lastSeq;
            if (input.members.members(roomId) === undefined) await input.members.refresh(roomId).catch(() => undefined);
            if (disposed) return;
            const history = await input.http.get(localRoomPath(roomId, '/messages?limit=50&wire=2'), decodeLocalHistoryPage, abort.signal);
            if (disposed) return;
            if (history.kind !== 'ok') { await pause(); continue; }
            for (const event of history.value.events) window.set(event.eventId, event);
            publish(); backoff = 1000; break;
          } catch { if (disposed) return; try { await pause(); } catch { return; } }
        }
        while (!disposed) {
          try {
            const result = await input.http.get(localRoomPath(roomId, `/events?after=${after}&wait=25&prev=1&wire=2`), decodeLocalEventsPage, abort.signal, 35_000);
            if (disposed) return;
            if (result.kind === 'ok') {
              let membersChanged = false;
              for (const event of result.value.events) {
                after = Math.max(after, event.seq);
                if (event.type === 'm.room.message' || event.type === CHANNEL_EVENT_TYPE || (event.type === 'm.room.member' && event.previousContent)) window.set(event.eventId, event);
                if (event.type === 'm.room.member') membersChanged = true;
                if (event.type === 'm.room.name' && typeof event.content['name'] === 'string') current = channel(roomId, event.content['name'], `local:${after}`);
              }
              if (current) current = { ...current, revision: `local:${after}` };
              while (window.size > 200) window.delete(window.keys().next().value!);
              // The shared projection retains the first attribution for an event.
              // Resolve this batch's new members before projecting their messages.
              if (membersChanged) await input.members.refresh(roomId).catch(() => undefined);
              if (disposed) return;
              if (result.value.events.length) publish();
              backoff = 1000;
            } else if (result.kind === 'error' && (result.status === 404 || result.status === 403)) {
              if (current) current = { ...current, membership: result.status === 404 ? 'left' : 'revoked' };
              publish(); return;
            } else await pause();
          } catch { if (disposed) return; try { await pause(); } catch { return; } }
        }
      }
      void run();
      return () => { disposed = true; abort.abort(); };
    },
  };
  return substrate;
}
