import { decodeLocalMembersResponse, decodeLocalSendResult, isLocalTxnId, LOCAL_OWNER_ID, LOCAL_OWNER_USER_ID, type LocalMember } from '@khala/contracts/m1/local';
import { DEFAULT_LISTENING_MODE, type ListeningMode } from '@khala/contracts/m1/listening-mode';
import type { Participant } from '@khala/contracts/m1/participants';
import type { ContentLimits } from '@khala/contracts/messaging/decode';
import { decodeParticipantView, type ParticipantView } from '@khala/contracts/messaging/identity';
import type { Disposer, RoomId } from '@khala/contracts/messaging/index';
import { localChannelPath, localRoomPath, type LocalHttp } from './http';
import type { LocalMembersCache } from './types';

export type LocalMembers = LocalMembersCache & Readonly<{
  describeMatrixUser(matrixUserId: string): Participant | undefined;
  listeningMode(roomId: RoomId, matrixUserId: string): ListeningMode;
  subscribeListeningModes(roomId: RoomId, listener: () => void): Disposer;
  setListeningMode(roomId: RoomId, matrixUserId: string, mode: ListeningMode, txnId: string): Promise<'sent' | 'failed'>;
  roomParticipants(roomId: RoomId, signal?: AbortSignal): Promise<readonly ParticipantView[] | null>;
}>;

export function createLocalMembers(http: LocalHttp, limits: ContentLimits): LocalMembers {
  const byRoom = new Map<RoomId, { members: readonly LocalMember[]; signature: string }>();
  const details = new Map<string, Participant>();
  const listeners = new Map<RoomId, Set<() => void>>();
  const inflight = new Map<RoomId, Promise<void>>();

  function refresh(roomId: RoomId): Promise<void> {
    const pending = inflight.get(roomId);
    if (pending) return pending;
    // Defer the request until the shared promise has been registered.
    const request = Promise.resolve().then(async () => {
      try {
        const result = await http.get(localRoomPath(roomId, '/members'), decodeLocalMembersResponse);
        if (result.kind !== 'ok') return;
        const members = result.value.members;
        const fallback = members.find(m => m.userId === LOCAL_OWNER_USER_ID)?.displayName ?? 'owner';
        for (const member of members) {
          const common = { matrixUserId: member.userId, participantId: member.userId,
            ownerId: LOCAL_OWNER_ID, displayName: member.displayName };
          if (member.kind === 'human') details.set(member.userId, { ...common, kind: 'human' });
          else if (member.harness) details.set(member.userId, { ...common, kind: 'agent',
            ownerLabel: member.ownerLabel ?? fallback, harness: member.harness });
        }
        const signature = JSON.stringify(members.map(m => [m.userId, m.displayName, m.membership, m.listeningMode]).sort());
        const changed = byRoom.get(roomId)?.signature !== signature;
        byRoom.set(roomId, { members, signature });
        if (changed) for (const listener of listeners.get(roomId) ?? []) {
          try { listener(); } catch { /* A subscriber cannot interrupt cache updates. */ }
        }
      } catch { /* Keep the previous successful room snapshot. */ }
    }).finally(() => { inflight.delete(roomId); });
    inflight.set(roomId, request);
    return request;
  }
  const describe = (id: string) => details.get(id);
  const members = (roomId: RoomId) => byRoom.get(roomId)?.members;
  const subscribe = (roomId: RoomId, listener: () => void): Disposer => {
    let set = listeners.get(roomId);
    if (!set) { set = new Set(); listeners.set(roomId, set); }
    set.add(listener);
    return () => { set.delete(listener); if (!set.size && listeners.get(roomId) === set) listeners.delete(roomId); };
  };
  return {
    members, describe, describeMatrixUser: describe, refresh, subscribe, subscribeListeningModes: subscribe,
    listeningMode: (roomId, userId) => members(roomId)?.find(m => m.userId === userId)?.listeningMode ?? DEFAULT_LISTENING_MODE,
    async setListeningMode(roomId, userId, mode, txnId) {
      if (!/^@[^:\s]+:\S+$/.test(userId) || !isLocalTxnId(txnId)) return 'failed';
      try {
        const result = await http.send('POST', localChannelPath(roomId, '/mode'), { agent: userId, mode, txnId }, decodeLocalSendResult);
        return result.kind === 'ok' ? 'sent' : 'failed';
      } catch { return 'failed'; }
    },
    async roomParticipants(roomId, signal) {
      await refresh(roomId);
      if (signal?.aborted) return null;
      const list = members(roomId);
      if (!list) return null;
      const views: ParticipantView[] = [];
      for (const m of list) {
        const decoded = decodeParticipantView({ participantId: m.userId, kind: m.kind, ownerId: LOCAL_OWNER_ID,
          displayName: m.displayName, deviceIds: [m.deviceId] }, limits);
        if (!decoded.ok) return null;
        views.push(decoded.value);
      }
      return views;
    },
  };
}
