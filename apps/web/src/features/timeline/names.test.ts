import { expect, it } from 'vitest';
import type { ParticipantView, TimelineItem } from '@khala/contracts/messaging/index';
import { projectTimelineNames } from './names';

it('replays an authenticated rename of a departed agent with no readable agent-authored messages', () => {
  const owner = { participantId: 'human_one' as never, ownerId: 'owner_one' as never, kind: 'human', displayName: 'Maya', deviceIds: [] } as ParticipantView;
  const target = { participantId: 'agent_departed' as never, ownerId: owner.ownerId, kind: 'agent', displayName: 'Codex #420', deviceIds: [] } as ParticipantView;
  const rename = { ref: { eventId: '$rename' }, participant: owner, targetParticipant: target,
    content: { kind: 'agent_rename', agentParticipantId: target.participantId, body: 'Dolan' } } as unknown as TimelineItem;
  const projection = projectTimelineNames([rename], owner);
  expect(projection.events).toMatchObject([{ kind: 'agent_rename', previousName: 'Codex #420', name: 'Dolan' }]);
  expect(projection.currentNames.get(target.participantId)).toBe('Dolan');
});
