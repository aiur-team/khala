import type { ParticipantView, TimelineItem } from '@khala/contracts/messaging/index';
import { projectNamesInOrder, type NameParticipant } from '@khala/contracts/messaging/agent-names';

/** Shared name replay for the real thread and its participant panel. */
export function projectTimelineNames(items: readonly TimelineItem[], viewer: ParticipantView,
  additional: readonly NameParticipant[] = []) {
  const participants = new Map<string, NameParticipant>();
  for (const participant of additional) participants.set(participant.participantId, participant);
  for (const participant of [...items.map(item => item.participant), viewer]) {
    if (!participants.has(participant.participantId)) participants.set(participant.participantId, {
      participantId: participant.participantId, ownerId: participant.ownerId,
      kind: participant.kind, initialName: participant.displayName,
    });
  }
  return projectNamesInOrder([...participants.values()], items.map(item => item.content.kind === 'agent_rename'
    ? { kind: 'agent_rename' as const, eventId: item.ref.eventId, actorParticipantId: item.participant.participantId,
        targetParticipantId: item.content.agentParticipantId, name: item.content.body }
    : { kind: 'message' as const, eventId: item.ref.eventId, authorParticipantId: item.participant.participantId }));
}
