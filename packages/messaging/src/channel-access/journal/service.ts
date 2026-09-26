import type {
  AccessRequestStatus,
  AuthPrincipal,
  AuthorizedChannelRef,
  CallOptions,
  ChannelAccessAuthorization as ContractAccessAuthorization,
  ChannelAccessDecisionPort,
  ChannelAccessFulfillmentClaim,
  ChannelAccessFulfillmentPort,
  ChannelAccessFulfillmentRejection,
  ChannelAccessFulfillmentUpdate,
  ChannelAccessNotification,
  ChannelAccessNotificationPort,
  ChannelAccessOwnerProjection as ContractOwnerProjection,
  ChannelAccessRequestJournalPort,
  ChannelAccessRequesterContext,
  ChannelAccessResolutionPort,
  ChannelCreateAuthorization as ContractCreateAuthorization,
  DiscoveryRequester,
  OperationResult,
  OwnerId,
  StableAgentPrincipal,
} from '@khala/contracts/messaging/index';
import type { ChannelAccessPolicy } from './policy';
import type {
  ChannelAccessCreateInput,
  ChannelAccessOwnerProjection,
  ChannelAccessStoredContext,
  ChannelAccessStore,
} from './store';

const ACCESS_CONSUMER = 'channel-access-grant-exchange';
const CREATE_CONSUMER = 'channel-create-workflow';

export type ChannelAccessService = Readonly<{
  journal: ChannelAccessRequestJournalPort;
  decisions: ChannelAccessDecisionPort;
  fulfillment: ChannelAccessFulfillmentPort;
  flushNotifications(ownerId: OwnerId, options?: CallOptions): Promise<void>;
  /**
   * Closes an approved request whose grant has not yet become an active binding, as the
   * owner's Stop does. A request that is already terminal, or still pending, is `unchanged`.
   */
  revokeApproved(requestHandle: string, operationId: string, options?: CallOptions): Promise<'revoked' | 'unchanged' | 'unavailable'>;
}>;

export function createChannelAccessService(deps: Readonly<{
  store: ChannelAccessStore;
  resolver: ChannelAccessResolutionPort;
  policy: ChannelAccessPolicy;
  notification?: ChannelAccessNotificationPort;
}>): ChannelAccessService {
  const unavailableStatus = (operationId: string): AccessRequestStatus => ({ v: 1, operationId, outcome: 'unavailable' });

  async function requestAccess(
    input: Parameters<ChannelAccessRequestJournalPort['requestAccess']>[0],
    requester: DiscoveryRequester,
    context: ChannelAccessRequesterContext,
    options?: CallOptions,
  ): Promise<AccessRequestStatus> {
    if (!matchesRequester(requester, context)) return unavailableStatus(input.operationId);
    const resolved = await safe(() => deps.resolver.resolveAccess(input, requester, options));
    if (!resolved || resolved.kind !== 'resolved') return unavailableStatus(input.operationId);
    const targetFingerprint = deps.policy.digest('binding', [
      ['channelRef', resolved.channelRef],
    ]);
    const created = await safe(() => deps.store.create({
      ...createCommon(input.operationId, context, resolved.ownerId, targetFingerprint),
      detail: {
        kind: 'access',
        authorizedChannelRef: resolved.channelRef,
        targetRevision: resolved.targetRevision,
        title: resolved.title,
      },
    }, options));
    if (!created || created.kind !== 'accepted') return unavailableStatus(input.operationId);
    await flushNotifications(resolved.ownerId, options);
    return { v: 1, operationId: input.operationId, outcome: created.outcome };
  }

  async function requestCreate(
    input: Parameters<ChannelAccessRequestJournalPort['requestCreate']>[0],
    requester: DiscoveryRequester,
    context: ChannelAccessRequesterContext,
    options?: CallOptions,
  ): Promise<AccessRequestStatus> {
    if (!matchesRequester(requester, context) || input.origin !== context.origin) return unavailableStatus(input.operationId);
    const resolved = await safe(() => deps.resolver.resolveCreate(input, requester, options));
    if (!resolved || resolved.kind !== 'resolved') return unavailableStatus(input.operationId);
    const proposalDigest = deps.policy.digest('binding', [
      ['ownerId', resolved.ownerId],
      ['ownerRevision', resolved.ownerRevision],
      ['proposedTitle', input.proposedTitle],
    ]);
    const created = await safe(() => deps.store.create({
      ...createCommon(input.operationId, context, resolved.ownerId, proposalDigest),
      detail: {
        kind: 'create',
        proposalDigest,
        proposedTitle: input.proposedTitle,
        ownerRevision: resolved.ownerRevision,
      },
    }, options));
    if (!created || created.kind !== 'accepted') return unavailableStatus(input.operationId);
    await flushNotifications(resolved.ownerId, options);
    return { v: 1, operationId: input.operationId, outcome: created.outcome };
  }

  async function inspect(
    input: Parameters<ChannelAccessRequestJournalPort['inspect']>[0],
    requester: DiscoveryRequester,
    context: ChannelAccessRequesterContext,
    options?: CallOptions,
  ): Promise<AccessRequestStatus> {
    if (!matchesRequester(requester, context)) return unavailableStatus(input.operationId);
    const result = await safe(() => deps.store.inspectRequester({
      requester: context.principal,
      sessionFingerprint: context.sessionFingerprint,
      sessionGeneration: context.sessionGeneration,
      origin: context.origin,
      kind: input.operationKind,
      operationId: input.operationId,
    }, options));
    if (!result || result.kind !== 'found') return unavailableStatus(input.operationId);
    if (terminalOutcome(result.status.outcome)) {
      return { v: 1, operationId: input.operationId, outcome: result.status.outcome };
    }
    const current = await revalidate(deps, result.context, options);
    if (current === 'unavailable') return unavailableStatus(input.operationId);
    if (current === 'revoked') {
      const revoked = await revokeConfirmed(deps.store, result.context, `status-${input.operationId}`, options);
      return revoked
        ? { v: 1, operationId: input.operationId, outcome: 'revoked' }
        : unavailableStatus(input.operationId);
    }
    return { v: 1, operationId: input.operationId, outcome: result.status.outcome };
  }

  async function inbox(owner: AuthPrincipal, options?: CallOptions): ReturnType<ChannelAccessDecisionPort['inbox']> {
    const listed = await safe(() => deps.store.listOwner({ ownerId: owner.ownerId }, options));
    if (!listed || listed.kind !== 'found') return unavailable();
    const requests: ContractOwnerProjection[] = [];
    for (const request of listed.requests) {
      const located = await safe(() => deps.store.readContext({ requestHandle: request.requestHandle }, options));
      if (!located || located.kind !== 'found') return unavailable();
      const current = await revalidate(deps, located.context, options);
      if (current === 'unavailable') return unavailable();
      if (current === 'revoked') {
        const revoked = await revokeConfirmed(
          deps.store, located.context, `inbox-${request.requestHandle}`, options,
        );
        if (!revoked) return unavailable();
        continue;
      }
      requests.push(projectOwner(request));
    }
    return ok(requests);
  }

  async function decide(
    input: Parameters<ChannelAccessDecisionPort['decide']>[0],
    owner: AuthPrincipal,
    options?: CallOptions,
  ): ReturnType<ChannelAccessDecisionPort['decide']> {
    const located = await ownerContext(deps.store, owner, input.requestHandle, options);
    if (located.kind !== 'ok') return located.result;
    const current = await revalidate(deps, located.context, options);
    if (current === 'unavailable') return unavailable();
    if (current === 'revoked') {
      return await revokeConfirmed(deps.store, located.context, `revalidate-${input.operationId}`, options)
        ? rejected('revoked')
        : unavailable();
    }
    const expectedRevision = parseRevision(input.expectedRevision);
    if (expectedRevision === null) return rejected('stale_revision');
    const result = await safe(() => deps.store.decide({
      ownerId: owner.ownerId,
      requestHandle: input.requestHandle,
      expectedRevision,
      decision: input.decision,
      operationId: input.operationId,
    }, options));
    if (!result || result.kind === 'unavailable') return unavailable();
    if (result.kind !== 'decided') return rejected(decisionCode(result.kind));
    const projection = await safe(() => deps.store.readOwner(
      { ownerId: owner.ownerId, requestHandle: input.requestHandle }, options,
    ));
    return projection?.kind === 'found' ? ok(projectOwner(projection.request)) : unavailable();
  }

  async function setMute(
    input: Parameters<ChannelAccessDecisionPort['setMute']>[0],
    owner: AuthPrincipal,
    options?: CallOptions,
  ): ReturnType<ChannelAccessDecisionPort['setMute']> {
    const located = await ownerContext(deps.store, owner, input.requestHandle, options);
    if (located.kind !== 'ok') return located.result;
    const detail = located.context.detail;
    if (detail.kind === 'access') {
      const ownership = await safe(() => deps.resolver.currentAccessOwner(
        detail.authorizedChannelRef as AuthorizedChannelRef,
        owner, options,
      ));
      if (!ownership || ownership.kind === 'unavailable') return unavailable();
      if (ownership.kind !== 'owned'
        || ownership.ownerId !== owner.ownerId
        || ownership.targetRevision !== detail.targetRevision) return rejected('forbidden');
    }
    const expectedRevision = input.expectedRevision === null ? null : parseRevision(input.expectedRevision);
    if (input.expectedRevision !== null && expectedRevision === null) return rejected('stale_revision');
    const result = await safe(() => deps.store.setMuteForRequest({
      ownerId: owner.ownerId,
      requestHandle: input.requestHandle,
      expectedRevision,
      action: input.action,
      operationId: input.operationId,
    }, options));
    if (!result || result.kind === 'unavailable') return unavailable();
    if (!('enabled' in result)) {
      return result.kind === 'stale' ? rejected('stale_revision') : rejected('operation_mismatch');
    }
    return ok({
      v: 1,
      operationKind: located.context.detail.kind,
      muted: result.enabled,
      revision: revision(result.revision),
    });
  }

  async function revokeApproved(requestHandle: string, operationId: string, options?: CallOptions) {
    const located = await safe(() => deps.store.readContext({ requestHandle }, options));
    if (!located || located.kind === 'unavailable') return 'unavailable' as const;
    if (located.kind !== 'found') return 'unchanged' as const;
    const { outcome } = located.context;
    if (outcome !== 'approved' && outcome !== 'connecting') return 'unchanged' as const;
    return await revokeConfirmed(deps.store, located.context, operationId, options) ? 'revoked' as const : 'unavailable' as const;
  }

  async function claimAccess(input: ChannelAccessFulfillmentClaim, options?: CallOptions) {
    return claim('access', input, options);
  }

  async function claimCreate(input: ChannelAccessFulfillmentClaim, options?: CallOptions) {
    return claim('create', input, options);
  }

  async function claim<K extends 'access' | 'create'>(
    kind: K,
    input: ChannelAccessFulfillmentClaim,
    options?: CallOptions,
  ): Promise<
    OperationResult<K extends 'access' ? ContractAccessAuthorization : ContractCreateAuthorization, ChannelAccessFulfillmentRejection>
  > {
    const located = await safe(() => deps.store.readContext({ requestHandle: input.requestHandle }, options));
    if (!located || located.kind === 'unavailable') return unavailable();
    if (located.kind !== 'found' || located.context.detail.kind !== kind) return rejected('wrong_kind');
    const current = await revalidate(deps, located.context, options);
    if (current === 'unavailable') return unavailable();
    if (current === 'revoked') {
      return await revokeConfirmed(deps.store, located.context, `revalidate-${input.operationId}`, options)
        ? rejected('revoked')
        : unavailable();
    }
    const expectedRevision = parseRevision(input.expectedRevision);
    if (expectedRevision === null) return rejected('stale_revision');
    const binding = bindingFrom(located.context);
    const consumerId = kind === 'access' ? ACCESS_CONSUMER : CREATE_CONSUMER;
    const claimInput = { binding, expectedRevision, consumerId, operationId: input.operationId };
    const result = kind === 'access'
      ? await safe(() => deps.store.claimAccess(claimInput, options))
      : await safe(() => deps.store.claimCreate(claimInput, options));
    if (!result || result.kind === 'unavailable') return unavailable();
    if (result.kind !== 'claimed') return rejected(claimCode(result.kind));
    const value = {
      ...result.authorization,
      authorizationRef: deps.policy.digest('binding', [
        ['requestHandle', result.authorization.requestHandle],
        ['consumerId', consumerId],
        ['claimOperationId', input.operationId],
      ]),
      requestRevision: revision(result.revision),
    };
    if (value.kind === 'access') {
      const { authorizedChannelRef, ...common } = value;
      const access = { ...common, channelRef: authorizedChannelRef };
      return ok(access as unknown as K extends 'access' ? ContractAccessAuthorization : ContractCreateAuthorization);
    }
    return ok(value as unknown as K extends 'access' ? ContractAccessAuthorization : ContractCreateAuthorization);
  }

  async function update(
    kind: 'access' | 'create',
    input: ChannelAccessFulfillmentUpdate,
    options?: CallOptions,
  ): Promise<OperationResult<AccessRequestStatus, ChannelAccessFulfillmentRejection>> {
    const located = await safe(() => deps.store.readContext({ requestHandle: input.requestHandle }, options));
    if (!located || located.kind === 'unavailable') return unavailable();
    if (located.kind !== 'found' || located.context.detail.kind !== kind) return rejected('wrong_kind');
    const expectedRevision = parseRevision(input.expectedRevision);
    if (expectedRevision === null) return rejected('stale_revision');
    const result = await safe(() => deps.store.updateLifecycle({
      requestHandle: input.requestHandle,
      expectedRevision,
      consumerId: kind === 'access' ? ACCESS_CONSUMER : CREATE_CONSUMER,
      outcome: input.outcome,
      operationId: input.operationId,
    }, options));
    if (!result || result.kind === 'unavailable') return unavailable();
    if (result.kind !== 'updated') return rejected(claimCode(result.kind));
    return ok({ v: 1, operationId: located.context.operationId, outcome: result.outcome });
  }

  async function flushNotifications(ownerId: OwnerId, options?: CallOptions): Promise<void> {
    if (!deps.notification) return;
    const listed = await safe(() => deps.store.listNotifications({ ownerId, limit: 10 }, options));
    if (!listed || listed.kind !== 'found') return;
    for (const item of listed.notifications) {
      const notification = {
        v: 1 as const,
        notificationId: item.id,
        revision: revision(item.revision),
        ownerId,
        kind: item.kind,
        requestHandle: item.kind === 'request' ? item.requestHandle : null,
        count: item.count,
      } as ChannelAccessNotification;
      const published = await safe(() => deps.notification!.publish(notification, options));
      if (published?.kind !== 'ok') break;
      await safe(() => deps.store.ackNotification({
        ownerId,
        notificationId: item.id,
        revision: item.revision,
        operationId: deps.policy.digest('notification', [
          ['notificationId', item.id],
          ['revision', item.revision],
        ]),
      }, options));
    }
  }

  return Object.freeze({
    journal: Object.freeze({ requestAccess, requestCreate, inspect }),
    decisions: Object.freeze({ inbox, decide, setMute }),
    fulfillment: Object.freeze({
      claimAccess,
      claimCreate,
      updateAccess: (input: ChannelAccessFulfillmentUpdate, options?: CallOptions) => update('access', input, options),
      updateCreate: (input: ChannelAccessFulfillmentUpdate, options?: CallOptions) => update('create', input, options),
    }),
    flushNotifications,
    revokeApproved,
  });
}

function createCommon(
  operationId: string,
  context: ChannelAccessRequesterContext,
  ownerId: OwnerId,
  targetFingerprint: string,
): Omit<ChannelAccessCreateInput, 'detail'> {
  return {
    requester: context.principal,
    sessionFingerprint: context.sessionFingerprint,
    sessionGeneration: context.sessionGeneration,
    origin: context.origin,
    operationId,
    ownerId,
    targetFingerprint,
    harness: context.harness,
    requesterLabel: context.displayLabel,
    workspaceLabel: context.workspaceLabel,
  };
}

function matchesRequester(requester: DiscoveryRequester, context: ChannelAccessRequesterContext): boolean {
  return requester.principal === context.principal
    && requester.origin === context.origin
    && requester.sessionGeneration === context.sessionGeneration;
}

function projectOwner(input: ChannelAccessOwnerProjection): ContractOwnerProjection {
  return {
    v: 1,
    requestHandle: input.requestHandle as ContractOwnerProjection['requestHandle'],
    operationKind: input.kind,
    outcome: input.outcome,
    revision: revision(input.revision),
    requester: {
      sessionFingerprint: input.sessionFingerprint,
      harness: input.harness,
      displayLabel: input.requesterLabel,
      workspaceLabel: input.workspaceLabel,
    },
    detail: input.kind === 'access'
      ? { kind: 'access', title: input.title!, history: 'none' }
      : { kind: 'create', proposedTitle: input.proposedTitle! },
    createdAt: input.createdAt,
    deadline: input.deadline,
    ownerDecision: input.ownerDecision,
    decidedAt: input.decidedAt,
    muted: input.muted,
    muteRevision: input.muteRevision === null ? null : revision(input.muteRevision),
  } as ContractOwnerProjection;
}

async function ownerContext(
  store: ChannelAccessStore,
  owner: AuthPrincipal,
  requestHandle: string,
  options?: CallOptions,
): Promise<
  | Readonly<{ kind: 'ok'; context: ChannelAccessStoredContext }>
  | Readonly<{ kind: 'error'; result: OperationResult<never, 'forbidden'> }>
> {
  const located = await safe(() => store.readContext({ requestHandle }, options));
  if (!located || located.kind === 'unavailable') return { kind: 'error', result: unavailable() };
  if (located.kind !== 'found' || located.context.ownerId !== owner.ownerId) {
    return { kind: 'error', result: rejected('forbidden') };
  }
  return { kind: 'ok', context: located.context };
}

async function revalidate(
  deps: Readonly<{ resolver: ChannelAccessResolutionPort }>,
  context: ChannelAccessStoredContext,
  options?: CallOptions,
): Promise<'current' | 'revoked' | 'unavailable'> {
  const requester = persistedRequester(context);
  const requesterState = await safe(() => deps.resolver.checkRequester(requester, options));
  if (!requesterState || requesterState.kind === 'unavailable') return 'unavailable';
  if (requesterState.kind === 'revoked') return 'revoked';
  const detail = context.detail;
  if (detail.kind === 'access') {
    const target = await safe(() => deps.resolver.revalidateAccess({
      ownerId: context.ownerId as OwnerId,
      channelRef: detail.authorizedChannelRef as AuthorizedChannelRef,
      targetRevision: detail.targetRevision,
      requester,
    }, options));
    if (!target || target.kind === 'unavailable') return 'unavailable';
    return target.kind === 'current'
      && target.ownerId === context.ownerId
      && target.targetRevision === detail.targetRevision ? 'current' : 'revoked';
  }
  const target = await safe(() => deps.resolver.revalidateCreate({
    ownerId: context.ownerId as OwnerId,
    ownerRevision: detail.ownerRevision,
    requester,
  }, options));
  if (!target || target.kind === 'unavailable') return 'unavailable';
  return target.kind === 'current'
    && target.ownerId === context.ownerId
    && target.ownerRevision === detail.ownerRevision ? 'current' : 'revoked';
}

function persistedRequester(context: ChannelAccessStoredContext): ChannelAccessRequesterContext {
  return {
    v: 1,
    principal: context.requester as StableAgentPrincipal,
    origin: context.origin,
    sessionGeneration: context.sessionGeneration,
    sessionFingerprint: context.sessionFingerprint,
    harness: context.harness,
    displayLabel: context.requesterLabel,
    workspaceLabel: context.workspaceLabel,
  };
}

function bindingFrom(context: ChannelAccessStoredContext): ChannelAccessCreateInput {
  return {
    requester: context.requester,
    sessionFingerprint: context.sessionFingerprint,
    sessionGeneration: context.sessionGeneration,
    origin: context.origin,
    operationId: context.operationId,
    ownerId: context.ownerId,
    targetFingerprint: context.targetFingerprint,
    detail: context.detail,
    harness: context.harness,
    requesterLabel: context.requesterLabel,
    workspaceLabel: context.workspaceLabel,
  };
}

async function revokeConfirmed(
  store: ChannelAccessStore,
  context: ChannelAccessStoredContext,
  operationId: string,
  options?: CallOptions,
): Promise<boolean> {
  let current = context;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = await safe(() => store.revoke({
      binding: bindingFrom(current),
      expectedRevision: current.revision,
      operationId,
    }, options));
    if (!result || result.kind === 'unavailable' || result.kind === 'not_found') return false;
    if (result.kind === 'updated') return true;
    const reread = await safe(() => store.readContext({ requestHandle: current.requestHandle }, options));
    if (!reread || reread.kind !== 'found') return false;
    if (terminalOutcome(reread.context.outcome)) return true;
    current = reread.context;
  }
  return false;
}

function terminalOutcome(outcome: AccessRequestStatus['outcome']): boolean {
  return outcome === 'connected' || outcome === 'repair_required' || outcome === 'denied'
    || outcome === 'expired' || outcome === 'revoked';
}

function revision(value: number): string {
  return `carev_${value}`;
}

function parseRevision(value: string): number | null {
  const match = /^carev_([1-9][0-9]*)$/.exec(value);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function decisionCode(kind: 'stale' | 'conflict' | 'expired' | 'not_found') {
  if (kind === 'stale') return 'stale_revision' as const;
  if (kind === 'conflict') return 'decision_conflict' as const;
  if (kind === 'expired') return 'expired' as const;
  return 'not_found' as const;
}

function claimCode(kind: 'stale' | 'conflict' | 'expired' | 'not_found') {
  if (kind === 'stale') return 'stale_revision' as const;
  if (kind === 'expired') return 'expired' as const;
  if (kind === 'not_found') return 'revoked' as const;
  return 'operation_mismatch' as const;
}

function ok<T>(value: T): OperationResult<T, never> {
  return { kind: 'ok', value };
}

function rejected<C extends string>(code: C): OperationResult<never, C> {
  return { kind: 'rejected', code };
}

function unavailable(): OperationResult<never, never> {
  return { kind: 'unavailable', retryable: true };
}

async function safe<T>(operation: () => Promise<T>): Promise<T | null> {
  try {
    return await operation();
  } catch {
    return null;
  }
}
