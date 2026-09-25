import type { EventRef, ParticipantId as DeliveryParticipantId, SessionBinding } from '@khala/contracts/delivery/index';
import type { RoomId } from '@khala/contracts/messaging/index';
import type {
  AuthorityCheck, ProvenancePort, SourceEvent, SourceRead, SubscriptionSource,
} from '@khala/connector/subscription/index';
import { type ChannelStore, type StoredEvent } from '../../store/channel-store';

export type LocalSubscriptionSourceInput = Readonly<{
  store: ChannelStore;
  binding: SessionBinding;
  channelId: RoomId;
}>;

export type LocalSubscriptionTransport = Readonly<{
  source: SubscriptionSource;
  provenance: ProvenancePort;
}>;

function sourceEvent(event: StoredEvent): SourceEvent {
  const ref: EventRef = {
    v: 1,
    roomId: event.channelId as EventRef['roomId'],
    eventId: event.eventId as EventRef['eventId'],
    authorParticipantId: event.authorParticipantId as EventRef['authorParticipantId'],
    authorDeviceId: event.authorDeviceId as EventRef['authorDeviceId'],
    contentDigest: event.contentDigest,
  };
  return {
    kind: 'decrypted',
    ref,
    verifiedDeviceId: event.authorDeviceId,
    canonicalPayload: new Uint8Array(event.canonicalPayload),
  };
}

/** Builds one replay source and provenance port fixed to an exact durable binding and channel. */
export function createLocalSubscriptionSource(input: LocalSubscriptionSourceInput): LocalSubscriptionTransport {
  const source: SubscriptionSource = {
    async authorize(options): Promise<AuthorityCheck> {
      if (options?.signal?.aborted) return 'unavailable';
      try {
        const authority = input.store.binding(input.binding);
        if (authority.kind === 'unavailable') return 'unavailable';
        if (authority.kind !== 'done' || authority.binding.status !== 'active') return 'revoked';
        const channel = input.store.channel({
          channelId: input.channelId,
          participantId: input.binding.agentParticipantId as Parameters<ChannelStore['channel']>[0]['participantId'],
        });
        if (channel.kind === 'unavailable') return 'unavailable';
        return channel.kind === 'done' ? 'ok' : 'revoked';
      } catch {
        return 'unavailable';
      }
    },

    listen(listener) {
      return input.store.subscribeHints(input.channelId, () => listener.hint());
    },

    async read(request, options): Promise<SourceRead> {
      if (options?.signal?.aborted) return { kind: 'unavailable' };
      try {
        const result = input.store.readSubscription({
          channelId: input.channelId,
          binding: input.binding,
          cursor: request.cursor,
          limit: request.limit,
        });
        if (result.kind === 'page') {
          return {
            kind: 'page',
            events: result.events.map(sourceEvent),
            nextCursor: result.nextCursor,
            caughtUp: result.caughtUp,
          };
        }
        if (result.kind === 'unavailable') return { kind: 'unavailable' };
        if (result.code === 'invalid_cursor' || result.code === 'invalid_input') {
          return { kind: 'rejected', code: 'unsupported' };
        }
        return { kind: 'rejected', code: 'authority_lost' };
      } catch {
        return { kind: 'unavailable' };
      }
    },
  };

  const provenance: ProvenancePort = {
    async participantForDevice(request, options): Promise<DeliveryParticipantId | null | 'unavailable'> {
      if (options?.signal?.aborted) return 'unavailable';
      try {
        const result = input.store.participantForDevice({
          channelId: request.roomId as RoomId,
          deviceId: request.deviceId,
        });
        if (result.kind === 'unavailable') return 'unavailable';
        return result.participantId as DeliveryParticipantId | null;
      } catch {
        return 'unavailable';
      }
    },
  };

  return { source, provenance };
}
