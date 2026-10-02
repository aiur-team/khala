import { describe, expect, it } from 'vitest';
import { computeRuns, runClass, type RunInput } from './runs';

const from = (participantId: string, isViewer = false): RunInput => ({ kind: 'message', participantId, isViewer });

describe('computeRuns', () => {
  it('marks a single message first only, with its name and a visible avatar', () => {
    const [position] = computeRuns([from('a')]);
    expect(position).toMatchObject({ first: true, mid: false, lastOf: false, showName: true, showAvatar: true, ghost: false });
    expect(runClass(position!)).toBe('first');
  });

  it('marks three in a row first, mid and last-of, naming the first and ghosting the first two', () => {
    const positions = computeRuns([from('a'), from('a'), from('a')]);
    expect(positions.map(position => runClass(position!))).toEqual(['first', 'mid', 'last-of']);
    expect(positions.map(position => position!.showName)).toEqual([true, false, false]);
    expect(positions.map(position => position!.ghost)).toEqual([true, true, false]);
  });

  it('starts a new run after an event between two messages from the same sender', () => {
    const positions = computeRuns([from('a'), { kind: 'break' }, from('a')]);
    expect(positions[1]).toBeNull();
    expect(positions[0]).toMatchObject({ first: true, ghost: false });
    expect(positions[2]).toMatchObject({ first: true, ghost: false });
  });

  it('gives a viewer message no avatar and no name', () => {
    const [position] = computeRuns([from('me', true)]);
    expect(position).toMatchObject({ first: true, showName: false, showAvatar: false, ghost: false });
  });

  it('splits runs between different senders', () => {
    const positions = computeRuns([from('a'), from('b'), from('b')]);
    expect(positions.map(position => runClass(position!))).toEqual(['first', 'first', 'last-of']);
  });
});
