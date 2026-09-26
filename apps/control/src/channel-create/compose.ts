// Composition for the human-confirmed creation workflow. It reuses the shared
// channel-access journal (one request store, one inbox) and adds only the
// creation consumer: the decorated owner decision port, and the exchange
// authority that admits the requesting session into the channel it created.
// Hosted and internal compositions differ only in the adapter they inject.

import type {
  ChannelAccessDecisionPort,
  ChannelCreateAdapterPort,
  ControlStore,
  TrustedClock,
} from '@khala/contracts/messaging/index';
import type { GrantExchangeAuthority } from '../channel-access/exchange/authority';
import type { ChannelAccessService } from '../channel-access/service';
import type { ChannelAccessStore } from '../channel-access/store';
import { channelKey } from '../channel-discovery/catalog';
import { type ChannelCreateSubstrate, createSubstrateChannelCreateAdapter } from './adapter';
import { createChannelCreateExchangeAuthority } from './authority';
import { withChannelCreateFulfillment } from './decisions';
import { type ChannelCreateWorkflow, createChannelCreateWorkflow } from './workflow';

export type ChannelCreateComposition = Readonly<{
  workflow: ChannelCreateWorkflow;
  /** Pass as `service.decisions` to `createChannelAccessHandlers`. */
  decisions: ChannelAccessDecisionPort;
  /** Pass as `authority` to `composeChannelAccessExchange`. */
  exchangeAuthority(access: GrantExchangeAuthority): GrantExchangeAuthority;
}>;

export function composeChannelCreate(deps: Readonly<{
  store: ControlStore;
  journal: Pick<ChannelAccessStore, 'readContext' | 'inspectRequester'>;
  service: Pick<ChannelAccessService, 'decisions' | 'fulfillment'>;
  adapter: ChannelCreateAdapterPort;
  clock: TrustedClock;
}>): ChannelCreateComposition {
  const workflow = createChannelCreateWorkflow({
    store: deps.store,
    journal: deps.journal,
    fulfillment: deps.service.fulfillment,
    adapter: deps.adapter,
    clock: deps.clock,
  });
  return Object.freeze({
    workflow,
    decisions: withChannelCreateFulfillment({ decisions: deps.service.decisions, workflow }),
    exchangeAuthority: (access: GrantExchangeAuthority) => createChannelCreateExchangeAuthority({
      access,
      journal: deps.journal,
      fulfillment: deps.service.fulfillment,
      workflow,
      clock: deps.clock,
    }),
  });
}

/**
 * Hosted adapter: the owner's substrate creates the room, and the channel is
 * referenced the way hosted discovery references it. No catalog record is
 * written, so the channel is `secret` until its owner changes that.
 */
export function hostedChannelCreateAdapter(deps: Readonly<{
  substrate: ChannelCreateSubstrate;
  clock: TrustedClock;
}>): ChannelCreateAdapterPort {
  return createSubstrateChannelCreateAdapter({ substrate: deps.substrate, channelRef: channelKey, clock: deps.clock });
}
