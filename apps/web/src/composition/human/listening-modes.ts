// The owner-only listening-mode command, guarded like an agent rename.

import type { ListeningMode } from '@khala/contracts/m1/listening-mode';
import type { ParticipantView, RoomId } from '@khala/contracts/messaging/index';
import type { HumanApplicationPorts } from './application';

export type SetListeningMode = (participantId: string, mode: ListeningMode) => Promise<'sent' | 'failed'>;

/**
 * Sends `mode` to an agent only when the viewer is a joined human who owns it
 * and the agent's Matrix user id is known; otherwise `failed`, unsent.
 */
export function guardedListeningModeSetter(input: Readonly<{
  roomId: RoomId;
  viewer: ParticipantView;
  ownerOf(participantId: string): string | undefined;
  joined(): boolean;
  matrixUserId(participantId: string): string | undefined;
  send: NonNullable<HumanApplicationPorts['setListeningMode']>;
}>): SetListeningMode {
  return async (participantId, mode) => {
    const userId = input.matrixUserId(participantId);
    if (input.viewer.kind !== 'human' || input.ownerOf(participantId) !== input.viewer.ownerId
      || !input.joined() || !userId) return 'failed';
    return input.send(input.roomId, userId, mode, `txn_${crypto.randomUUID()}`);
  };
}
