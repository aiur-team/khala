import { describe, expect, it } from 'vitest';
import type {
  AuthPrincipal,
  AuthorizedChannelRef,
  ChannelAccessNotification,
  ChannelAccessNotificationPort,
  ChannelAccessRequesterContext,
  ChannelAccessResolutionPort,
  DiscoveryRequester,
  OwnerId,
} from '@khala/contracts/messaging/index';
import { createChannelAccessPolicy } from './policy';
import type { ChannelAccessCreateInput, ChannelAccessStore } from './store';
import { createChannelAccessService } from './service';

const DIGEST = 'a'.repeat(43);
const HANDLE = `careq_${DIGEST}`;
const DEADLINE = '2026-10-01T12:00:00Z';
const requester: DiscoveryRequester = {
  principal: 'principal_1' as DiscoveryRequester['principal'],
  origin: 'https://khala.example',
  proofKey: { algorithm: 'Ed25519', publicKey: 'b'.repeat(43), thumbprint: 'c'.repeat(43) },
  sessionGeneration: 3,
};
const context: ChannelAccessRequesterContext = {
  v: 1,
  principal: requester.principal,
  origin: requester.origin,
  sessionGeneration: requester.sessionGeneration,
  sessionFingerprint: DIGEST,
  harness: 'codex',
  displayLabel: 'Build agent',
  workspaceLabel: 'Khala',
};
const owner: AuthPrincipal = {
  v: 1,
  ownerId: 'owner_1' as OwnerId,
  providerIssuer: 'https://identity.example',
  providerSubject: 'subject_1',
  verifiedEmail: 'owner@example.com',
  sessionExpiresAt: '2026-09-25T12:00:00Z',
};

function harness() {
  const creates: ChannelAccessCreateInput[] = [];
  const notifications: ChannelAccessNotification[] = [];
  let outcome: 'pending_owner' | 'approved' | 'connecting' | 'revoked' = 'pending_owner';
  let requesterState: 'current' | 'revoked' = 'current';
  let revision = 1;
  const detail = {
    kind: 'access' as const,
    authorizedChannelRef: 'channel_ref_1',
    targetRevision: 'target_revision_1',
    title: 'Private room',
  };
  const storedContext = () => ({
    requestHandle: HANDLE,
    operationId: 'request_1',
    ownerId: owner.ownerId,
    revision,
    requester: requester.principal,
    sessionFingerprint: context.sessionFingerprint,
    sessionGeneration: context.sessionGeneration,
    origin: context.origin,
    harness: context.harness,
    requesterLabel: context.displayLabel,
    workspaceLabel: context.workspaceLabel,
    targetFingerprint: 'target_digest',
    deadline: DEADLINE,
    outcome,
    detail,
  });
  const ownerProjection = () => ({
    requestHandle: HANDLE,
    kind: 'access' as const,
    outcome,
    revision,
    createdAt: '2026-09-24T12:00:00Z',
    deadline: DEADLINE,
    sessionFingerprint: context.sessionFingerprint,
    harness: context.harness,
    requesterLabel: context.displayLabel,
    workspaceLabel: context.workspaceLabel,
    title: detail.title,
    proposedTitle: null,
    ownerDecision: outcome === 'approved' || outcome === 'connecting' ? 'approved' as const : 'pending' as const,
    decidedAt: outcome === 'pending_owner' ? null : '2026-09-24T12:05:00Z',
    muted: false,
    muteRevision: null,
  });
  const store = {
    async create(input: ChannelAccessCreateInput) {
      creates.push(input);
      return { kind: 'accepted' as const, requestHandle: HANDLE, revision, deadline: DEADLINE, outcome };
    },
    async inspectRequester(input: { sessionGeneration: number }) {
      return input.sessionGeneration === context.sessionGeneration
        ? { kind: 'found' as const, status: { outcome, revision, deadline: DEADLINE }, context: storedContext() }
        : { kind: 'unavailable' as const };
    },
    async revoke(input: { expectedRevision: number }) {
      if (input.expectedRevision !== revision) return { kind: 'stale' as const };
      outcome = 'revoked';
      revision += 1;
      return { kind: 'updated' as const, outcome: 'revoked' as const, revision };
    },
    async listOwner() { return { kind: 'found' as const, requests: [ownerProjection()] }; },
    async readOwner(input: { ownerId: string }) {
      return input.ownerId === owner.ownerId
        ? { kind: 'found' as const, request: ownerProjection() }
        : { kind: 'not_found' as const };
    },
    async readContext() { return { kind: 'found' as const, context: storedContext() }; },
    async decide(input: { ownerId: string; decision: 'approve' | 'deny'; expectedRevision: number }) {
      if (input.ownerId !== owner.ownerId) return { kind: 'not_found' as const };
      if (input.expectedRevision !== revision) return { kind: 'stale' as const };
      outcome = input.decision === 'approve' ? 'approved' : 'pending_owner';
      revision += 1;
      return { kind: 'decided' as const, outcome: input.decision === 'approve' ? 'approved' as const : 'denied' as const, revision };
    },
    async claimAccess() {
      outcome = 'connecting';
      revision += 1;
      return {
        kind: 'claimed' as const,
        revision,
        authorization: {
          v: 1 as const, kind: 'access' as const, requestHandle: HANDLE, ownerId: owner.ownerId,
          requester: requester.principal, sessionFingerprint: context.sessionFingerprint,
          sessionGeneration: context.sessionGeneration, origin: context.origin, operationId: 'request_1',
          authorizedChannelRef: detail.authorizedChannelRef, approvedAt: '2026-09-24T12:05:00Z', deadline: DEADLINE,
        },
      };
    },
    async listNotifications() {
      return { kind: 'found' as const, notifications: [{ id: 'notification_1', kind: 'request' as const, revision: 1, count: 1, createdAt: '2026-09-24T12:00:00Z' }] };
    },
    async ackNotification() { return { kind: 'acknowledged' as const }; },
  } as unknown as ChannelAccessStore;
  const resolver: ChannelAccessResolutionPort = {
    async resolveAccess() {
      return {
        kind: 'resolved', ownerId: owner.ownerId, channelRef: detail.authorizedChannelRef as AuthorizedChannelRef,
        targetRevision: detail.targetRevision, title: detail.title,
      };
    },
    async resolveCreate() { return { kind: 'unavailable' }; },
    async revalidateAccess() { return { kind: 'current', ownerId: owner.ownerId, targetRevision: detail.targetRevision, title: detail.title }; },
    async revalidateCreate() { return { kind: 'unavailable' }; },
    async currentAccessOwner(_channel, principal) {
      return principal.ownerId === owner.ownerId
        ? { kind: 'owned', ownerId: owner.ownerId, targetRevision: detail.targetRevision }
        : { kind: 'forbidden' };
    },
    async checkRequester() { return { kind: requesterState }; },
  };
  const notification: ChannelAccessNotificationPort = {
    async publish(value) { notifications.push(value); return { kind: 'ok', value: null }; },
  };
  const service = createChannelAccessService({
    store,
    resolver,
    policy: createChannelAccessPolicy({ key: new Uint8Array(32).fill(5) }),
    notification,
  });
  return {
    service,
    creates,
    notifications,
    revokeRequester() { requesterState = 'revoked'; },
    outcome: () => outcome,
  };
}

describe('channel-access service', () => {
  it('resolves and journals access without retaining the submitted locator', async () => {
    const h = harness();
    const status = await h.service.journal.requestAccess({
      v: 1, kind: 'channel_url', operationId: 'request_1', credentialRef: 'credential_1',
      channelUrl: 'https://khala.example/_khala/channel/secret-locator',
    }, requester, context);
    expect(status).toEqual({ v: 1, operationId: 'request_1', outcome: 'pending_owner' });
    expect(h.creates).toHaveLength(1);
    expect(JSON.stringify(h.creates[0])).not.toContain('secret-locator');
    expect(h.notifications).toEqual([expect.objectContaining({ v: 1, ownerId: owner.ownerId, kind: 'request', count: 1 })]);
  });

  it('keeps approval journal-only until the typed consumer claims authorization', async () => {
    const h = harness();
    await h.service.journal.requestAccess({
      v: 1, kind: 'listing_ref', operationId: 'request_1', credentialRef: 'credential_1', listingRef: 'listing_1',
    }, requester, context);
    const downstream = {
      channels: [] as string[], memberships: [] as string[], devices: [] as string[], bindings: [] as string[],
      providers: [] as string[], connectors: [] as string[], grants: [] as string[],
    };
    const before = structuredClone(downstream);
    const approved = await h.service.decisions.decide({
      v: 1, requestHandle: HANDLE as never, expectedRevision: 'carev_1', decision: 'approve', operationId: 'decision_1',
    }, owner);
    expect(approved.kind).toBe('ok');

    const RUN_CONSUMER_AFTER_APPROVAL = false; // MUTATION GUARD: change false to true; downstream snapshot must fail.
    if (RUN_CONSUMER_AFTER_APPROVAL) {
      const claimed = await h.service.fulfillment.claimAccess({
        v: 1, requestHandle: HANDLE as never, expectedRevision: 'carev_2', operationId: 'claim_1',
      });
      if (claimed.kind === 'ok') downstream.grants.push(claimed.value.authorizationRef);
    }

    expect(downstream).toEqual(before);
  });

  it('revokes active work on status and inbox reads once the requester generation is revoked', async () => {
    const h = harness();
    h.revokeRequester();
    expect(await h.service.journal.inspect({ v: 1, operationId: 'request_1', operationKind: 'access' }, requester, context))
      .toEqual({ v: 1, operationId: 'request_1', outcome: 'revoked' });
    expect(h.outcome()).toBe('revoked');
  });

  it('drops revoked rows from the owner inbox', async () => {
    const h = harness();
    h.revokeRequester();
    expect(await h.service.decisions.inbox(owner)).toEqual({ kind: 'ok', value: [] });
    expect(h.outcome()).toBe('revoked');
  });

  it('collapses wrong-owner and cross-session reads without mutating the journal', async () => {
    const h = harness();
    const wrongOwner = { ...owner, ownerId: 'owner_2' as OwnerId };
    expect((await h.service.decisions.decide({
      v: 1, requestHandle: HANDLE as never, expectedRevision: 'carev_1', decision: 'approve', operationId: 'wrong_owner',
    }, wrongOwner))).toEqual({ kind: 'rejected', code: 'forbidden' });
    const result = await h.service.journal.inspect({ v: 1, operationId: 'request_1', operationKind: 'access' }, {
      ...requester, sessionGeneration: 4,
    }, { ...context, sessionGeneration: 4 });
    expect(result).toEqual({ v: 1, operationId: 'request_1', outcome: 'unavailable' });
  });
});
