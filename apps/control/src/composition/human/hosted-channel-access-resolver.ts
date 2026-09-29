import { decodeRoomId, type ChannelAccessRequesterContext, type ChannelAccessResolutionPort,
  type DiscoveryRequester, type JsonValue, type OwnerId, type RoomId } from '@khala/contracts/messaging/index';
import { createDigests } from '../../invitations/internal';
import { readInviteRecord } from '../../invitations/policy';
import { inviteFromShareLink } from '../agent/production-bootstrap';
import type { ProductionHumanRuntime } from './production';

/** The discovery authority must recheck the exact approved owner, key and session. */
export type HostedAccessRequesterAuthority = Readonly<{
  inspect(requester: DiscoveryRequester, ownerId: OwnerId): Promise<'current' | 'revoked' | 'unavailable'>;
  inspectContext(context: ChannelAccessRequesterContext, ownerId: OwnerId): Promise<'current' | 'revoked' | 'unavailable'>;
  checkContext(context: ChannelAccessRequesterContext): Promise<'current' | 'revoked' | 'unavailable'>;
}>;

export type HostedAccessTarget = Readonly<{ ownerId: OwnerId; roomCreatorId: OwnerId; roomId: RoomId;
  revision: string; key: string; inviteRefDigest: string }>;
const REVISION_PREFIX = 'hosted-invite-v1:';

/** Resolve a sponsor's live personal link; the room creator may be another human. */
export async function readHostedAccessTarget(active: ProductionHumanRuntime, key: string): Promise<HostedAccessTarget | null | 'unavailable'> {
  if (!/^invitations\.invite\.[A-Za-z0-9_-]{43}$/u.test(key)) return null;
  const read = await active.store.read<JsonValue>(key);
  if (read.kind === 'unavailable') return 'unavailable';
  if (read.kind !== 'record') return null;
  const invite = readInviteRecord(read.record.value);
  if (!invite || invite.status !== 'active' || invite.expiresAt !== null
    && active.clock() >= Date.parse(invite.expiresAt)) return null;
  const room = decodeRoomId(invite.roomId);
  if (!room.ok) return null;
  const roomOwner = await active.matrix.inspectRoomAuthority(room.value);
  if (roomOwner === null) return 'unavailable';
  const membership = await active.matrix.inspectOwnerMembership(invite.creatorOwnerId, room.value);
  if (membership.kind === 'unavailable') return 'unavailable';
  if (membership.kind !== 'joined') return null;
  return { ownerId: invite.creatorOwnerId, roomCreatorId: roomOwner, roomId: room.value, key,
    revision: read.record.revision, inviteRefDigest: invite.inviteRefDigest };
}

/** A share link locates a room; it never authenticates an agent or admits a device. */
export function createHostedChannelAccessResolver(
  active: ProductionHumanRuntime,
  authority: HostedAccessRequesterAuthority,
): ChannelAccessResolutionPort {
  const digests = createDigests(active.env.invitationHmacSecret);

  function revision(target: HostedAccessTarget): string {
    return `${REVISION_PREFIX}${Buffer.from(JSON.stringify([target.key, target.revision])).toString('base64url')}`;
  }

  function parseRevision(value: string): readonly [string, string] | null {
    if (!value.startsWith(REVISION_PREFIX) || value.length > 512) return null;
    try {
      const decoded: unknown = JSON.parse(Buffer.from(value.slice(REVISION_PREFIX.length), 'base64url').toString('utf8'));
      return Array.isArray(decoded) && decoded.length === 2 && decoded.every(part => typeof part === 'string')
        ? decoded as [string, string] : null;
    } catch { return null; }
  }

  return {
    async resolveAccess(input, requester) {
      if (input.kind !== 'channel_url') return { kind: 'unavailable' };
      let url: URL;
      try { url = new URL(input.channelUrl); } catch { return { kind: 'unavailable' }; }
      const inviteRef = inviteFromShareLink(url, active.env.publicAppOrigin);
      if (inviteRef === null) return { kind: 'unavailable' };
      const target = await readHostedAccessTarget(active, digests.inviteKey(inviteRef));
      if (target === null || target === 'unavailable' || target.inviteRefDigest !== digests.inviteRef(inviteRef)
        || (await authority.inspect(requester, target.ownerId)) !== 'current') return { kind: 'unavailable' };
      return { kind: 'resolved', ownerId: target.ownerId, channelRef: target.key as never,
        targetRevision: revision(target), title: 'Channel' };
    },
    async resolveCreate() { return { kind: 'unavailable' }; },
    async revalidateAccess(input) {
      const decoded = parseRevision(input.targetRevision);
      if (decoded === null) return { kind: 'revoked' };
      const target = await readHostedAccessTarget(active, decoded[0]);
      if (target === 'unavailable') return { kind: 'unavailable' };
      if (target === null || target.revision !== decoded[1] || target.key !== input.channelRef
        || target.ownerId !== input.ownerId) return { kind: 'revoked' };
      const requester = await authority.inspectContext(input.requester, target.ownerId);
      return requester === 'current' ? { kind: 'current', ownerId: target.ownerId,
        targetRevision: input.targetRevision, title: 'Channel' }
        : { kind: requester === 'revoked' ? 'revoked' : 'unavailable' };
    },
    async revalidateCreate() { return { kind: 'revoked' }; },
    async currentAccessOwner(channelRef, owner) {
      const target = await readHostedAccessTarget(active, channelRef);
      if (target === 'unavailable') return { kind: 'unavailable' };
      return target !== null && target.ownerId === owner.ownerId
        ? { kind: 'owned', ownerId: owner.ownerId, targetRevision: revision(target) }
        : { kind: 'forbidden' };
    },
    async checkRequester(context) {
      const result = await authority.checkContext(context);
      return { kind: result };
    },
  };
}
