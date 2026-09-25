import { describe, expect, expectTypeOf, it } from 'vitest';
import type { AuthPrincipal } from './identity';
import type { OwnerId } from './ids';
import type {
  AuthorizedChannelRef,
  ChannelAccessRequest,
  ChannelCreateIntent,
  DiscoveryRequester,
} from './discovery';
import {
  MAX_CHANNEL_ACCESS_LABEL_BYTES,
  MAX_CHANNEL_ACCESS_OWNER_PENDING,
  type ChannelAccessAuthorization,
  type ChannelAccessDecisionPort,
  type ChannelAccessFulfillmentPort,
  type ChannelAccessOwnerProjection,
  type ChannelAccessResolutionPort,
  type ChannelAccessRequesterContext,
  type ChannelCreateAuthorization,
  decodeChannelAccessDecisionCommand,
  decodeChannelAccessFulfillmentClaim,
  decodeChannelAccessFulfillmentUpdate,
  decodeChannelAccessMuteCommand,
  decodeChannelAccessNotification,
  decodeChannelAccessOwnerProjection,
  decodeChannelAccessRequesterContext,
  decodeChannelAccessStatusQuery,
} from './channel-access';

const DIGEST = 'a'.repeat(43);
const HANDLE = `careq_${DIGEST}`;
const CREATED_AT = '2026-09-24T12:00:00Z';
const DEADLINE = '2026-10-01T12:00:00Z';
const DECIDED_AT = '2026-09-24T12:05:00Z';

const requester: ChannelAccessRequesterContext = {
  v: 1,
  principal: 'stable_agent_1' as ChannelAccessRequesterContext['principal'],
  origin: 'https://khala.example',
  sessionGeneration: 3,
  sessionFingerprint: DIGEST,
  harness: 'codex',
  displayLabel: 'Release helper',
  workspaceLabel: 'Payments',
};

const requesterProjection = {
  sessionFingerprint: DIGEST,
  harness: 'codex',
  displayLabel: 'Release helper',
  workspaceLabel: 'Payments',
} as const;

const accessProjection = {
  v: 1,
  requestHandle: HANDLE,
  operationKind: 'access',
  outcome: 'pending_owner',
  revision: 'request_revision_1',
  requester: requesterProjection,
  detail: { kind: 'access', title: 'Release planning', history: 'none' },
  createdAt: CREATED_AT,
  deadline: DEADLINE,
  ownerDecision: 'pending',
  decidedAt: null,
  muted: false,
  muteRevision: null,
} as const;

const createProjection = {
  ...accessProjection,
  operationKind: 'create',
  detail: { kind: 'create', proposedTitle: 'Incident response' },
} as const;

describe('channel-access requester and owner projections', () => {
  it('strictly decodes bounded requester identity context', () => {
    expect(decodeChannelAccessRequesterContext(requester)).toEqual({ ok: true, value: requester });
    expect(decodeChannelAccessRequesterContext({ ...requester, origin: 'http://khala.example' }))
      .toEqual({ ok: false, error: { path: 'origin', code: 'invalid_value' } });
    expect(decodeChannelAccessRequesterContext({ ...requester, displayLabel: 'x'.repeat(MAX_CHANNEL_ACCESS_LABEL_BYTES + 1) }))
      .toEqual({ ok: false, error: { path: 'displayLabel', code: 'too_long' } });
    expect(decodeChannelAccessRequesterContext({ ...requester, workspaceLabel: 'spoof\u202e' }))
      .toEqual({ ok: false, error: { path: 'workspaceLabel', code: 'control_character' } });
    expect(decodeChannelAccessRequesterContext({ ...requester, sessionId: 'must-not-persist' }))
      .toEqual({ ok: false, error: { path: 'sessionId', code: 'unknown_field' } });
  });

  it('round-trips access and create owner-safe projections', () => {
    expect(decodeChannelAccessOwnerProjection(accessProjection))
      .toEqual({ ok: true, value: accessProjection });
    expect(decodeChannelAccessOwnerProjection(createProjection))
      .toEqual({ ok: true, value: createProjection });
  });

  it.each([
    ['ownerId', 'owner_secret'],
    ['operationId', 'operation_secret'],
    ['origin', 'https://hidden.example'],
    ['channelRef', 'channel_secret'],
    ['listingRef', 'listing_secret'],
    ['grant', 'grant_secret'],
    ['providerRoomId', '!secret:matrix.example'],
  ])('rejects secret-bearing owner projection field %s', (field, value) => {
    expect(decodeChannelAccessOwnerProjection({ ...accessProjection, [field]: value }))
      .toEqual({ ok: false, error: { path: field, code: 'unknown_field' } });
  });

  it('rejects malformed times and impossible lifecycle combinations', () => {
    expect(decodeChannelAccessOwnerProjection({ ...accessProjection, v: 2 }))
      .toEqual({ ok: false, error: { path: 'v', code: 'unsupported_version' } });
    expect(decodeChannelAccessOwnerProjection({ ...accessProjection, deadline: CREATED_AT }))
      .toEqual({ ok: false, error: { path: 'deadline', code: 'invalid_value' } });
    expect(decodeChannelAccessOwnerProjection({
      ...accessProjection,
      outcome: 'approved',
      ownerDecision: 'pending',
    })).toEqual({ ok: false, error: { path: 'ownerDecision', code: 'mismatch' } });
    expect(decodeChannelAccessOwnerProjection({
      ...accessProjection,
      outcome: 'approved',
      ownerDecision: 'approved',
      decidedAt: DEADLINE,
    })).toEqual({ ok: false, error: { path: 'decidedAt', code: 'invalid_value' } });
    expect(decodeChannelAccessOwnerProjection({
      ...accessProjection,
      operationKind: 'access',
      detail: createProjection.detail,
    })).toEqual({ ok: false, error: { path: 'detail.proposedTitle', code: 'unknown_field' } });
    expect(decodeChannelAccessOwnerProjection({ ...accessProjection, muted: true, muteRevision: null }))
      .toEqual({ ok: false, error: { path: 'muteRevision', code: 'mismatch' } });
  });

  it('accepts approved and terminal owner-decision combinations without exposing authority', () => {
    for (const outcome of ['approved', 'connecting', 'connected', 'repair_required'] as const) {
      const projection = { ...accessProjection, outcome, ownerDecision: 'approved', decidedAt: DECIDED_AT } as const;
      expect(decodeChannelAccessOwnerProjection(projection)).toEqual({ ok: true, value: projection });
    }
    for (const outcome of ['expired', 'revoked'] as const) {
      expect(decodeChannelAccessOwnerProjection({ ...accessProjection, outcome }).ok).toBe(true);
      expect(decodeChannelAccessOwnerProjection({
        ...accessProjection, outcome, ownerDecision: 'approved', decidedAt: DECIDED_AT,
      }).ok).toBe(true);
    }
  });
});

describe('channel-access commands and notification projection', () => {
  it('strictly decodes status, decision, mute, claim, and lifecycle commands', () => {
    const status = { v: 1, operationId: 'request_operation_1', operationKind: 'access' } as const;
    const decision = {
      v: 1, requestHandle: HANDLE, expectedRevision: 'request_revision_1', decision: 'approve', operationId: 'decision_1',
    } as const;
    const mute = {
      v: 1, requestHandle: HANDLE, expectedRevision: null, action: 'mute', operationId: 'mute_1',
    } as const;
    const claim = {
      v: 1, requestHandle: HANDLE, expectedRevision: 'request_revision_2', operationId: 'fulfill_1',
    } as const;
    const update = {
      v: 1, requestHandle: HANDLE, expectedRevision: 'request_revision_3', operationId: 'fulfill_1', outcome: 'connected',
    } as const;
    expect(decodeChannelAccessStatusQuery(status)).toEqual({ ok: true, value: status });
    expect(decodeChannelAccessDecisionCommand(decision)).toEqual({ ok: true, value: decision });
    expect(decodeChannelAccessMuteCommand(mute)).toEqual({ ok: true, value: mute });
    expect(decodeChannelAccessFulfillmentClaim(claim)).toEqual({ ok: true, value: claim });
    expect(decodeChannelAccessFulfillmentUpdate(update)).toEqual({ ok: true, value: update });
  });

  it('rejects caller-supplied authority and invalid lifecycle updates', () => {
    const decision = {
      v: 1, requestHandle: HANDLE, expectedRevision: 'request_revision_1', decision: 'approve', operationId: 'decision_1',
    } as const;
    expect(decodeChannelAccessDecisionCommand({ ...decision, ownerId: 'owner_forged' }))
      .toEqual({ ok: false, error: { path: 'ownerId', code: 'unknown_field' } });
    expect(decodeChannelAccessMuteCommand({
      v: 1, requestHandle: HANDLE, expectedRevision: null, action: 'mute', operationId: 'mute_1', channelRef: 'secret',
    })).toEqual({ ok: false, error: { path: 'channelRef', code: 'unknown_field' } });
    expect(decodeChannelAccessFulfillmentUpdate({
      v: 1, requestHandle: HANDLE, expectedRevision: 'r1', operationId: 'fulfill_1', outcome: 'approved',
    })).toEqual({ ok: false, error: { path: 'outcome', code: 'invalid_value' } });
  });

  it('keeps notification payloads minimal and revisioned', () => {
    const individual = {
      v: 1,
      notificationId: 'notification_1',
      revision: 'notification_revision_1',
      ownerId: 'owner_alice',
      kind: 'request',
      requestHandle: HANDLE,
      count: 1,
    } as const;
    const batch = {
      ...individual,
      notificationId: 'notification_batch_1',
      revision: 'notification_revision_4',
      kind: 'batch',
      requestHandle: null,
      count: MAX_CHANNEL_ACCESS_OWNER_PENDING,
    } as const;
    expect(decodeChannelAccessNotification(individual)).toEqual({ ok: true, value: individual });
    expect(decodeChannelAccessNotification(batch)).toEqual({ ok: true, value: batch });
    expect(decodeChannelAccessNotification({ ...individual, count: 2 }))
      .toEqual({ ok: false, error: { path: 'count', code: 'mismatch' } });
    expect(decodeChannelAccessNotification({ ...batch, requestHandle: HANDLE }))
      .toEqual({ ok: false, error: { path: 'requestHandle', code: 'mismatch' } });
    expect(decodeChannelAccessNotification({ ...individual, title: 'secret title' }))
      .toEqual({ ok: false, error: { path: 'title', code: 'unknown_field' } });
  });
});

describe('channel-access authority boundaries', () => {
  it('keeps resolution side-effect-free and off the agent-facing request type', () => {
    expectTypeOf<Parameters<ChannelAccessResolutionPort['resolveAccess']>[0]>()
      .toEqualTypeOf<ChannelAccessRequest>();
    expectTypeOf<Parameters<ChannelAccessResolutionPort['resolveCreate']>[0]>()
      .toEqualTypeOf<ChannelCreateIntent>();
    expectTypeOf<Parameters<ChannelAccessResolutionPort['resolveAccess']>[1]>()
      .toEqualTypeOf<DiscoveryRequester>();

    type ResolverMethods = keyof ChannelAccessResolutionPort;
    const methods: readonly ResolverMethods[] = [
      'resolveAccess', 'resolveCreate', 'revalidateAccess', 'revalidateCreate', 'currentAccessOwner', 'checkRequester',
    ];
    expect(methods).not.toContain('create');
    expect(methods).not.toContain('admit');
    expect(methods).not.toContain('grant');
  });

  it('requires an authenticated human principal for decisions and mutes', () => {
    expectTypeOf<Parameters<ChannelAccessDecisionPort['decide']>[1]>().toEqualTypeOf<AuthPrincipal>();
    expectTypeOf<Parameters<ChannelAccessDecisionPort['setMute']>[1]>().toEqualTypeOf<AuthPrincipal>();

    type DecisionMethods = keyof ChannelAccessDecisionPort;
    const methods: readonly DecisionMethods[] = ['inbox', 'decide', 'setMute'];
    expect(methods).not.toContain('grant');
    expect(methods).not.toContain('provider');
    expect(methods).not.toContain('admit');
    expect(methods).not.toContain('createChannel');
  });

  it('separates access and creation fulfillment authorization at the type level', () => {
    type AccessResult = Awaited<ReturnType<ChannelAccessFulfillmentPort['claimAccess']>>;
    type CreateResult = Awaited<ReturnType<ChannelAccessFulfillmentPort['claimCreate']>>;
    type AccessValue = Extract<AccessResult, { kind: 'ok' }>['value'];
    type CreateValue = Extract<CreateResult, { kind: 'ok' }>['value'];
    expectTypeOf<AccessValue>().toEqualTypeOf<ChannelAccessAuthorization>();
    expectTypeOf<CreateValue>().toEqualTypeOf<ChannelCreateAuthorization>();

    const compileOnly = (
      accessConsumer: (authorization: ChannelAccessAuthorization) => void,
      createConsumer: (authorization: ChannelCreateAuthorization) => void,
      access: ChannelAccessAuthorization,
      create: ChannelCreateAuthorization,
      raw: ChannelAccessRequest,
    ) => {
      accessConsumer(access);
      createConsumer(create);
      // @ts-expect-error creation authorization cannot enter the access consumer
      accessConsumer(create);
      // @ts-expect-error access authorization cannot enter the creation consumer
      createConsumer(access);
      // @ts-expect-error a raw agent request is never fulfillment authority
      accessConsumer(raw);
    };
    expect(compileOnly).toBeTypeOf('function');
  });

  it('keeps hidden access targets only in the access authorization', () => {
    expectTypeOf<ChannelAccessAuthorization['channelRef']>().toEqualTypeOf<AuthorizedChannelRef>();
    expectTypeOf<ChannelAccessAuthorization['ownerId']>().toEqualTypeOf<OwnerId>();
    type CreateKeys = keyof ChannelCreateAuthorization;
    const keys: readonly CreateKeys[] = [
      'v', 'kind', 'authorizationRef', 'requestHandle', 'requestRevision', 'operationId', 'ownerId', 'requester',
      'origin', 'sessionGeneration', 'sessionFingerprint', 'proposalDigest', 'proposedTitle', 'deadline',
    ];
    expect(keys).not.toContain('channelRef');
  });
});
