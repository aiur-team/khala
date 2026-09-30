import { describe, expect, it, vi } from 'vitest';
import { createDigests } from '../../invitations/internal';
import { createHostedChannelAdmissionProvider, type HostedAdmissionDiagnostic } from './hosted-channel-admission';
import { hostedCreatedChannelRef } from './channel-create';
import type { ProductionHumanRuntime } from '../human/production';

describe('hosted Matrix channel admission', () => {
  it.each(['owner_login', 'registration'] as const)('recovers a claimed admission after %s fails before agent account creation', async initialFailure => {
    const origin = 'https://khala.aiur.team';
    const roomId = '!room:matrix.example.test';
    const ownerId = 'owner_1';
    const secret = 'invitation-secret-with-more-than-32-bytes';
    const key = createDigests(secret).inviteKey('invite_12345678');
    let roomOwner = ownerId;
    let sponsorJoined = true;
    let matrixOwnerJoined = true;
    let joined = false;
    let accountExists = false;
    let ownerLoginDenied = false;
    let failOnce = true;
    let membershipFailure: number | null = null;
    let targetUnavailable = false;
    let claimUnavailable = false;
    let approvalUnavailable = false;
    let approvalThrows = false;
    const diagnostics: HostedAdmissionDiagnostic[] = [];
    const diagnostic = (event: HostedAdmissionDiagnostic) => diagnostics.push(event);
    const expectDiagnostic = (stage: HostedAdmissionDiagnostic['stage'], result: HostedAdmissionDiagnostic['result']) => {
      expect(diagnostics.splice(0)).toEqual([{ stage, result }]);
    };
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
          if (readKey === key && targetUnavailable) return { kind: 'unavailable' };
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
          if (claimUnavailable) return { kind: 'unavailable' };
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
        if (body.identifier.user.includes('khala_a_') && !accountExists) {
          return Response.json({ errcode: 'M_FORBIDDEN' }, { status: 403 });
        }
        if (!body.identifier.user.includes('khala_a_') && ownerLoginDenied) {
          return Response.json({ errcode: 'M_FORBIDDEN' }, { status: 403 });
        }
        if (!body.identifier.user.includes('khala_a_') && initialFailure === 'owner_login' && failOnce) {
          failOnce = false;
          return Response.json({ errcode: 'M_LIMIT_EXCEEDED' }, { status: 429 });
        }
        return Response.json({ user_id: body.identifier.user, device_id: body.device_id, access_token: 'test-token' });
      }
      if (path.includes('/state/m.room.member/')) {
        if (path.includes('khala_a_') && membershipFailure !== null) {
          return Response.json(membershipFailure === 200 ? { membership: ['leave'] }
            : { errcode: 'M_FORBIDDEN' }, { status: membershipFailure });
        }
        if (path.includes('khala_a_')) return joined
          ? Response.json({ membership: 'join' }) : Response.json({ errcode: 'M_NOT_FOUND' }, { status: 404 });
        return Response.json({ membership: matrixOwnerJoined ? 'join' : 'leave' });
      }
      if (path.includes('/profile/')) {
        return accountExists ? Response.json({ displayname: 'Agent' })
          : Response.json({ errcode: 'M_NOT_FOUND' }, { status: 404 });
      }
      if (path === '/_synapse/admin/v1/register') {
        if (initialFailure === 'registration' && failOnce) {
          failOnce = false;
          return Response.json({ errcode: 'M_UNKNOWN' }, { status: 503 });
        }
        if (init?.method !== 'POST') return Response.json({ nonce: 'test-nonce' });
        const body = JSON.parse(String(init.body)) as { username: string };
        accountExists = true;
        return Response.json({ user_id: `@${body.username}:matrix.example.test` });
      }
      if (path.endsWith('/invite')) return Response.json({});
      if (path.includes('/join/')) { joined = true; return Response.json({ room_id: roomId }); }
      return Response.json({ errcode: 'M_NOT_FOUND' }, { status: 404 });
    });
    let approved = true;
    const approvalPort = {
      current: async () => {
        if (approvalThrows) throw new Error('private approval failure');
        return approvalUnavailable ? 'unavailable' : approved ? 'current' : 'revoked';
      },
    } as const;
    const provider = createHostedChannelAdmissionProvider(runtime, { fetch: fetcher }, approvalPort, diagnostic);
    const request = { providerOperationId: 'provider_1', ownerId: ownerId as never, channelRef: key as never,
      requester: `agent_${'a'.repeat(43)}` as never, sessionGeneration: 2,
      sessionFingerprint: 'b'.repeat(43), deviceId: 'DEVICE_1' as never,
      history: 'none' as const };
    expect(await provider.reconcile(request)).toEqual({ kind: 'not_applied' });
    expect(await provider.admit(request)).toEqual({ kind: 'unavailable' });
    expectDiagnostic(initialFailure === 'owner_login' ? 'admission_matrix_inspect' : 'admission_matrix_admit', 'unavailable');
    expect([...claims.keys()].filter(key => key.startsWith('hosted-channel-admission.v1.'))).toHaveLength(1);
    expect(accountExists).toBe(false);
    expect(joined).toBe(false);
    const callsAfterFailure = fetcher.mock.calls.length;
    approved = false;
    expect(await provider.reconcile(request)).toEqual({ kind: 'rejected' });
    expectDiagnostic('admission_approval_recheck', 'rejected');
    expect(fetcher.mock.calls.length).toBe(callsAfterFailure);
    approved = true;
    for (const status of [200, 403, 404, 503]) {
      membershipFailure = status;
      expect(await provider.reconcile(request)).toEqual({ kind: 'unavailable' });
      expectDiagnostic('admission_matrix_inspect', 'unavailable');
      expect(accountExists).toBe(false);
      expect(joined).toBe(false);
    }
    membershipFailure = null;
    matrixOwnerJoined = false;
    const targetReads = () => fetcher.mock.calls.filter(([resource]) => {
      const path = new URL(String(resource)).pathname;
      return path.includes('/state/m.room.member/') && path.includes('khala_a_');
    }).length;
    const targetReadsBefore = targetReads();
    expect(await provider.reconcile(request)).toEqual({ kind: 'unavailable' });
    expectDiagnostic('admission_matrix_inspect', 'unavailable');
    expect(targetReads()).toBe(targetReadsBefore);
    matrixOwnerJoined = true;
    const restarted = createHostedChannelAdmissionProvider(runtime, { fetch: fetcher }, approvalPort, diagnostic);
    expect(await restarted.reconcile(request)).toEqual({ kind: 'admitted', membership: 'joined' });
    expectDiagnostic('admission_matrix_admit', 'ok');
    expect(await restarted.reconcile(request)).toEqual({ kind: 'admitted', membership: 'already_joined' });
    expectDiagnostic('admission_matrix_inspect', 'ok');
    expect([...claims.keys()].filter(key => key.startsWith('hosted-channel-admission.v1.'))).toHaveLength(1);
    expect([...claims.keys()].filter(key => key.startsWith('matrix.agent-identity.v1.'))).toHaveLength(1);
    expect([...claims.keys()].filter(key => key.startsWith('matrix.agent-participant.v1.'))).toHaveLength(1);
    ownerLoginDenied = true;
    expect(await restarted.reconcile(request)).toEqual({ kind: 'unavailable' });
    expectDiagnostic('admission_matrix_inspect', 'unavailable');
    ownerLoginDenied = false;
    expect(fetcher.mock.calls.filter(([resource, init]) => new URL(String(resource)).pathname.includes('/join/')
      && init?.method === 'POST')).toHaveLength(1);
    expect(await provider.admit({ ...request, deviceId: 'DEVICE_2' as never })).toEqual({ kind: 'unavailable' });
    expectDiagnostic('admission_claim', 'unavailable');
    approved = false;
    expect(await provider.reconcile(request)).toEqual({ kind: 'rejected' });
    expectDiagnostic('admission_approval_recheck', 'rejected');
    joined = false;
    expect(await provider.admit({ ...request, providerOperationId: 'provider_revoked' }))
      .toEqual({ kind: 'rejected' });
    expectDiagnostic('admission_approval_recheck', 'rejected');
    expect(joined).toBe(false);
    approved = true;
    approvalUnavailable = true;
    expect(await provider.admit({ ...request, providerOperationId: 'provider_approval_unavailable' }))
      .toEqual({ kind: 'unavailable' });
    expectDiagnostic('admission_approval_recheck', 'unavailable');
    approvalUnavailable = false;
    approvalThrows = true;
    expect(await provider.admit({ ...request, providerOperationId: 'provider_approval_throws' }))
      .toEqual({ kind: 'unavailable' });
    expectDiagnostic('admission_approval_recheck', 'unavailable');
    approvalThrows = false;
    claimUnavailable = true;
    expect(await provider.admit({ ...request, providerOperationId: 'provider_claim_unavailable' }))
      .toEqual({ kind: 'unavailable' });
    expectDiagnostic('admission_claim', 'unavailable');
    claimUnavailable = false;
    targetUnavailable = true;
    expect(await provider.admit({ ...request, providerOperationId: 'provider_target_unavailable' }))
      .toEqual({ kind: 'unavailable' });
    expectDiagnostic('admission_target_lookup', 'unavailable');
    targetUnavailable = false;
    roomOwner = 'owner_2';
    sponsorJoined = false;
    expect(await provider.admit({ ...request, providerOperationId: 'provider_2' })).toEqual({ kind: 'rejected' });
    expectDiagnostic('admission_target_lookup', 'rejected');

    roomOwner = ownerId;
    sponsorJoined = true;
    const created = { ...request, providerOperationId: 'provider_created',
      channelRef: hostedCreatedChannelRef(roomId as never) };
    expect(await provider.admit(created)).toEqual({ kind: 'admitted', membership: 'joined' });
    expectDiagnostic('admission_matrix_admit', 'ok');
    expect(await provider.reconcile(created)).toEqual({ kind: 'admitted', membership: 'already_joined' });
    expectDiagnostic('admission_matrix_inspect', 'ok');
    roomOwner = 'owner_2';
    expect(await provider.admit({ ...created, providerOperationId: 'provider_wrong_owner' })).toEqual({ kind: 'rejected' });
    expectDiagnostic('admission_target_lookup', 'rejected');
  });
});
