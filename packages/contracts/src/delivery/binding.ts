// Immutable recipient binding for one existing harness session. This mirrors the
// peer field set independently so delivery cannot import unfinished siblings.

import { type Decoded, decodeWith, identifier, object, safeInteger, version } from './decode';
import {
  type BindingId, type DeviceId, type OwnerId, type ParticipantId, readId,
} from './ids';

export type SessionBinding = Readonly<{
  v: 1;
  bindingId: BindingId;
  ownerId: OwnerId;
  agentParticipantId: ParticipantId;
  deviceId: DeviceId;
  harness: string;
  sessionId: string;
  generation: number;
}>;

export function decodeSessionBinding(input: unknown): Decoded<SessionBinding> {
  return decodeWith(() => readSessionBinding(input, ''));
}

export function readSessionBinding(input: unknown, field: string): SessionBinding {
  const reader = object(input, field, [
    'v', 'bindingId', 'ownerId', 'agentParticipantId', 'deviceId', 'harness', 'sessionId', 'generation',
  ]);
  return {
    v: version(reader.field('v'), reader.at('v')),
    bindingId: readId<'BindingId'>(reader.field('bindingId'), reader.at('bindingId')),
    ownerId: readId<'OwnerId'>(reader.field('ownerId'), reader.at('ownerId')),
    agentParticipantId: readId<'ParticipantId'>(
      reader.field('agentParticipantId'),
      reader.at('agentParticipantId'),
    ),
    deviceId: readId<'DeviceId'>(reader.field('deviceId'), reader.at('deviceId')),
    harness: identifier(reader.field('harness'), reader.at('harness')),
    sessionId: identifier(reader.field('sessionId'), reader.at('sessionId')),
    generation: safeInteger(reader.field('generation'), reader.at('generation')),
  };
}

export function sameSessionBinding(a: SessionBinding, b: SessionBinding): boolean {
  return a.v === b.v
    && a.bindingId === b.bindingId
    && a.ownerId === b.ownerId
    && a.agentParticipantId === b.agentParticipantId
    && a.deviceId === b.deviceId
    && a.harness === b.harness
    && a.sessionId === b.sessionId
    && a.generation === b.generation;
}
