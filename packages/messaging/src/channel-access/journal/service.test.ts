import { describe, expect, it } from 'vitest';
import type {
  AuthPrincipal,
  AuthorizedChannelRef,
  ChannelAccessNotification,
  ChannelAccessNotificationPort,
  ChannelAccessOwnershipResult,
  ChannelAccessRequesterContext,
  ChannelAccessResolutionPort,
  ChannelAccessRevalidationResult,
  ChannelCreateRevalidationResult,
  DiscoveryRequester,
  OwnerId,
} from '@khala/contracts/messaging/index';
import { CHANNEL_ACCESS_COOLDOWN_MS, createChannelAccessPolicy } from './policy';
import { createChannelAccessStore, type ChannelAccessStore } from './store';
import { createChannelAccessService } from './service';
import { fakeControlStore } from './support.test';

const T0 = Date.parse('2026-09-24T12:00:00Z');
const DIGEST = 'a'.repeat(43);
const CHANNEL_REF = 'channel_ref_1' as AuthorizedChannelRef;
const TARGET_REVISION = 'target_revision_1';
const OWNER_REVISION = 'owner_revision_1';
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
const otherOwner: AuthPrincipal = { ...owner, ownerId: 'owner_2' as OwnerId, providerSubject: 'subject_2' };

function harness() {
  let now = T0;
  const backing = fakeControlStore();
  const policy = createChannelAccessPolicy({ key: new Uint8Array(32).fill(5) });
  const journal = createChannelAccessStore({ store: backing.store, policy, clock: () => now });
  const claims: string[] = [];
  const store: ChannelAccessStore = {
    ...journal,
    async claimAccess(...args) { claims.push('access'); return journal.claimAccess(...args); },
    async claimCreate(...args) { claims.push('create'); return journal.claimCreate(...args); },
  };
  const notifications: ChannelAccessNotification[] = [];
  const ownershipCalls: unknown[] = [];
  const state: {
    requester: 'current' | 'revoked';
    access: ChannelAccessRevalidationResult;
    create: ChannelCreateRevalidationResult;
    ownership: (principal: AuthPrincipal) => ChannelAccessOwnershipResult;
  } = {
    requester: 'current',
    access: { kind: 'current', ownerId: owner.ownerId, targetRevision: TARGET_REVISION, title: 'Private channel' },
    create: { kind: 'current', ownerId: owner.ownerId, ownerRevision: OWNER_REVISION },
    ownership: principal => principal.ownerId === owner.ownerId
      ? { kind: 'owned', ownerId: owner.ownerId, targetRevision: TARGET_REVISION }
      : { kind: 'forbidden' },
  };
  const resolver: ChannelAccessResolutionPort = {
    async resolveAccess() {
      return { kind: 'resolved', ownerId: owner.ownerId, channelRef: CHANNEL_REF, targetRevision: TARGET_REVISION, title: 'Private channel' };
    },
    async resolveCreate() { return { kind: 'resolved', ownerId: owner.ownerId, ownerRevision: OWNER_REVISION }; },
    async revalidateAccess() { return state.access; },
    async revalidateCreate() { return state.create; },
    async currentAccessOwner(channelRef, principal) {
      ownershipCalls.push([channelRef, principal.ownerId]);
      return state.ownership(principal);
    },
    async checkRequester() { return { kind: state.requester }; },
  };
  const notification: ChannelAccessNotificationPort = {
    async publish(value) { notifications.push(value); return { kind: 'ok', value: null }; },
  };
  const service = createChannelAccessService({ store, resolver, policy, notification });

  async function handle(): Promise<string> {
    const listed = await journal.listOwner({ ownerId: owner.ownerId });
    if (listed.kind !== 'found' || listed.requests.length === 0) throw new Error('request missing');
    return listed.requests[listed.requests.length - 1]!.requestHandle;
  }

  return {
    service,
    backing,
    journal,
    claims,
    notifications,
    ownershipCalls,
    state,
    handle,
    advance(ms: number) { now += ms; },
    async requestAccess(operationId = 'request_1') {
      const status = await service.journal.requestAccess({
        v: 1, kind: 'listing_ref', operationId, credentialRef: 'credential_1', listingRef: 'listing_1',
      }, requester, context);
      expect(status.outcome).toBe('pending_owner');
      return handle();
    },
    async requestCreate(operationId = 'create_1') {
      const status = await service.journal.requestCreate({
        v: 1, operationId, credentialRef: 'credential_1', origin: requester.origin, proposedTitle: 'New channel',
      }, requester, context);
      expect(status.outcome).toBe('pending_owner');
      return handle();
    },
    async outcome(requestHandle: string) {
      const located = await journal.readContext({ requestHandle });
      if (located.kind !== 'found') throw new Error('request missing');
      return located.context.outcome;
    },
    mutes() {
      const aggregate = [...backing.records.values()][0]?.value as { mutes?: Record<string, { enabled: boolean }> };
      return Object.values(aggregate.mutes ?? {});
    },
  };
}

function approve(requestHandle: string, operationId = 'decision_1') {
  return { v: 1 as const, requestHandle: requestHandle as never, expectedRevision: 'carev_1', decision: 'approve' as const, operationId };
}

describe('channel-access service', () => {
  it('resolves and journals access without retaining the submitted locator', async () => {
    const h = harness();
    const status = await h.service.journal.requestAccess({
      v: 1, kind: 'channel_url', operationId: 'request_1', credentialRef: 'credential_1',
      channelUrl: 'https://khala.example/_khala/channel/secret-locator',
    }, requester, context);
    expect(status).toEqual({ v: 1, operationId: 'request_1', outcome: 'pending_owner' });
    expect(h.backing.records.size).toBeGreaterThan(0);
    expect(JSON.stringify([...h.backing.records.values()])).not.toContain('secret-locator');
    expect(h.notifications).toEqual([expect.objectContaining({ v: 1, ownerId: owner.ownerId, kind: 'request', count: 1 })]);
  });

  it('keeps approval journal-only until the typed consumer claims authorization', async () => {
    const h = harness();
    const requestHandle = await h.requestAccess();
    const approved = await h.service.decisions.decide(approve(requestHandle), owner);
    expect(approved).toMatchObject({ kind: 'ok', value: { outcome: 'approved', revision: 'carev_2', ownerDecision: 'approved' } });

    // The contract's wrong-implementation test: approval must not claim, connect, or mint any authorization.
    expect(h.claims).toEqual([]);
    expect(await h.outcome(requestHandle)).toBe('approved');
    expect(JSON.stringify([...h.backing.records.values()])).not.toContain('channel-access-grant-exchange');
    expect(await h.service.journal.inspect({ v: 1, operationId: 'request_1', operationKind: 'access' }, requester, context))
      .toEqual({ v: 1, operationId: 'request_1', outcome: 'approved' });

    const claimed = await h.service.fulfillment.claimAccess({
      v: 1, requestHandle: requestHandle as never, expectedRevision: 'carev_2', operationId: 'claim_1',
    });
    expect(claimed).toMatchObject({ kind: 'ok', value: { kind: 'access', channelRef: CHANNEL_REF, requestRevision: 'carev_3' } });
    expect(h.claims).toEqual(['access']);
    expect(await h.outcome(requestHandle)).toBe('connecting');
  });

  it('revokes an approved or claimed request for the owner\'s Stop, and leaves pending and finished ones alone', async () => {
    const pending = harness();
    const waiting = await pending.requestAccess();
    expect(await pending.service.revokeApproved(waiting, 'stop_1')).toBe('unchanged');
    expect(await pending.outcome(waiting)).toBe('pending_owner');

    const h = harness();
    const approved = await h.requestAccess();
    await h.service.decisions.decide(approve(approved), owner);
    expect(await h.service.revokeApproved(approved, 'stop_1')).toBe('revoked');
    expect(await h.outcome(approved)).toBe('revoked');
    expect(await h.service.journal.inspect({ v: 1, operationId: 'request_1', operationKind: 'access' }, requester, context))
      .toEqual({ v: 1, operationId: 'request_1', outcome: 'revoked' });
    // Revoked is terminal: the connector can no longer claim it, and a second Stop changes nothing.
    expect(await h.service.fulfillment.claimAccess({
      v: 1, requestHandle: approved as never, expectedRevision: 'carev_3', operationId: 'claim_late',
    })).toMatchObject({ kind: 'rejected' });
    expect(await h.service.revokeApproved(approved, 'stop_2')).toBe('unchanged');

    const c = harness();
    const claimed = await c.requestAccess();
    await c.service.decisions.decide(approve(claimed), owner);
    await c.service.fulfillment.claimAccess({ v: 1, requestHandle: claimed as never, expectedRevision: 'carev_2', operationId: 'claim_1' });
    expect(await c.outcome(claimed)).toBe('connecting');
    expect(await c.service.revokeApproved(claimed, 'stop_1')).toBe('revoked');
    expect(await c.outcome(claimed)).toBe('revoked');
  });

  it('revokes active work on status reads once the requester generation is revoked', async () => {
    const h = harness();
    const requestHandle = await h.requestAccess();
    h.state.requester = 'revoked';
    expect(await h.service.journal.inspect({ v: 1, operationId: 'request_1', operationKind: 'access' }, requester, context))
      .toEqual({ v: 1, operationId: 'request_1', outcome: 'revoked' });
    expect(await h.outcome(requestHandle)).toBe('revoked');
  });

  it('drops revoked rows from the owner inbox', async () => {
    const h = harness();
    const requestHandle = await h.requestAccess();
    h.state.requester = 'revoked';
    expect(await h.service.decisions.inbox(owner)).toEqual({ kind: 'ok', value: [] });
    expect(await h.outcome(requestHandle)).toBe('revoked');
  });

  it('collapses wrong-owner and cross-session reads without mutating the journal', async () => {
    const h = harness();
    const requestHandle = await h.requestAccess();
    expect(await h.service.decisions.decide(approve(requestHandle, 'wrong_owner'), otherOwner))
      .toEqual({ kind: 'rejected', code: 'forbidden' });
    expect(await h.outcome(requestHandle)).toBe('pending_owner');
    const result = await h.service.journal.inspect({ v: 1, operationId: 'request_1', operationKind: 'access' }, {
      ...requester, sessionGeneration: 4,
    }, { ...context, sessionGeneration: 4 });
    expect(result).toEqual({ v: 1, operationId: 'request_1', outcome: 'unavailable' });
  });
});

describe('channel-access decision revalidation', () => {
  it.each([
    ['the requester generation is revoked', (h: ReturnType<typeof harness>) => { h.state.requester = 'revoked'; }],
    ['the owner loses visibility of the channel', (h: ReturnType<typeof harness>) => { h.state.access = { kind: 'revoked' }; }],
    ['the channel changes ownership', (h: ReturnType<typeof harness>) => {
      h.state.access = { kind: 'current', ownerId: otherOwner.ownerId, targetRevision: TARGET_REVISION, title: 'Private channel' };
    }],
    ['the channel target revision moves', (h: ReturnType<typeof harness>) => {
      h.state.access = { kind: 'current', ownerId: owner.ownerId, targetRevision: 'target_revision_2', title: 'Private channel' };
    }],
  ] as const)('closes an access request and refuses the (former) owner when %s', async (_name, change) => {
    const h = harness();
    const requestHandle = await h.requestAccess();
    change(h);
    expect(await h.service.decisions.decide(approve(requestHandle), owner)).toEqual({ kind: 'rejected', code: 'revoked' });
    expect(await h.outcome(requestHandle)).toBe('revoked');
    expect(await h.service.fulfillment.claimAccess({
      v: 1, requestHandle: requestHandle as never, expectedRevision: 'carev_2', operationId: 'claim_after_revoke',
    })).toMatchObject({ kind: 'rejected' });
    expect(h.claims).toEqual([]);
  });

  it('closes a create request when the owner revision moves before the decision', async () => {
    const h = harness();
    const requestHandle = await h.requestCreate();
    h.state.create = { kind: 'current', ownerId: owner.ownerId, ownerRevision: 'owner_revision_2' };
    expect(await h.service.decisions.decide(approve(requestHandle), owner)).toEqual({ kind: 'rejected', code: 'revoked' });
    expect(await h.outcome(requestHandle)).toBe('revoked');
  });

  it('does not close the request when revalidation is unavailable', async () => {
    const h = harness();
    const requestHandle = await h.requestAccess();
    h.state.access = { kind: 'unavailable' };
    expect(await h.service.decisions.decide(approve(requestHandle), owner)).toEqual({ kind: 'unavailable', retryable: true });
    expect(await h.outcome(requestHandle)).toBe('pending_owner');
  });
});

describe('channel-access mutes', () => {
  function mute(requestHandle: string, overrides: Partial<{ expectedRevision: string | null; action: 'mute' | 'unmute'; operationId: string }> = {}) {
    return { v: 1 as const, requestHandle: requestHandle as never, expectedRevision: null, action: 'mute' as const, operationId: 'mute_1', ...overrides };
  }

  it('requires current channel ownership before muting an access requester', async () => {
    const h = harness();
    const requestHandle = await h.requestAccess();
    expect(await h.service.decisions.setMute(mute(requestHandle), owner))
      .toEqual({ kind: 'ok', value: { v: 1, operationKind: 'access', muted: true, revision: 'carev_1' } });
    expect(h.ownershipCalls).toEqual([[CHANNEL_REF, owner.ownerId]]);
    expect(h.mutes()).toEqual([expect.objectContaining({ enabled: true })]);

    h.advance(CHANNEL_ACCESS_COOLDOWN_MS);
    expect(await h.service.journal.requestAccess({
      v: 1, kind: 'listing_ref', operationId: 'request_muted', credentialRef: 'credential_1', listingRef: 'listing_1',
    }, requester, context)).toEqual({ v: 1, operationId: 'request_muted', outcome: 'unavailable' });
  });

  it.each([
    ['the resolver refuses the owner', (): ChannelAccessOwnershipResult => ({ kind: 'forbidden' })],
    ['the channel now belongs to another owner', (): ChannelAccessOwnershipResult => ({
      kind: 'owned', ownerId: otherOwner.ownerId, targetRevision: TARGET_REVISION,
    })],
    ['the ownership is for a stale target revision', (): ChannelAccessOwnershipResult => ({
      kind: 'owned', ownerId: owner.ownerId, targetRevision: 'target_revision_2',
    })],
  ] as const)('refuses an access mute when %s', async (_name, ownership) => {
    const h = harness();
    const requestHandle = await h.requestAccess();
    h.state.ownership = ownership;
    expect(await h.service.decisions.setMute(mute(requestHandle), owner)).toEqual({ kind: 'rejected', code: 'forbidden' });
    expect(h.ownershipCalls).toHaveLength(1);
    expect(h.mutes()).toEqual([]);
  });

  it('refuses a mute from an owner who does not own the request before consulting the resolver', async () => {
    const h = harness();
    const requestHandle = await h.requestAccess();
    expect(await h.service.decisions.setMute(mute(requestHandle), otherOwner)).toEqual({ kind: 'rejected', code: 'forbidden' });
    expect(h.ownershipCalls).toEqual([]);
    expect(h.mutes()).toEqual([]);
  });

  it('reconciles duplicate mute operations and rejects stale or reused revisions', async () => {
    const h = harness();
    const requestHandle = await h.requestAccess();
    const muted = await h.service.decisions.setMute(mute(requestHandle), owner);
    expect(muted).toEqual({ kind: 'ok', value: { v: 1, operationKind: 'access', muted: true, revision: 'carev_1' } });
    expect(await h.service.decisions.setMute(mute(requestHandle), owner)).toEqual(muted);
    expect(await h.service.decisions.setMute(mute(requestHandle, { action: 'unmute' }), owner))
      .toEqual({ kind: 'rejected', code: 'operation_mismatch' });
    expect(await h.service.decisions.setMute(mute(requestHandle, { operationId: 'mute_again' }), owner))
      .toEqual({ kind: 'rejected', code: 'stale_revision' });
    expect(await h.service.decisions.setMute(mute(requestHandle, {
      action: 'unmute', expectedRevision: 'carev_2', operationId: 'unmute_ahead',
    }), owner)).toEqual({ kind: 'rejected', code: 'stale_revision' });
    expect(await h.service.decisions.setMute(mute(requestHandle, {
      action: 'unmute', expectedRevision: 'not-a-revision', operationId: 'unmute_malformed',
    }), owner)).toEqual({ kind: 'rejected', code: 'stale_revision' });

    const unmuted = await h.service.decisions.setMute(mute(requestHandle, {
      action: 'unmute', expectedRevision: 'carev_1', operationId: 'unmute_1',
    }), owner);
    expect(unmuted).toEqual({ kind: 'ok', value: { v: 1, operationKind: 'access', muted: false, revision: 'carev_2' } });
    expect(await h.service.decisions.setMute(mute(requestHandle, {
      action: 'mute', expectedRevision: 'carev_1', operationId: 'mute_stale',
    }), owner)).toEqual({ kind: 'rejected', code: 'stale_revision' });
    expect(h.mutes()).toEqual([expect.objectContaining({ enabled: false })]);
  });
});
