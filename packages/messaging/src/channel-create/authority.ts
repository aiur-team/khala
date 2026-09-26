// Create-aware approval authority for the connector grant exchange. The exchange
// is transport-neutral and access-shaped: it admits one requester into one
// channel. A create request has no channel until the workflow creates it, so for
// the requester's own `create` row this authority fulfils the workflow first
// (idempotently) and then authorizes admission into that one created channel,
// bound to the original requester, origin, session generation, and fingerprint.
// Every other operation goes to the access authority unchanged.

import type {
  CallOptions,
  ChannelAccessAuthorization,
  ChannelAccessFulfillmentPort,
  TrustedClock,
} from '@khala/contracts/messaging/index';
import type {
  ExchangeAuthorityInput,
  ExchangeAuthorityResult,
  GrantExchangeAuthority,
} from '../channel-access/exchange/authority';
import type { ChannelAccessStore } from '../channel-access/journal/store';
import type { ChannelCreateWorkflow } from './workflow';

export function createChannelCreateExchangeAuthority(deps: Readonly<{
  access: GrantExchangeAuthority;
  journal: Pick<ChannelAccessStore, 'inspectRequester' | 'readContext'>;
  fulfillment: Pick<ChannelAccessFulfillmentPort, 'updateCreate'>;
  workflow: ChannelCreateWorkflow;
  clock: TrustedClock;
}>): GrantExchangeAuthority {
  /** The requester's own create row for this operation, or `null` when the operation is not a creation. */
  async function locate(input: ExchangeAuthorityInput, options?: CallOptions) {
    const located = await safe(() => deps.journal.inspectRequester({
      requester: input.requester,
      sessionFingerprint: input.sessionFingerprint,
      sessionGeneration: input.sessionGeneration,
      origin: input.origin,
      kind: 'create',
      operationId: input.operationId,
    }, options));
    if (located === null || located.kind === 'unavailable') return 'unavailable' as const;
    return located.kind === 'found' ? located : null;
  }

  async function authorize(input: ExchangeAuthorityInput, options?: CallOptions): Promise<ExchangeAuthorityResult> {
    const located = await locate(input, options);
    if (located === 'unavailable') return { kind: 'unavailable' };
    if (located === null) return await deps.access.authorize(input, options);
    const { context, status } = located;
    if (deps.clock() >= Date.parse(context.deadline) || status.outcome === 'expired') {
      return { kind: 'closed', reason: 'expired' };
    }
    // Unapproved looks the same as unknown to the connector.
    if (status.outcome === 'pending_owner') return { kind: 'unavailable' };
    if (status.outcome !== 'approved' && status.outcome !== 'connecting') return { kind: 'closed', reason: 'closed' };
    const fulfilled = await safe(() => deps.workflow.fulfill(context.requestHandle, options));
    if (fulfilled === null || fulfilled.kind === 'unavailable') return { kind: 'unavailable' };
    if (fulfilled.kind === 'closed') return { kind: 'closed', reason: fulfilled.reason };
    const { authorization } = fulfilled;
    // The claim is bound to the journal row; the connector must be that row's requester session.
    if (authorization.requester !== input.requester
      || authorization.origin !== input.origin
      || authorization.sessionGeneration !== input.sessionGeneration
      || authorization.sessionFingerprint !== input.sessionFingerprint
      || authorization.operationId !== input.operationId) return { kind: 'closed', reason: 'closed' };
    const access = {
      v: 1 as const,
      kind: 'access' as const,
      authorizationRef: authorization.authorizationRef,
      requestHandle: authorization.requestHandle,
      requestRevision: authorization.requestRevision,
      operationId: authorization.operationId,
      ownerId: authorization.ownerId,
      requester: authorization.requester,
      origin: authorization.origin,
      sessionGeneration: authorization.sessionGeneration,
      sessionFingerprint: authorization.sessionFingerprint,
      deadline: authorization.deadline,
      channelRef: fulfilled.channelRef,
    };
    return { kind: 'authorized', authorization: access as unknown as ChannelAccessAuthorization };
  }

  async function close(
    input: Readonly<{ authorization: ChannelAccessAuthorization; operationId: string }>,
    options?: CallOptions,
  ): Promise<'closed' | 'unavailable'> {
    const located = await safe(() => deps.journal.readContext({ requestHandle: input.authorization.requestHandle }, options));
    if (located === null || located.kind === 'unavailable') return 'unavailable';
    if (located.kind !== 'found' || located.context.detail.kind !== 'create') return await deps.access.close(input, options);
    const updated = await safe(() => deps.fulfillment.updateCreate({
      v: 1,
      requestHandle: input.authorization.requestHandle,
      expectedRevision: input.authorization.requestRevision,
      operationId: input.operationId,
      outcome: 'revoked',
    }, options));
    return updated?.kind === 'ok' ? 'closed' : 'unavailable';
  }

  async function markConnected(
    input: ExchangeAuthorityInput & Readonly<{ readyOperationId: string }>,
    options?: CallOptions,
  ): Promise<'connected' | 'closed' | 'unavailable'> {
    const located = await locate(input, options);
    if (located === 'unavailable') return 'unavailable';
    if (located === null) return await deps.access.markConnected(input, options);
    // A lost acknowledgement response: the row is already connected.
    if (located.status.outcome === 'connected') return 'connected';
    const authorized = await authorize(input, options);
    if (authorized.kind === 'unavailable') return 'unavailable';
    if (authorized.kind === 'closed') return 'closed';
    const updated = await safe(() => deps.fulfillment.updateCreate({
      v: 1,
      requestHandle: authorized.authorization.requestHandle,
      expectedRevision: authorized.authorization.requestRevision,
      operationId: input.readyOperationId,
      outcome: 'connected',
    }, options));
    if (updated === null || updated.kind === 'unavailable' || updated.kind === 'outcome_unknown') return 'unavailable';
    if (updated.kind === 'ok') return updated.value.outcome === 'connected' ? 'connected' : 'closed';
    return updated.code === 'stale_revision' ? 'unavailable' : 'closed';
  }

  return Object.freeze({ authorize, close, markConnected });
}

async function safe<T>(operation: () => Promise<T>): Promise<T | null> {
  try {
    return await operation();
  } catch {
    return null;
  }
}
