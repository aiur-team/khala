import { describe, expect, it } from 'vitest';
import { groupRoster, memberCountLabel, ownerOfLabel, type RosterAgent } from './roster-model';

const viewer = { participantId: 'p-me', ownerId: 'o-me', displayName: 'Kevin' };
const maya = { participantId: 'p-maya', ownerId: 'o-maya', displayName: 'Maya Chen' };
const a1: RosterAgent = { participantId: 'a1', ownerId: 'o-me', displayName: 'Claude · Kevin', harness: 'claude' };
const a2: RosterAgent = { participantId: 'a2', ownerId: 'o-maya', displayName: 'Codex · Maya', harness: 'codex' };
const a3: RosterAgent = { participantId: 'a3', ownerId: 'o-zed', displayName: 'Claude · Zed', harness: 'claude', ownerLabel: 'Zed' };

describe('groupRoster', () => {
  it('groups agents under their owners and puts absent owners in a synthetic group', () => {
    expect(groupRoster({ viewer, humans: [maya], agents: [a1, a2, a3] })).toEqual([
      { human: viewer, isViewer: true, agents: [a1] },
      { human: maya, isViewer: false, agents: [a2] },
      { human: { displayName: 'Zed', ownerId: 'o-zed' }, notInChannel: true, agents: [a3] },
    ]);
  });

  it('gives a human with no agents an empty agent list', () => {
    const groups = groupRoster({ viewer, humans: [maya], agents: [a1] });
    expect(groups[1]).toEqual({ human: maya, isViewer: false, agents: [] });
  });

  it('keeps a viewer with no agents first', () => {
    const groups = groupRoster({ viewer, humans: [maya], agents: [a2] });
    expect(groups.map(group => group.human)).toEqual([viewer, maya]);
    expect(groups[0]).toMatchObject({ isViewer: true, agents: [] });
  });

  it('groups ownerless agents together without a member', () => {
    const loose = { participantId: 'a4', displayName: 'Scout' };
    const groups = groupRoster({ viewer, humans: [], agents: [loose, { ...loose, participantId: 'a5' }] });
    expect(groups).toHaveLength(2);
    expect(groups[1]).toMatchObject({ notInChannel: true, human: { displayName: 'Channel member' } });
    expect(groups[1]!.agents).toHaveLength(2);
  });
});

describe('labels', () => {
  it('pluralises like the design', () => {
    expect(memberCountLabel(1, 1)).toBe('1 human · 1 agent');
    expect(memberCountLabel(2, 0)).toBe('2 humans · 0 agents');
    expect(ownerOfLabel(1)).toBe('Owner of 1 agent');
    expect(ownerOfLabel(0)).toBe('Owner of 0 agents');
  });
});
