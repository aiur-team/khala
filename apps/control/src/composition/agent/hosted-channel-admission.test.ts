import { describe, expect, it, vi } from 'vitest';
import { createDigests } from '../../invitations/internal';
import { createHostedChannelAdmissionProvider } from './hosted-channel-admission';
import type { ProductionHumanRuntime } from '../human/production';

describe('hosted Matrix channel admission', () => {
  it('joins only for a current sponsor membership and reconciles a durable retry', async () => {
    const origin = 'https://khala.aiur.team';
    const roomId = '!room:matrix.example.test';
    const ownerId = 'owner_1';
    const secret = 'invitation-secret-with-more-than-32-bytes';
    const key = createDigests(secret).inviteKey('invite_12345678');
    let roomOwner = ownerId;
    let sponsorJoined = true;
    let joined = false;
    const claims = new Map<string, { value: unknown; revision: string }>();
    const runtime = {
      env: { publicAppOrigin: origin, publicHomeserverOrigin: 'https://matrix.example.test',
        matrixServerName: 'matrix.example.test', invitationHmacSecret: secret,
        registrationSharedSecret: 'registration-secret-with-more-than-32-bytes',
        matrixRegistrationSharedSecret: 'registration-secret-with-more-than-32-bytes',
        matrixPasswordDerivationSecret: 'password-secret-with-more-than-32-bytes' },
      clock: () => 1000,
      store: {
        async read(readKey: string) {
          const claim = claims.get(readKey);
          if (claim) return { kind: 'record', record: { key: readKey, operationId: 'claim_1',
            expiresAt: null, ...claim } };
          return readKey === key ? { kind: 'record', record: { key, revision: 'share_1', operationId: 'share_1',
            expiresAt: null, value: { v: 1, roomId, creatorOwnerId: ownerId,
              inviteRefDigest: createDigests(secret).inviteRef('invite_12345678'), policyRevision: 1,
              policy: { v: 1, kind: 'link', history: 'none' }, status: 'active',
              expiresAt: null, lastAuthorizedOperationDigest: null } } } : { kind: 'absent' };
        },
        async compareAndSet(input: { key: string; next: { value: unknown } }) {
          const existing = claims.get(input.key);
          if (existing) return { kind: 'conflict', current: existing };
          const record = { value: input.next.value, revision: 'claim_1' };
          claims.set(input.key, record);
          return { kind: 'applied', record };
        },
      },
      matrix: { inspectRoomAuthority: async () => roomOwner,
        inspectOwnerMembership: async () => ({ kind: sponsorJoined ? 'joined' : 'absent' }) },
    } as unknown as ProductionHumanRuntime;
    const fetcher = vi.fn<typeof fetch>(async (resource, init) => {
      const path = new URL(String(resource)).pathname;
      if (path === '/_matrix/client/v3/login') {
        const body = JSON.parse(String(init?.body)) as { identifier: { user: string }; device_id: string };
        return Response.json({ user_id: body.identifier.user, device_id: body.device_id, access_token: 'test-token' });
      }
      if (path.includes('/state/m.room.member/')) {
        if (path.includes('khala_a_')) return joined
          ? Response.json({ membership: 'join' }) : Response.json({ errcode: 'M_NOT_FOUND' }, { status: 404 });
        return Response.json({ membership: 'join' });
      }
      if (path.includes('/profile/')) return Response.json({ displayname: 'Agent' });
      if (path.endsWith('/invite')) return Response.json({});
      if (path.includes('/join/')) { joined = true; return Response.json({ room_id: roomId }); }
      return Response.json({ errcode: 'M_NOT_FOUND' }, { status: 404 });
    });
    let approved = true;
    const approvalPort = {
      current: async () => approved ? 'current' : 'revoked',
    } as const;
    const provider = createHostedChannelAdmissionProvider(runtime, { fetch: fetcher }, approvalPort);
    const request = { providerOperationId: 'provider_1', ownerId: ownerId as never, channelRef: key as never,
      requester: `agent_${'a'.repeat(43)}` as never, sessionGeneration: 2, deviceId: 'DEVICE_1' as never,
      history: 'none' as const };
    expect(await provider.reconcile(request)).toEqual({ kind: 'not_applied' });
    expect(await provider.admit(request)).toEqual({ kind: 'admitted', membership: 'joined' });
    const restarted = createHostedChannelAdmissionProvider(runtime, { fetch: fetcher }, approvalPort);
    expect(await restarted.reconcile(request)).toEqual({ kind: 'admitted', membership: 'already_joined' });
    expect(await provider.admit({ ...request, deviceId: 'DEVICE_2' as never })).toEqual({ kind: 'unavailable' });
    approved = false;
    expect(await provider.reconcile(request)).toEqual({ kind: 'rejected' });
    joined = false;
    expect(await provider.admit({ ...request, providerOperationId: 'provider_revoked' }))
      .toEqual({ kind: 'rejected' });
    expect(joined).toBe(false);
    approved = true;
    roomOwner = 'owner_2';
    sponsorJoined = false;
    expect(await provider.admit({ ...request, providerOperationId: 'provider_2' })).toEqual({ kind: 'rejected' });
  });
});
