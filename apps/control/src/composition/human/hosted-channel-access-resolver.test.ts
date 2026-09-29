import { describe, expect, it } from 'vitest';
import { createDigests } from '../../invitations/internal';
import { createHostedChannelAccessResolver } from './hosted-channel-access-resolver';
import type { ProductionHumanRuntime } from './production';

const origin = 'https://khala.aiur.team';
const secret = 'invitation-secret-with-more-than-32-bytes';
const inviteRef = 'invite_12345678';
const roomId = '!room:matrix.example.test';
const ownerId = 'owner_1';
const key = createDigests(secret).inviteKey(inviteRef);
const requester = { principal: 'agent_key' as never, origin, sessionGeneration: 2,
  proofKey: { algorithm: 'Ed25519' as const, publicKey: 'a'.repeat(43), thumbprint: 'b'.repeat(43) } };
const context = { v: 1 as const, principal: requester.principal, origin, sessionGeneration: 2,
  sessionFingerprint: requester.proofKey.thumbprint, harness: 'codex', displayLabel: null, workspaceLabel: null };

describe('hosted channel-access resolver', () => {
  it('requires current key approval, active exact link, and live Matrix owner on every recheck', async () => {
    let status: 'active' | 'revoked' = 'active';
    let roomOwner = ownerId;
    let approved = true;
    const runtime = {
      env: { publicAppOrigin: origin, invitationHmacSecret: secret }, clock: () => 1000,
      store: { async read(readKey: string) {
        if (readKey !== key) return { kind: 'absent' as const };
        return { kind: 'record' as const, record: { key, revision: 'revision_1', operationId: 'share_1',
          expiresAt: null, value: { v: 1, roomId, creatorOwnerId: ownerId,
            inviteRefDigest: createDigests(secret).inviteRef(inviteRef), policyRevision: 1,
            policy: { v: 1, kind: 'link', history: 'none' }, status,
            expiresAt: null, lastAuthorizedOperationDigest: null } } };
      } },
      matrix: { inspectRoomAuthority: async () => roomOwner,
        inspectOwnerMembership: async () => ({ kind: 'joined' as const }) },
    } as unknown as ProductionHumanRuntime;
    const authority = {
      inspect: async (_requester: unknown, owner: string) => approved && owner === ownerId ? 'current' as const : 'revoked' as const,
      inspectContext: async (_context: unknown, owner: string) => approved && owner === ownerId ? 'current' as const : 'revoked' as const,
      checkContext: async () => approved ? 'current' as const : 'revoked' as const,
    };
    const resolver = createHostedChannelAccessResolver(runtime, authority);
    const input = { v: 1 as const, kind: 'channel_url' as const, operationId: 'op_1', credentialRef: 'cred_1',
      channelUrl: `${origin}/join/${inviteRef}` };
    expect(await resolver.resolveAccess({ ...input, channelUrl: 'https://evil.test/join/invite_12345678' }, requester))
      .toEqual({ kind: 'unavailable' });
    const resolved = await resolver.resolveAccess(input, requester);
    expect(resolved).toMatchObject({ kind: 'resolved', ownerId, channelRef: key });
    if (resolved.kind !== 'resolved') throw new Error('target unavailable');
    expect(await resolver.currentAccessOwner(resolved.channelRef, { ownerId } as never))
      .toEqual({ kind: 'owned', ownerId, targetRevision: resolved.targetRevision });
    expect(await resolver.revalidateAccess({ ownerId: ownerId as never, channelRef: resolved.channelRef,
      targetRevision: resolved.targetRevision, requester: context })).toMatchObject({ kind: 'current' });
    approved = false;
    expect(await resolver.revalidateAccess({ ownerId: ownerId as never, channelRef: resolved.channelRef,
      targetRevision: resolved.targetRevision, requester: context })).toEqual({ kind: 'revoked' });
    approved = true;
    roomOwner = 'owner_2';
    expect(await resolver.resolveAccess(input, requester)).toEqual({ kind: 'unavailable' });
    roomOwner = ownerId;
    status = 'revoked';
    expect(await resolver.revalidateAccess({ ownerId: ownerId as never, channelRef: resolved.channelRef,
      targetRevision: resolved.targetRevision, requester: context })).toEqual({ kind: 'revoked' });
  });
});
