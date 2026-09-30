import type { HumanChannelLinkResult, PersonalChannelLinkResult, RoomId } from '@khala/contracts/messaging/index';

/** The signed-in browser's channel-link endpoints. Results never grant admission. */
export interface HumanChannelLinks {
  resolve(channelUrl: string, signal?: AbortSignal): Promise<HumanChannelLinkResult>;
  personal(roomId: RoomId, signal?: AbortSignal): Promise<PersonalChannelLinkResult>;
}
