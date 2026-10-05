import { describe, expect, it } from 'vitest';
import { channelNamePrompts, nameAcknowledgements, type ChannelNameMember } from './channel-names';
import { channelNameError, channelNameNote, TAKEN_HERE } from './ChannelNameDialog';

const alice = (participantId: string, since: number, ownerId = participantId): ChannelNameMember =>
  ({ participantId, kind: 'human', name: 'alice', ownerId, since });

describe('channelNamePrompts', () => {
  it('prompts only the human who took the name later, with the lowest free number', () => {
    const members = [alice('first', 10), alice('second', 20), { participantId: 'p3', kind: 'human', name: 'alice2', ownerId: 'p3', since: 5 } as const];
    expect(channelNamePrompts({ members, viewerParticipantId: 'first', viewerOwnerId: 'first' })).toEqual([]);
    expect(channelNamePrompts({ members, viewerParticipantId: 'second', viewerOwnerId: 'second' })).toEqual([{
      participantId: 'second', kind: 'human', name: 'alice', held: 'alice', suggestion: 'alice3', reason: 'collision',
      taken: ['alice', 'alice2'] }]);
  });

  it('never prompts for anyone else, nor when names differ', () => {
    const members = [alice('a', 1), alice('b', 2), { participantId: 'c', kind: 'human', name: 'carol', ownerId: 'c', since: 3 } as const];
    expect(channelNamePrompts({ members, viewerParticipantId: 'c', viewerOwnerId: 'c' })).toEqual([]);
  });

  it('shows an owner their agent that collides, and one that joined numbered until they keep it', () => {
    const members: ChannelNameMember[] = [
      { participantId: 'bob', kind: 'human', name: 'bob', ownerId: 'bob', since: 1 },
      { participantId: 'theirs', kind: 'agent', name: 'kevin-Claude', ownerId: 'other', since: 2 },
      { participantId: 'mine', kind: 'agent', name: 'kevin-Claude-2', ownerId: 'bob', since: 3 },
      { participantId: 'clash', kind: 'agent', name: 'bob', ownerId: 'bob', since: 4 },
    ];
    const prompts = channelNamePrompts({ members, viewerParticipantId: 'bob', viewerOwnerId: 'bob' });
    expect(prompts.map(prompt => [prompt.participantId, prompt.reason, prompt.held, prompt.suggestion])).toEqual([
      ['mine', 'numbered', 'kevin-Claude', 'kevin-Claude-2'], ['clash', 'collision', 'bob', 'bob-2']]);
    const kept = channelNamePrompts({ members, viewerParticipantId: 'bob', viewerOwnerId: 'bob',
      acknowledged: (participantId, name) => participantId === 'mine' && name === 'kevin-Claude-2' });
    expect(kept.map(prompt => prompt.participantId)).toEqual(['clash']);
    // The other owner never sees a prompt for an agent they do not own.
    expect(channelNamePrompts({ members, viewerParticipantId: 'x', viewerOwnerId: 'other' })).toEqual([]);
  });

  it('asks the viewer about themselves before their agents', () => {
    const members: ChannelNameMember[] = [
      { participantId: 'agent', kind: 'agent', name: 'dup', ownerId: 'me', since: 2 },
      { participantId: 'other', kind: 'human', name: 'dup', ownerId: 'other', since: 1 },
      { participantId: 'me', kind: 'human', name: 'other', ownerId: 'me', since: 3 },
      { participantId: 'x', kind: 'human', name: 'Other', ownerId: 'x', since: 0 },
    ];
    expect(channelNamePrompts({ members, viewerParticipantId: 'me', viewerOwnerId: 'me' }).map(prompt => prompt.participantId)).toEqual(['me', 'agent']);
  });
});

it('validates a draft against the name rules and this channel only', () => {
  const prompt = { kind: 'human' as const, taken: ['Alice', 'alice2'] };
  expect(channelNameError(prompt, 'alice3')).toBeNull();
  expect(channelNameError(prompt, 'ALICE2')).toBe(TAKEN_HERE);
  expect(channelNameError(prompt, 'a')).toBe('At least 2 characters.');
  expect(channelNameError({ kind: 'agent', taken: [] }, 'x'.repeat(41))).toBe('At most 40 characters.');
  expect(channelNameNote({ reason: 'collision', held: 'alice', name: 'alice' })).toBe('Someone here is already alice.');
  expect(channelNameNote({ reason: 'numbered', held: 'kevin-Claude', name: 'kevin-Claude-2' }))
    .toBe('kevin-Claude was taken here, so your agent joined as kevin-Claude-2.');
});

it('remembers kept agent names per viewer and channel, and survives missing storage', () => {
  const values = new Map<string, string>();
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
  const here = nameAcknowledgements('me', '!a:hs', storage);
  here.add('agent', 'kevin-Claude-2');
  expect(here.has('agent', 'kevin-Claude-2')).toBe(true);
  expect(here.has('agent', 'kevin-Claude-3')).toBe(false);
  expect(nameAcknowledgements('me', '!b:hs', storage).has('agent', 'kevin-Claude-2')).toBe(false);
  const none = nameAcknowledgements('me', '!a:hs', null);
  none.add('agent', 'x');
  expect(none.has('agent', 'x')).toBe(false);
  const broken = nameAcknowledgements('me', '!a:hs', { getItem: () => { throw Error('denied'); }, setItem: () => { throw Error('denied'); } });
  expect(() => broken.add('agent', 'x')).not.toThrow();
  expect(broken.has('agent', 'x')).toBe(false);
});
