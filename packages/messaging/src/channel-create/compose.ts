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
import type { ChannelAccessService } from '../channel-access/journal/service';
import type { ChannelAccessStore } from '../channel-access/journal/store';
import { createChannelCreateExchangeAuthority } from './authority';
import { withChannelCreateFulfillment } from './decisions';
import { type ChannelCreateWorkflow, createChannelCreateWorkflow } from './workflow';

export type ChannelCreateComposition = Readonly<{
  workflow: ChannelCreateWorkflow;
  /** Pass as `service.decisions` to the human decision route. */
  decisions: ChannelAccessDecisionPort;
  /** Wraps the access authority passed to `createGrantExchangeService`. */
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
