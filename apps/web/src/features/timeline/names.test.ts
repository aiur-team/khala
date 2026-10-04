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

it('lets the directory name of a human outrank the stale name on their older messages', () => {
  const viewer = { participantId: 'human_alice' as never, ownerId: 'owner_alice' as never, kind: 'human', displayName: 'alice', deviceIds: [] } as ParticipantView;
  const bob = { participantId: 'human_bob' as never, ownerId: 'owner_bob' as never, kind: 'human', displayName: 'bob', deviceIds: [] } as ParticipantView;
  const message = { ref: { eventId: '$m', authorParticipantId: bob.participantId }, participant: bob, content: { kind: 'text', body: 'hi' } } as unknown as TimelineItem;
  expect(projectTimelineNames([message], viewer).currentNames.get(bob.participantId)).toBe('bob');
  const renamed = projectTimelineNames([message], viewer, [{ participantId: bob.participantId, ownerId: bob.ownerId, kind: 'human', initialName: 'robert' }]);
  expect(renamed.currentNames.get(bob.participantId)).toBe('robert');
});
