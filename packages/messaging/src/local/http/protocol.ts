// Browser-side view of the versioned loopback channel API served by
// `apps/internal/src/server`. The server cannot be imported from browser code,
// so the few shared names are restated here and pinned by a server-side test.

import { type ChannelSummary, readChannelSummary } from '@khala/contracts/messaging/channels';
import {
  type ContentLimits, type Decoded, array, decodeWith, elementPath, fail, identifier, nullable, object, utcTimestamp,
} from '@khala/contracts/messaging/decode';
import { readMessageContent } from '@khala/contracts/messaging/events';
import { type ParticipantView, readParticipantView } from '@khala/contracts/messaging/identity';
import { type DeviceId, type EventId, type OwnerId, type ParticipantId, readId } from '@khala/contracts/messaging/ids';
import type { SubstrateEvent } from '../../channels/substrate';

/** Header carrying the per-session request secret; the cookie alone is never a credential. */
export const REQUEST_SECRET_HEADER = 'x-khala-request-secret';
/** `sessionStorage` key the bootstrap script writes the request secret to. */
export const REQUEST_SECRET_STORAGE_KEY = 'khala.requestSecret';

export const API = {
  session: '/api/v1/session',
  channels: '/api/v1/channels',
  channel: (channelId: string) => `/api/v1/channels/${encodeURIComponent(channelId)}`,
  timeline: (channelId: string) => `/api/v1/channels/${encodeURIComponent(channelId)}/timeline`,
  messages: (channelId: string) => `/api/v1/channels/${encodeURIComponent(channelId)}/messages`,
  hints: (channelId: string) => `/api/v1/channels/${encodeURIComponent(channelId)}/hints`,
  receipts: (channelId: string) => `/api/v1/channels/${encodeURIComponent(channelId)}/receipts`,
} as const;

/** The human authority a browser session was bootstrapped with. */
export type LocalHuman = Readonly<{ ownerId: OwnerId; participantId: ParticipantId; deviceId: DeviceId }>;

type MessageEvent = Extract<SubstrateEvent, { kind: 'message' }>;

export function decodeSession(input: unknown): Decoded<LocalHuman> {
  return decodeWith(() => {
    const envelope = object(input, '', ['human']);
    const human = object(envelope.field('human'), envelope.at('human'), ['ownerId', 'participantId', 'deviceId']);
    return {
      ownerId: readId<'OwnerId'>(human.field('ownerId'), human.at('ownerId')),
      participantId: readId<'ParticipantId'>(human.field('participantId'), human.at('participantId')),
      deviceId: readId<'DeviceId'>(human.field('deviceId'), human.at('deviceId')),
    };
  });
}

function readChannel(input: unknown, path: string, limits: ContentLimits): ChannelSummary {
  const r = object(input, path, ['channelId', 'title', 'membership', 'revision']);
  // The server names the channel `channelId`; the contract summary keeps its wire name `roomId`.
  return readChannelSummary({
    roomId: r.field('channelId'),
    title: r.field('title'),
    membership: r.field('membership'),
    revision: r.field('revision'),
  }, path, limits);
}

/** `{channel}` from create, or `{channel, participants}` from a channel read. */
export function decodeChannel(input: unknown, limits: ContentLimits, withParticipants: boolean): Decoded<Readonly<{
  channel: ChannelSummary;
  participants: readonly ParticipantView[];
}>> {
  return decodeWith(() => {
    const r = object(input, '', withParticipants ? ['channel', 'participants'] : ['channel']);
    const participants = withParticipants ? array(r.field('participants'), r.at('participants')) : [];
    return {
      channel: readChannel(r.field('channel'), r.at('channel'), limits),
      participants: participants.map((value, index) => readParticipantView(value, elementPath(r.at('participants'), index), limits)),
    };
  });
}

function readEvent(input: unknown, path: string, channelId: string, limits: ContentLimits): MessageEvent {
  const r = object(input, path, ['eventId', 'channelId', 'authorDeviceId', 'participant', 'content', 'clientTxnId', 'receivedAt']);
  if (r.field('channelId') !== channelId) fail(r.at('channelId'), 'mismatch');
  return {
    kind: 'message',
    eventId: readId<'EventId'>(r.field('eventId'), r.at('eventId')),
    authorDeviceId: readId<'DeviceId'>(r.field('authorDeviceId'), r.at('authorDeviceId')),
    participant: readParticipantView(r.field('participant'), r.at('participant'), limits),
    content: readMessageContent(r.field('content'), r.at('content'), limits),
    clientTxnId: nullable(r.field('clientTxnId'), value => identifier(value, r.at('clientTxnId'))),
    receivedAt: utcTimestamp(r.field('receivedAt'), r.at('receivedAt')),
  };
}

export function decodeTimeline(input: unknown, channelId: string, limits: ContentLimits): Decoded<Readonly<{
  events: readonly MessageEvent[];
  nextCursor: string | null;
  revision: string;
}>> {
  return decodeWith(() => {
    const r = object(input, '', ['events', 'nextCursor', 'revision']);
    return {
      events: array(r.field('events'), r.at('events'))
        .map((value, index) => readEvent(value, elementPath(r.at('events'), index), channelId, limits)),
      nextCursor: nullable(r.field('nextCursor'), value => identifier(value, r.at('nextCursor'))),
      revision: identifier(r.field('revision'), r.at('revision')),
    };
  });
}

/** `{state, event}` from a send; only the IDs the transport assigned are kept. */
export function decodeSent(input: unknown, channelId: string, limits: ContentLimits): Decoded<Readonly<{ eventId: EventId; authorDeviceId: DeviceId }>> {
  return decodeWith(() => {
    const r = object(input, '', ['state', 'event']);
    if (r.field('state') !== 'stored' && r.field('state') !== 'replayed') fail(r.at('state'), 'invalid_value');
    const event = readEvent(r.field('event'), r.at('event'), channelId, limits);
    return { eventId: event.eventId, authorDeviceId: event.authorDeviceId };
  });
}
