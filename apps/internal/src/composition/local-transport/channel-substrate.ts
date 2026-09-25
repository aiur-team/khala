import type {
  ChannelRejection, ChannelSummary, DeviceId, EventId, OwnerId, ParticipantView, RoomId,
} from '@khala/contracts/messaging/index';
import type {
  AcceptedEvent, ChannelSubstrate, CreateLookup, SubstrateEffect, SubstrateEvent, SubstratePage,
  SubstrateRead, SubstrateUpdate,
} from '@khala/messaging/channels/substrate';
import {
  type ChannelStore, type StoredChannel, type StoredEvent,
} from '../../store/channel-store';

export type LocalChannelSubstrateInput = Readonly<{
  store: ChannelStore;
  ownerId: OwnerId;
  participant: ParticipantView;
  deviceId: DeviceId;
  generation: number;
  newId: () => string;
  clock: () => number;
}>;

function summary(channel: StoredChannel): ChannelSummary {
  return {
    roomId: channel.channelId,
    title: channel.title,
    membership: channel.membership,
    revision: channel.revision,
  };
}

function event(stored: StoredEvent): SubstrateEvent {
  return {
    kind: 'message',
    eventId: stored.eventId,
    authorDeviceId: stored.authorDeviceId,
    participant: stored.participant,
    content: stored.content,
    clientTxnId: stored.clientTxnId,
    receivedAt: stored.receivedAt,
  };
}

function rejection(code: string): ChannelRejection {
  switch (code) {
    case 'identity_mismatch': return 'forbidden';
    case 'not_found': return 'not_found';
    case 'not_joined': return 'not_joined';
    case 'operation_mismatch': return 'operation_mismatch';
    default: return 'invalid_request';
  }
}

function unavailable<T>(): SubstrateRead<T> {
  return { kind: 'unavailable' };
}

function initialUpdate(input: LocalChannelSubstrateInput, roomId: RoomId): SubstrateUpdate {
  const room = input.store.channel({ channelId: roomId, participantId: input.participant.participantId });
  if (room.kind !== 'done') return { generation: input.generation, room: null, events: [] };

  let cursor: string | null = null;
  let events: SubstrateEvent[] = [];
  do {
    const page = input.store.timeline({
      channelId: roomId,
      participantId: input.participant.participantId,
      cursor,
      limit: 1_000,
    });
    if (page.kind !== 'done') return { generation: input.generation, room: null, events: [] };
    events = [...page.events.map(event), ...events];
    cursor = page.nextCursor;
  } while (cursor !== null);

  return { generation: input.generation, room: summary(room.channel), events };
}

/** Builds one channel transport fixed to composition-trusted actor and device identity. */
export function createLocalChannelSubstrate(input: LocalChannelSubstrateInput): ChannelSubstrate {
  const creator = {
    creatorOwnerId: input.ownerId,
    creatorParticipantId: input.participant.participantId,
    creatorDeviceId: input.deviceId,
  } as const;

  return {
    async createRoom(request, options): Promise<SubstrateEffect<ChannelSummary>> {
      if (options?.signal?.aborted) return { kind: 'unavailable' };
      try {
        const result = input.store.createChannel({
          ...creator,
          operationId: request.operationId,
          channelId: input.newId() as RoomId,
          title: request.title,
          createdAt: new Date(input.clock()).toISOString(),
        });
        if (result.kind === 'created' || result.kind === 'replayed') {
          return { kind: 'done', value: summary(result.channel) };
        }
        if (result.kind === 'rejected') return { kind: 'rejected', code: rejection(result.code) };
        return { kind: 'unknown' };
      } catch {
        return { kind: 'unknown' };
      }
    },

    async findCreatedRoom(request, options): Promise<CreateLookup> {
      if (options?.signal?.aborted) return { kind: 'unavailable' };
      try {
        const result = input.store.findCreatedChannel({ ...creator, operationId: request.operationId });
        if (result.kind === 'found') return { kind: 'found', room: summary(result.channel) };
        if (result.kind === 'absent') return { kind: 'absent' };
        if (result.kind === 'rejected') return { kind: 'unknown' };
        return { kind: 'unavailable' };
      } catch {
        return { kind: 'unavailable' };
      }
    },

    async room(roomId, options): Promise<SubstrateRead<ChannelSummary>> {
      if (options?.signal?.aborted) return unavailable();
      try {
        const result = input.store.channel({ channelId: roomId, participantId: input.participant.participantId });
        if (result.kind === 'done') return { kind: 'done', value: summary(result.channel) };
        if (result.kind === 'rejected') return { kind: 'rejected', code: rejection(result.code) };
        return unavailable();
      } catch {
        return unavailable();
      }
    },

    async sendEvent(request, options): Promise<SubstrateEffect<AcceptedEvent>> {
      if (options?.signal?.aborted) return { kind: 'unavailable' };
      try {
        const result = input.store.send({
          channelId: request.roomId,
          eventId: input.newId() as EventId,
          authorParticipantId: input.participant.participantId,
          authorDeviceId: input.deviceId,
          clientTxnId: request.clientTxnId,
          content: request.content,
          receivedAt: new Date(input.clock()).toISOString(),
        });
        if (result.kind === 'stored' || result.kind === 'replayed') {
          return {
            kind: 'done',
            value: { eventId: result.event.eventId, authorDeviceId: result.event.authorDeviceId },
          };
        }
        if (result.kind === 'rejected') return { kind: 'rejected', code: rejection(result.code) };
        return { kind: 'unknown' };
      } catch {
        return { kind: 'unknown' };
      }
    },

    async timeline(request, options): Promise<SubstrateRead<SubstratePage>> {
      if (options?.signal?.aborted) return unavailable();
      try {
        const result = input.store.timeline({
          channelId: request.roomId,
          participantId: input.participant.participantId,
          cursor: request.cursor,
          limit: request.limit,
        });
        if (result.kind === 'done') {
          return {
            kind: 'done',
            value: { events: result.events.map(event), nextCursor: result.nextCursor, revision: result.revision },
          };
        }
        if (result.kind === 'rejected') return { kind: 'rejected', code: rejection(result.code) };
        return unavailable();
      } catch {
        return unavailable();
      }
    },

    subscribe(roomId, listener) {
      const dispose = input.store.subscribeChannel(
        { channelId: roomId, participantId: input.participant.participantId },
        update => listener({
          generation: input.generation,
          room: summary(update.channel),
          events: update.events.map(event),
        }),
      );
      try { listener(initialUpdate(input, roomId)); } catch { /* Listener failures do not cancel the subscription. */ }
      return dispose;
    },
  };
}
