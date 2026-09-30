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
    const mapping = await resolve(targetId);
    if (!isCurrent()) throw new Error('Matrix session changed during name target resolution');
    if (mapping === null) throw new Error('Matrix name target lookup unavailable');
    const targetParticipant = [...mapping.values()].find(participant => participant.participantId === targetId);
    // A successful lookup omitting the target rejects this metadata claim.
    if (!targetParticipant) continue;
    result.push({ ...event, targetParticipant });
  }
  return result;
}
