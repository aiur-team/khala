import type { OwnerId, RoomId } from '@khala/contracts/messaging/index';
import type { ProductionHumanRuntime } from '../human/production';
import { roomFromHostedCreatedRef } from './channel-create';

/** A create ref is usable only while the recorded owner still controls the Matrix room. */
export async function readHostedCreatedTarget(active: ProductionHumanRuntime, ref: string,
  ownerId: OwnerId): Promise<Readonly<{ ownerId: OwnerId; roomId: RoomId }> | null | 'unavailable'> {
  const roomId = roomFromHostedCreatedRef(ref);
  if (roomId === null) return null;
  const owner = await active.matrix.inspectRoomAuthority(roomId);
  if (owner === null) return 'unavailable';
  if (owner !== ownerId) return null;
  const member = await active.matrix.inspectOwnerMembership(ownerId, roomId);
  if (member.kind === 'unavailable') return 'unavailable';
  return member.kind === 'joined' ? { ownerId, roomId } : null;
}
