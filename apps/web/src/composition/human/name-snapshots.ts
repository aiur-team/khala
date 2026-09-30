import type { EventId, MessageContent, OwnerId, RoomId } from '@khala/contracts/messaging/index';
import { projectNamesInOrder, type NameParticipant, type NameTimelineEvent } from '@khala/contracts/messaging/agent-names';

/** Called with authenticated participants and the owner's decrypted history only. */
export async function publishAgentNameSnapshots(input: Readonly<{
  roomId: RoomId;
  membershipEventId: string;
  ownerId: OwnerId;
  participants: readonly NameParticipant[];
  events: readonly NameTimelineEvent[];
  isCurrent: () => boolean;
  send: (value: { roomId: RoomId; clientTxnId: string; content: MessageContent }) => Promise<{ kind: string }>;
}>): Promise<void> {
  const names = projectNamesInOrder(input.participants, input.events);
  for (const participant of input.participants) {
    if (!input.isCurrent()) return;
    if (participant.kind !== 'agent' || participant.ownerId !== input.ownerId) continue;
    const name = names.currentNames.get(participant.participantId);
    if (!name) continue;
    const bytes = new TextEncoder().encode(JSON.stringify([input.roomId, input.membershipEventId, participant.participantId]));
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    if (!input.isCurrent()) return;
    const clientTxnId = `name_snapshot_${Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('')}`;
    const sent = await input.send({ roomId: input.roomId, clientTxnId,
      content: { v: 1, kind: 'agent_name_snapshot', agentParticipantId: participant.participantId,
        body: name, sourceEventId: (names.latestRename.get(participant.participantId) ?? null) as EventId | null } });
    if (sent.kind !== 'done') throw new Error('name_snapshot_not_durable');
  }
}
