// Composition root for the connector-only channel-access grant exchange: binds the
// transport-neutral exchange state machine to the hosted journal authority and
// grant issuer. Provider admission and connector authentication stay injected.

import type {
  ChannelAccessFulfillmentPort,
  ControlStore,
  TrustedClock,
} from '@khala/contracts/messaging/index';
import type { ChannelAdmissionProviderPort } from '@khala/messaging/channel-access/exchange/ports';
import { createGrantExchangeService } from '@khala/messaging/channel-access/exchange/service';
import { createGrantExchangeAuthority } from '../../channel-access/exchange/authority';
import { createExchangeGrantIssuer } from '../../channel-access/exchange/grants';
import { type GrantExchangeHandlerDependencies, createGrantExchangeHandler } from '../../channel-access/exchange/handler';
import type { ChannelAccessStore } from '../../channel-access/store';
import type { RouteRegistration } from '../../runtime/handler';

export function composeChannelAccessExchange(deps: Readonly<{
  store: ControlStore;
  journal: Pick<ChannelAccessStore, 'inspectRequester'>;
  fulfillment: Pick<ChannelAccessFulfillmentPort, 'claimAccess' | 'updateAccess'>;
  provider: ChannelAdmissionProviderPort;
  authenticateConnector: GrantExchangeHandlerDependencies['authenticateConnector'];
  clock: TrustedClock;
}>): readonly RouteRegistration[] {
  const service = createGrantExchangeService({
    store: deps.store,
    authority: createGrantExchangeAuthority({ store: deps.journal, fulfillment: deps.fulfillment, clock: deps.clock }),
    provider: deps.provider,
    issuer: createExchangeGrantIssuer({ store: deps.store, clock: deps.clock }),
    clock: deps.clock,
  });
  return Object.freeze([createGrantExchangeHandler({
    authenticateConnector: deps.authenticateConnector,
    exchangeFor: connector => service.forConnector(connector),
    clock: deps.clock,
  })]);
}
