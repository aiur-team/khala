import { createHash } from 'node:crypto';
import type { SessionBinding } from '@khala/contracts/delivery/index';
import type { DeviceId, EventId, ParticipantId, RoomId } from '@khala/contracts/messaging/ids';

export type VerifiedRename = Readonly<{ eventId: EventId; roomId: RoomId; actorParticipantId: ParticipantId;
  actorDeviceId: DeviceId; agentParticipantId: ParticipantId; name: string;
  canonicalPayload: Uint8Array; receivedAt: string }>;

/** Exact bytes and release identity survive a cursor retry or connector restart. */
export function renameDelivery(binding: SessionBinding, event: VerifiedRename) {
  const payload = new TextEncoder().encode(JSON.stringify(['khala.agent-rename.v1', event.roomId,
    event.eventId, event.actorParticipantId, event.agentParticipantId, event.name]));
  return {
    v: 1 as const,
    releaseId: `rename_${createHash('sha256').update(JSON.stringify([
      binding.bindingId, binding.generation, event.roomId, event.eventId])).digest('hex')}`,
    bindingId: binding.bindingId,
    generation: binding.generation,
    events: [{ v: 1 as const, roomId: event.roomId, eventId: event.eventId,
      authorParticipantId: event.actorParticipantId, authorDeviceId: event.actorDeviceId,
      contentDigest: `sha256:${createHash('sha256').update(event.canonicalPayload).digest('hex')}` }],
    payload,
    payloadDigest: `sha256:${createHash('sha256').update(payload).digest('hex')}`,
    receivedAt: event.receivedAt,
  };
}
