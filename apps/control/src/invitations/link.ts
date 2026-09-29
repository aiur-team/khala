import type {
  AuthPrincipal, ChannelAccessRequesterContext, ControlStore, DiscoveryRequester, RoomId,
} from '@khala/contracts/messaging/index';
import type { GatewayInspection } from './index';
import { createDigests, safeRead } from './internal';
import { policyAllows, readInviteRecord } from './policy';

/** The only share URL accepted by browser and native-agent resolution. */
export function inviteFromShareLink(url: URL, origin: string): string | null {
  if (url.origin !== origin || url.username || url.password || url.search || url.hash
    || !url.pathname.startsWith('/join/')) return null;
  const encoded = url.pathname.slice('/join/'.length);
  if (!encoded || encoded.includes('/')) return null;
  try {
    const invite = decodeURIComponent(encoded);
    return /^[A-Za-z0-9_-]{8,256}$/u.test(invite) ? invite : null;
  } catch {
    return null;
  }
}

export type AgentLinkResolution =
  | Readonly<{ kind: 'resolved'; roomId: RoomId; revision: string }>
  | Readonly<{ kind: 'use_your_link' | 'expired' | 'revoked' | 'forbidden' | 'invalid_link' | 'unavailable' }>;

/** Sponsor identity and native-session facts must come from trusted authentication, never request JSON. */
export async function resolveAgentChannelLink(input: Readonly<{
  channelUrl: string;
  origin: string;
  store: ControlStore;
  secret: string;
  clock: () => number;
  sponsor: AuthPrincipal;
  requester: DiscoveryRequester;
  context: ChannelAccessRequesterContext;
  inspectMembership(principal: AuthPrincipal, roomId: RoomId): Promise<GatewayInspection>;
}>): Promise<AgentLinkResolution> {
  if (input.requester.principal !== input.context.principal
    || input.requester.origin !== input.context.origin
    || input.requester.sessionGeneration !== input.context.sessionGeneration
    || input.context.origin !== input.origin || !input.context.sessionFingerprint) return { kind: 'forbidden' };
  let parsed: URL;
  try { parsed = new URL(input.channelUrl); } catch { return { kind: 'invalid_link' }; }
  const inviteRef = inviteFromShareLink(parsed, input.origin);
  if (inviteRef === null) return { kind: 'invalid_link' };
  const digests = createDigests(input.secret);
  const read = await safeRead(input.store, digests.inviteKey(inviteRef));
  if (read.kind === 'unavailable') return { kind: 'unavailable' };
  if (read.kind === 'absent') return { kind: 'revoked' };
  const invite = readInviteRecord(read.record.value);
  if (!invite || invite.inviteRefDigest !== digests.inviteRef(inviteRef)) return { kind: 'unavailable' };
  if (invite.status === 'revoked') return { kind: 'revoked' };
  if (invite.expiresAt !== null && input.clock() >= Date.parse(invite.expiresAt)) return { kind: 'expired' };
  if (invite.creatorOwnerId !== input.sponsor.ownerId) return { kind: 'use_your_link' };
  if (!policyAllows(invite.policy, input.sponsor, digests)) return { kind: 'forbidden' };
  let membership: GatewayInspection;
  try { membership = await input.inspectMembership(input.sponsor, invite.roomId); }
  catch { return { kind: 'unavailable' }; }
  if (membership.kind === 'unavailable') return { kind: 'unavailable' };
  if (membership.kind !== 'joined') return { kind: 'forbidden' };
  return { kind: 'resolved', roomId: invite.roomId, revision: read.record.revision };
}
