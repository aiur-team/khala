import type { ParticipantView, TimelineItem } from '@khala/contracts/messaging/index';
import { projectNamesInOrder, type NameParticipant, type NameTimelineEvent } from '@khala/contracts/messaging/agent-names';

/** Shared name replay for the real thread and its participant panel. */
export function projectTimelineNames(items: readonly TimelineItem[], viewer: ParticipantView,
  additional: readonly NameParticipant[] = []) {
  const participants = new Map<string, NameParticipant>();
  for (const participant of additional) participants.set(participant.participantId, participant);
  const targets = items.flatMap(item => 'targetParticipant' in item && item.targetParticipant ? [item.targetParticipant] : []);
  for (const participant of [...targets, ...items.map(item => item.participant), viewer]) {
    if (!participants.has(participant.participantId)) participants.set(participant.participantId, {
      participantId: participant.participantId, ownerId: participant.ownerId,
      kind: participant.kind, initialName: participant.displayName,
    });
  }
  return projectNamesInOrder([...participants.values()], items.map((item): NameTimelineEvent => (item.content.kind === 'agent_rename' || item.content.kind === 'agent_name_snapshot')
    ? { kind: item.content.kind, eventId: item.ref.eventId, actorParticipantId: item.participant.participantId,
        targetParticipantId: item.content.agentParticipantId, name: item.content.body,
        sourceEventId: item.content.kind === 'agent_name_snapshot' ? item.content.sourceEventId : null }
    : { kind: 'message' as const, eventId: item.ref.eventId, authorParticipantId: item.participant.participantId }));
}
