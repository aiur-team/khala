// Composition root for the connector-only channel-access grant exchange: binds the
// transport-neutral exchange state machine to the journal-backed authority and
// grant issuer. Provider admission and connector authentication stay injected.

import type {
  ChannelAccessFulfillmentPort,
  ControlStore,
  TrustedClock,
} from '@khala/contracts/messaging/index';
import { exchangeJournal } from '@khala/messaging/channel-access/exchange/journal';
import type { ChannelAdmissionProviderPort } from '@khala/messaging/channel-access/exchange/ports';
import { createGrantExchangeAuthority } from '@khala/messaging/channel-access/exchange/authority';
import { createExchangeGrantIssuer } from '@khala/messaging/channel-access/exchange/grants';
import { createGrantExchangeService } from '@khala/messaging/channel-access/exchange/service';
import type { ChannelAccessStore } from '@khala/messaging/channel-access/journal/store';
import type { AdapterCapabilities } from '../../agent-bootstrap/handler';
import {
  type GrantExchangeHandlerDependencies,
  createChannelAccessResumeHandler,
  createGrantExchangeHandler,
  createGrantReadinessHandler,
} from '../../channel-access/exchange/handler';
import { createChannelAccessResumeService } from '../../channel-access/exchange/resume';
import type { RouteRegistration } from '../../runtime/handler';

export function composeChannelAccessExchange(deps: Readonly<{
  store: ControlStore;
  journal: Pick<ChannelAccessStore, 'inspectRequester'>;
  fulfillment: Pick<ChannelAccessFulfillmentPort, 'claimAccess' | 'updateAccess'>;
  provider: ChannelAdmissionProviderPort;
  /** The admitted bindings, from the agent-bootstrap capabilities; resume never creates one. */
  bindings: Pick<AdapterCapabilities, 'resumeAdapterCapability'>;
  authenticateConnector: GrantExchangeHandlerDependencies['authenticateConnector'];
  clock: TrustedClock;
}>): readonly RouteRegistration[] {
  const authority = createGrantExchangeAuthority({ store: deps.journal, fulfillment: deps.fulfillment, clock: deps.clock });
  const issuer = createExchangeGrantIssuer({ store: deps.store, clock: deps.clock });
  const service = createGrantExchangeService({
    store: deps.store,
    authority,
    provider: deps.provider,
    issuer,
    clock: deps.clock,
  });
  const resume = createChannelAccessResumeService({
    journal: exchangeJournal(deps.store),
    authority,
    issuer,
    bindings: deps.bindings,
    clock: deps.clock,
  });
  const handlerDeps: GrantExchangeHandlerDependencies = {
    authenticateConnector: deps.authenticateConnector,
    exchangeFor: connector => service.forConnector(connector),
    clock: deps.clock,
  };
  return Object.freeze([
    createGrantExchangeHandler(handlerDeps),
    createGrantReadinessHandler(handlerDeps),
    createChannelAccessResumeHandler({
      authenticateConnector: deps.authenticateConnector,
      resumeFor: connector => resume.forConnector(connector),
    }),
  ]);
}
