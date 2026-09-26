// Composition root for the connector-only channel-access grant exchange: binds the
// transport-neutral exchange state machine to the journal-backed authority and
// grant issuer. Provider admission and connector authentication stay injected.

import type {
  ChannelAccessFulfillmentPort,
  ControlStore,
  TrustedClock,
} from '@khala/contracts/messaging/index';
import type { ChannelAdmissionProviderPort } from '@khala/messaging/channel-access/exchange/ports';
import { type GrantExchangeAuthority, createGrantExchangeAuthority } from '@khala/messaging/channel-access/exchange/authority';
import { createExchangeGrantIssuer } from '@khala/messaging/channel-access/exchange/grants';
import { createGrantExchangeService } from '@khala/messaging/channel-access/exchange/service';
import type { ChannelAccessStore } from '@khala/messaging/channel-access/journal/store';
import {
  type GrantExchangeHandlerDependencies,
  createGrantExchangeHandler,
  createGrantReadinessHandler,
} from '../../channel-access/exchange/handler';
import type { RouteRegistration } from '../../runtime/handler';

export function composeChannelAccessExchange(deps: Readonly<{
  store: ControlStore;
  journal: Pick<ChannelAccessStore, 'inspectRequester'>;
  fulfillment: Pick<ChannelAccessFulfillmentPort, 'claimAccess' | 'updateAccess'>;
  provider: ChannelAdmissionProviderPort;
  authenticateConnector: GrantExchangeHandlerDependencies['authenticateConnector'];
  clock: TrustedClock;
  /** Wraps the access authority; `composeChannelCreate` supplies one for created channels. */
  authority?: (access: GrantExchangeAuthority) => GrantExchangeAuthority;
}>): readonly RouteRegistration[] {
  const access = createGrantExchangeAuthority({ store: deps.journal, fulfillment: deps.fulfillment, clock: deps.clock });
  const service = createGrantExchangeService({
    store: deps.store,
    authority: deps.authority ? deps.authority(access) : access,
    provider: deps.provider,
    issuer: createExchangeGrantIssuer({ store: deps.store, clock: deps.clock }),
    clock: deps.clock,
  });
  const handlerDeps: GrantExchangeHandlerDependencies = {
    authenticateConnector: deps.authenticateConnector,
    exchangeFor: connector => service.forConnector(connector),
    clock: deps.clock,
  };
  return Object.freeze([createGrantExchangeHandler(handlerDeps), createGrantReadinessHandler(handlerDeps)]);
}
