import type { ContentLimits, RoomId } from '@khala/contracts/messaging/index';
import { readHumanEntry, type EntryLocation } from '../human/entry';
import type { HumanApplicationPorts } from '../human/application';
import { createLocalAdministration } from './administration';
import { createLocalHttp } from './http';
import { LOCAL_PRINCIPAL, createLocalSession } from './session';
import { createLocalProfilePort } from './profile';
import { createLocalAgentNamesPort } from './agent-names';
import { createLocalChannelNamesPort } from './channel-names';
import { createLocalSubstrate } from './substrate';
import { createLocalChannelService } from './channel-service';
import { createLocalMembers } from './members';
import { createLocalConversations } from './conversations';
import { createLocalChannelLinks, localAdmission } from './links';

export function localInitialPath(location: EntryLocation): string {
  return location.pathname === '/' ? '/conversations' : readHumanEntry(location).path;
}

export function createLocalHumanPorts(input: { origin: string; limits: ContentLimits; fetch?: typeof fetch }): HumanApplicationPorts & { dispose(): void } {
  const http = createLocalHttp({ origin: input.origin, ...(input.fetch ? { fetch: input.fetch } : {}) });
  const session = createLocalSession(http);
  const members = createLocalMembers(http, input.limits);
  const conversations = createLocalConversations(http);
  const substrate = createLocalSubstrate({ http, limits: input.limits, members, onEvent: event => conversations.rememberEvent(event), generation: () => session.device.current().generation });
  const channel = createLocalChannelService({
    principal: LOCAL_PRINCIPAL, actor: () => session.participant(), device: session.device, substrate, limits: input.limits,
  });
  let disposed = false;
  return {
    identity: session.identity,
    device: session.device,
    participant: () => session.participant(),
    room: Object.assign(channel.room, { administration: createLocalAdministration(http) }),
    observeNotificationEntries: channel.observeBackgroundEntries,
    conversations,
    syncStatus: conversations.syncStatus,
    admission: localAdmission,
    channelLinks: createLocalChannelLinks(http),
    profile: createLocalProfilePort(http, { onUsername: username => session.noteUsername(username) }),
    agentNames: createLocalAgentNamesPort(http),
    // The roster re-reads at once so the new name (and the end of the prompt) show without waiting for a poll.
    channelNames: createLocalChannelNamesPort(http, { onSaved: roomId => void members.refresh(roomId as RoomId) }),
    describeParticipant: participantId => members.describe(participantId),
    describeMatrixUser: userId => members.describeMatrixUser(userId),
    listeningMode: (roomId, userId) => members.listeningMode(roomId, userId),
    subscribeListeningModes: (roomId, listener) => members.subscribeListeningModes(roomId, listener),
    setListeningMode: (roomId, userId, mode, txnId) => members.setListeningMode(roomId, userId, mode, txnId),
    roomParticipants: (roomId, signal) => members.roomParticipants(roomId, signal),
    memberSince: (roomId, userId) => conversations.memberSince(roomId, userId),
    limits: input.limits,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const stop of [() => channel.dispose(), () => conversations.dispose(), () => void session.device.stop()]) {
        try { stop(); } catch { /* best effort: one failure must not skip the rest */ }
      }
    },
  };
}
