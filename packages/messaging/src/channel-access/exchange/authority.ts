// Journal-backed approval authority for the grant exchange. It locates the requester's own
// journal row and claims it through the journal's typed access fulfillment port,
// which revalidates owner, visibility/existence, and requester revocation on every
// call. The claim operation is stable per exchange, so each recheck is idempotent.

import type {
  CallOptions,
  ChannelAccessAuthorization,
  ChannelAccessFulfillmentPort,
  StableAgentPrincipal,
  TrustedClock,
} from '@khala/contracts/messaging/index';
import type { ChannelAccessStore } from '../journal/store';

export type ExchangeAuthorityInput = Readonly<{
  operationId: string;
  requester: StableAgentPrincipal;
  origin: string;
  sessionGeneration: number;
  sessionFingerprint: string;
  claimOperationId: string;
}>;

export type ExchangeAuthorityResult =
  | Readonly<{ kind: 'authorized'; authorization: ChannelAccessAuthorization }>
  | Readonly<{ kind: 'closed'; reason: 'expired' | 'closed' }>
  | Readonly<{ kind: 'unavailable' }>;

export type GrantExchangeAuthority = Readonly<{
  authorize(input: ExchangeAuthorityInput, options?: CallOptions): Promise<ExchangeAuthorityResult>;
  close(
    input: Readonly<{ authorization: ChannelAccessAuthorization; operationId: string }>,
    options?: CallOptions,
  ): Promise<'closed' | 'unavailable'>;
  markConnected(
    input: ExchangeAuthorityInput & Readonly<{ readyOperationId: string }>,
    options?: CallOptions,
  ): Promise<'connected' | 'closed' | 'unavailable'>;
}>;

export function createGrantExchangeAuthority(deps: Readonly<{
  store: Pick<ChannelAccessStore, 'inspectRequester'>;
  fulfillment: Pick<ChannelAccessFulfillmentPort, 'claimAccess' | 'updateAccess'>;
  clock: TrustedClock;
}>): GrantExchangeAuthority {
  async function authorize(input: ExchangeAuthorityInput, options?: CallOptions): Promise<ExchangeAuthorityResult> {
    const located = await safe(() => deps.store.inspectRequester({
      requester: input.requester,
      sessionFingerprint: input.sessionFingerprint,
      sessionGeneration: input.sessionGeneration,
      origin: input.origin,
      kind: 'access',
      operationId: input.operationId,
    }, options));
    // Unknown, foreign, and not-yet-decided requests look the same to the connector.
    if (located === null || located.kind !== 'found') return { kind: 'unavailable' };
    const { context, status } = located;
    if (deps.clock() >= Date.parse(context.deadline) || status.outcome === 'expired') {
      return { kind: 'closed', reason: 'expired' };
    }
    if (status.outcome === 'pending_owner') return { kind: 'unavailable' };
    if (status.outcome !== 'approved' && status.outcome !== 'connecting') return { kind: 'closed', reason: 'closed' };
    const claimed = await safe(() => deps.fulfillment.claimAccess({
      v: 1,
      requestHandle: context.requestHandle as ChannelAccessAuthorization['requestHandle'],
      expectedRevision: `carev_${context.revision}`,
      operationId: input.claimOperationId,
    }, options));
    if (claimed === null || claimed.kind === 'unavailable' || claimed.kind === 'outcome_unknown') return { kind: 'unavailable' };
    if (claimed.kind === 'ok') return { kind: 'authorized', authorization: claimed.value };
    if (claimed.code === 'expired') return { kind: 'closed', reason: 'expired' };
    // A concurrent journal write moved the row; the caller retries with a fresh read.
    if (claimed.code === 'stale_revision') return { kind: 'unavailable' };
    return { kind: 'closed', reason: 'closed' };
  }

  async function close(
    input: Readonly<{ authorization: ChannelAccessAuthorization; operationId: string }>,
    options?: CallOptions,
  ): Promise<'closed' | 'unavailable'> {
    const updated = await safe(() => deps.fulfillment.updateAccess({
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
    const located = await safe(() => deps.store.inspectRequester({
      requester: input.requester,
      sessionFingerprint: input.sessionFingerprint,
      sessionGeneration: input.sessionGeneration,
      origin: input.origin,
      kind: 'access',
      operationId: input.operationId,
    }, options));
    if (located === null || located.kind !== 'found') return 'unavailable';
    // A lost acknowledgement response: the row is already connected.
    if (located.status.outcome === 'connected') return 'connected';
    const authorized = await authorize(input, options);
    if (authorized.kind === 'unavailable') return 'unavailable';
    if (authorized.kind === 'closed') return 'closed';
    const updated = await safe(() => deps.fulfillment.updateAccess({
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
