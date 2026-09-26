// Hosted composition for the human-confirmed creation workflow. The workflow
// itself is backend-neutral (`@khala/messaging/channel-create/compose`); hosted
// and internal compositions differ only in the adapter they inject.

import type { ChannelCreateAdapterPort, TrustedClock } from '@khala/contracts/messaging/index';
import { type ChannelCreateSubstrate, createSubstrateChannelCreateAdapter } from '@khala/messaging/channel-create/adapter';
import { channelKey } from '../../channel-discovery/catalog';

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
