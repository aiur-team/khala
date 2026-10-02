import { describe, expect, it } from 'vitest';
import { segmentMentions } from '../../features/timeline/mentions';
import { flatMentionOrder, type MentionTarget } from './MentionChips';
import { activeMentionQuery, applyMention, filterMentionTargets, mentionKindLabel } from './mention-autocomplete';

// The composer harness roster (synthetic people and agents only).
const targets: readonly MentionTarget[] = [
  { id: 'p-kevin', kind: 'human', label: 'Kevin', display: 'Kevin', hue: 214, ownerHue: 214, ownerInitials: 'YO', ownerId: 'o-kevin', isViewer: true },
  { id: 'a1', kind: 'agent', label: 'Claude', display: 'Claude #frontend', hue: 210, ownerHue: 214, ownerInitials: 'KE', harness: 'claude', ownerId: 'o-kevin', isViewer: false },
  { id: 'p-maya', kind: 'human', label: 'Maya', display: 'Maya', hue: 330, ownerHue: 330, ownerInitials: 'MC', ownerId: 'o-maya', isViewer: false },
  { id: 'a2', kind: 'agent', label: 'Codex', display: 'Codex #backend', hue: 150, ownerHue: 330, ownerInitials: 'MC', harness: 'codex', ownerId: 'o-maya', isViewer: false },
  { id: 'p-kai', kind: 'human', label: 'Kai', display: 'Kai', hue: 150, ownerHue: 150, ownerInitials: 'KA', ownerId: 'o-kai', isViewer: false },
  { id: 'a3', kind: 'agent', label: 'Claude', display: 'Claude #infra', hue: 32, ownerHue: 150, ownerInitials: 'KA', harness: 'claude', ownerId: 'o-kai', isViewer: false },
];

const agent = (id: string, label: string, ownerId = 'o-kevin', display = label): MentionTarget =>
  ({ id, kind: 'agent', label, display, hue: 200, ownerHue: 214, ownerInitials: 'ZZ', ownerId, isViewer: false });

const ids = (list: readonly MentionTarget[]) => list.map(target => target.id);

describe('activeMentionQuery', () => {
  it('opens at the start of the draft, after a space and after a parenthesis', () => {
    expect(activeMentionQuery('@', 1)).toEqual({ start: 0, end: 1, query: '' });
    expect(activeMentionQuery('@cl', 3)).toEqual({ start: 0, end: 3, query: 'cl' });
    expect(activeMentionQuery('hi @c', 5)).toEqual({ start: 3, end: 5, query: 'c' });
    expect(activeMentionQuery('hi\n@c', 5)).toEqual({ start: 3, end: 5, query: 'c' });
    expect(activeMentionQuery('ask (@ma', 8)).toEqual({ start: 5, end: 8, query: 'ma' });
  });

  it('never opens inside a word, such as an email address', () => {
    expect(activeMentionQuery('a@b', 3)).toBeNull();
    expect(activeMentionQuery('foo@c', 5)).toBeNull();
  });

  it('closes once a space follows the query', () => {
    expect(activeMentionQuery('@Maya ', 6)).toBeNull();
    expect(activeMentionQuery('hi', 2)).toBeNull();
  });

  it('reads only the text before the caret', () => {
    expect(activeMentionQuery('hi @co and more', 6)).toEqual({ start: 3, end: 6, query: 'co' });
    expect(activeMentionQuery('hi @co and more', 15)).toBeNull();
  });

  it('accepts unicode letters, hyphens and dots', () => {
    expect(activeMentionQuery('@Zoë', 4)).toEqual({ start: 0, end: 4, query: 'Zoë' });
    expect(activeMentionQuery('@Kevin-Cl', 9)?.query).toBe('Kevin-Cl');
    expect(activeMentionQuery('@a.b_c', 6)?.query).toBe('a.b_c');
  });
});

describe('filterMentionTargets', () => {
  it('ranks the label-prefix hits for @c in chip order', () => {
    expect(ids(filterMentionTargets(targets, 'c'))).toEqual(['a1', 'a2', 'a3']);
  });

  it('is case-insensitive', () => {
    expect(ids(filterMentionTargets(targets, 'C'))).toEqual(['a1', 'a2', 'a3']);
    expect(ids(filterMentionTargets(targets, 'KA'))).toEqual(['p-kai']);
  });

  it('lists the whole chip order for an empty query, never the viewer', () => {
    const all = filterMentionTargets(targets, '');
    expect(ids(all)).toEqual(ids(flatMentionOrder(targets)));
    expect(ids(all)).toEqual(['a1', 'p-maya', 'a2', 'p-kai', 'a3']);
    expect(ids(filterMentionTargets(targets, 'kev'))).toEqual([]);
  });

  it('ranks a word-segment prefix after label-prefix hits', () => {
    const roster = [agent('kc', 'Kevin-Claude'), agent('co', 'Codex')];
    expect(ids(filterMentionTargets(roster, 'c'))).toEqual(['co', 'kc']);
  });

  it('ranks substrings after prefix hits, matching display too', () => {
    expect(ids(filterMentionTargets(targets, 'ai'))).toEqual(['p-kai']);
    const roster = [agent('x', 'Plain', 'o-kevin', 'Plain #ka'), agent('k', 'Kai'), agent('m', 'Mika')];
    expect(ids(filterMentionTargets(roster, 'ka'))).toEqual(['k', 'x', 'm']);
  });

  it('shows at most eight', () => {
    const roster = Array.from({ length: 12 }, (_, index) => agent(`a${index}`, `Agent${index}`));
    expect(filterMentionTargets(roster, 'a')).toHaveLength(8);
    expect(filterMentionTargets(roster, '')).toHaveLength(8);
  });

  it('works for any label, with nothing hard-coded', () => {
    const roster = [agent('z', 'Zed-Opus'), agent('q', 'Quill')];
    expect(ids(filterMentionTargets(roster, 'o'))).toEqual(['z']);
    expect(ids(filterMentionTargets(roster, 'ze'))).toEqual(['z']);
  });
});

describe('applyMention', () => {
  it('replaces the query and keeps the text after the caret', () => {
    const value = 'hi @co, thanks';
    expect(applyMention(value, activeMentionQuery(value, 6)!, 'Codex')).toEqual({ value: 'hi @Codex , thanks', caret: 10 });
  });

  it('appends a space and puts the caret after it', () => {
    expect(applyMention('hi @c', { start: 3, end: 5, query: 'c' }, 'Codex')).toEqual({ value: 'hi @Codex ', caret: 10 });
  });

  it('reuses whitespace already after the caret', () => {
    expect(applyMention('hi @c there', { start: 3, end: 5, query: 'c' }, 'Codex')).toEqual({ value: 'hi @Codex there', caret: 10 });
  });

  it('round-trips through segmentMentions as the picked participant', () => {
    const roster = targets.map(target => ({ label: target.label, participantId: target.id, kind: target.kind, hue: target.hue }));
    const { value } = applyMention('hi @co', { start: 3, end: 6, query: 'co' }, 'Codex');
    expect(segmentMentions(value, roster)).toEqual([
      { text: 'hi ' },
      { mention: 'Codex', participantId: 'a2', kind: 'agent', hue: 150 },
      { text: ' ' },
    ]);
  });
});

describe('mentionKindLabel', () => {
  it('names humans, the viewer\'s agents and other owners\' agents', () => {
    const [, claude, maya, codex] = targets;
    expect(mentionKindLabel(maya!, targets)).toBe('Human');
    expect(mentionKindLabel(claude!, targets)).toBe('Your agent');
    expect(mentionKindLabel(codex!, targets)).toBe('Agent of Maya');
  });

  it('falls back to owner initials when the owner is not listed', () => {
    expect(mentionKindLabel(agent('x', 'Stray', 'o-gone'), targets)).toBe('Agent of ZZ');
  });
});
