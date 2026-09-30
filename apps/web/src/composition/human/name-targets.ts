import type { ParticipantView } from '@khala/contracts/messaging/index';
import type { SubstrateEvent } from '@khala/messaging/channels/index';

/** Sender attribution is complete before this step; one target cannot invalidate its neighbours. */
export async function attachNameTargets(events: readonly SubstrateEvent[],
  resolve: (targetId: ParticipantView['participantId']) => Promise<ReadonlyMap<string, ParticipantView> | null>,
  isCurrent: () => boolean): Promise<readonly SubstrateEvent[]> {
  const result: SubstrateEvent[] = [];
  for (const event of events) {
    if (event.kind !== 'message' || event.content.kind === 'text') { result.push(event); continue; }
    const targetId = event.content.agentParticipantId;
    const mapping = await resolve(targetId).catch(() => null);
    if (!isCurrent()) throw new Error('Matrix session changed during name target resolution');
    const targetParticipant = [...(mapping?.values() ?? [])].find(participant => participant.participantId === targetId);
    if (!targetParticipant) {
      result.push({ kind: 'undecryptable', eventId: event.eventId, authorParticipantId: event.participant.participantId,
        receivedAt: event.receivedAt, reason: 'decryption_failed' });
      continue;
    }
    result.push({ ...event, targetParticipant });
  }
  return result;
}
