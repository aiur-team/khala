import type { LocalMember } from '@khala/contracts/m1/local';
import type { Participant } from '@khala/contracts/m1/participants';
import type { Disposer, RoomId } from '@khala/contracts/messaging/index';

export interface LocalMembersCache {
  members(roomId: RoomId): readonly LocalMember[] | undefined;
  describe(participantId: string): Participant | undefined;
  subscribe(roomId: RoomId, listener: () => void): Disposer;
  refresh(roomId: RoomId): Promise<void>;
}
