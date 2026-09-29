import { describe, expect, it } from 'vitest';
import type { OwnerId, ParticipantId } from '@khala/contracts/messaging/ids';
import { projectNamesInOrder, type NameParticipant, type NameTimelineEvent } from './agent-names';

const maya = 'human_maya' as ParticipantId;
const theo = 'human_theo' as ParticipantId;
const codex = 'agent_codex' as ParticipantId;
const scout = 'agent_scout' as ParticipantId;
const participants: NameParticipant[] = [
  { participantId: maya, ownerId: 'owner_maya' as OwnerId, kind: 'human', initialName: 'Maya' },
  { participantId: theo, ownerId: 'owner_theo' as OwnerId, kind: 'human', initialName: 'Theo' },
  { participantId: codex, ownerId: 'owner_maya' as OwnerId, kind: 'agent', initialName: 'Codex #420' },
  { participantId: scout, ownerId: 'owner_theo' as OwnerId, kind: 'agent', initialName: 'Codex #420' },
];
const message = (eventId: string, authorParticipantId = codex): NameTimelineEvent => ({ kind: 'message', eventId, authorParticipantId });
const rename = (eventId: string, actorParticipantId: ParticipantId, name: string): NameTimelineEvent => ({
  kind: 'agent_rename', eventId, actorParticipantId, targetParticipantId: codex, name,
});

describe('ordered agent names', () => {
  it('keeps pre-rename bylines, names new messages, and preserves same-name identities', () => {
    const result = projectNamesInOrder(participants, [message('before'), rename('rename', maya, 'Dolan'), message('after'), message('theo-agent', scout)]);
    expect(result.events).toEqual([
      { kind: 'message', eventId: 'before', authorParticipantId: codex, authorName: 'Codex #420' },
      { kind: 'agent_rename', eventId: 'rename', actorParticipantId: maya, actorName: 'Maya',
        targetParticipantId: codex, previousName: 'Codex #420', name: 'Dolan' },
      { kind: 'message', eventId: 'after', authorParticipantId: codex, authorName: 'Dolan' },
      { kind: 'message', eventId: 'theo-agent', authorParticipantId: scout, authorName: 'Codex #420' },
    ]);
    expect(result.currentNames.get(codex)).toBe('Dolan');
    expect(result.currentNames.get(scout)).toBe('Codex #420');
  });

  it('ignores unauthorized, invalid, repeated and replayed renames', () => {
    const result = projectNamesInOrder(participants, [rename('forged', theo, 'Theirs'),
      rename('bad', maya, 'System'), rename('good', maya, 'Dolan'), rename('good', maya, 'Duplicate'),
      rename('same', maya, 'Dolan'), message('after')]);
    expect(result.events.map(event => event.eventId)).toEqual(['good', 'after']);
    expect(result.currentNames.get(codex)).toBe('Dolan');
  });

  it('orders simultaneous renames by their durable event order', () => {
    const result = projectNamesInOrder(participants, [rename('first', maya, 'Dolan'), rename('second', maya, 'Scout'), message('next')]);
    expect(result.events[1]).toMatchObject({ previousName: 'Dolan', name: 'Scout' });
    expect(result.events[2]).toMatchObject({ authorName: 'Scout' });
  });
});
