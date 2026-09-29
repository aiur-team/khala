// Hosted composition for the human-confirmed creation workflow. The workflow
// itself is backend-neutral (`@khala/messaging/channel-create/compose`); hosted
// and internal compositions differ only in the adapter they inject.

import { decodeRoomId, type AuthorizedChannelRef, type ChannelCreateAdapterPort,
  type RoomId, type TrustedClock } from '@khala/contracts/messaging/index';
import { type ChannelCreateSubstrate, createSubstrateChannelCreateAdapter } from '@khala/messaging/channel-create/adapter';
import type { MatrixHumanServices } from '../human/matrix';

const CREATED_REF_PREFIX = 'hosted-created.v1.';

/** Server-only reference. The room ID is recovered only after the create authority authorizes it. */
export function hostedCreatedChannelRef(roomId: RoomId): AuthorizedChannelRef {
  return `${CREATED_REF_PREFIX}${Buffer.from(roomId).toString('base64url')}` as AuthorizedChannelRef;
}

export function roomFromHostedCreatedRef(ref: string): RoomId | null {
  if (!ref.startsWith(CREATED_REF_PREFIX)) return null;
  const encoded = ref.slice(CREATED_REF_PREFIX.length);
  if (!/^[A-Za-z0-9_-]{8,512}$/u.test(encoded)) return null;
  const raw = Buffer.from(encoded, 'base64url').toString('utf8');
  if (Buffer.from(raw).toString('base64url') !== encoded) return null;
  const room = decodeRoomId(raw);
  return room.ok ? room.value : null;
}

/**
 * Hosted adapter: the owner's substrate creates the room, and the channel is
 * referenced by a server-only created-room ref. No catalog record is
 * written, so the channel is `secret` until its owner changes that.
 */
export function hostedChannelCreateAdapter(deps: Readonly<{
  substrate: ChannelCreateSubstrate;
  clock: TrustedClock;
}>): ChannelCreateAdapterPort {
  return createSubstrateChannelCreateAdapter({ substrate: deps.substrate,
    channelRef: hostedCreatedChannelRef, clock: deps.clock });
}

/** Select the approved owner's Matrix account separately for each workflow call. */
export function hostedMatrixChannelCreateAdapter(deps: Readonly<{
  matrix: Pick<MatrixHumanServices, 'channelCreateFor'>;
  clock: TrustedClock;
}>): ChannelCreateAdapterPort {
  const forOwner = (ownerId: Parameters<MatrixHumanServices['channelCreateFor']>[0]) =>
    hostedChannelCreateAdapter({ substrate: deps.matrix.channelCreateFor(ownerId), clock: deps.clock });
  return {
    create: (input, options) => forOwner(input.workflow.ownerId).create(input, options),
    reconcile: (input, options) => forOwner(input.workflow.ownerId).reconcile(input, options),
  };
}
