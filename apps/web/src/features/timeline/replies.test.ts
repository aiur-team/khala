import { describe, expect, it } from 'vitest';
import { indexReplies, snippet } from './replies';

describe('indexReplies', () => {
  const nodes = [
    { id: '$a' }, { id: '$b', parent: '$a' }, { id: '$x' }, { id: '$c', parent: '$b' }, { id: '$d', parent: '$a' },
    { id: '$orphan', parent: '$unloaded' },
  ];
  const index = indexReplies(nodes);

  it('chains a reply to a reply back to the loaded root, in timeline order', () => {
    expect(index.rootOf('$c')).toBe('$a');
    expect(index.thread('$c')).toEqual(['$a', '$b', '$c', '$d']);
    expect(index.thread('$a')).toEqual(['$a', '$b', '$c', '$d']);
  });

  it('counts direct replies only', () => {
    expect(index.counts.get('$a')).toBe(2);
    expect(index.counts.get('$b')).toBe(1);
    expect(index.counts.get('$x')).toBeUndefined();
  });

  it('roots a reply whose parent is not loaded at itself', () => {
    expect(index.rootOf('$orphan')).toBe('$orphan');
    expect(index.thread('$orphan')).toEqual(['$orphan']);
    expect(index.counts.has('$unloaded')).toBe(false);
  });

  it('does not hang on a forged cycle', () => {
    const cyclic = indexReplies([{ id: '$p', parent: '$q' }, { id: '$q', parent: '$p' }]);
    expect(cyclic.thread('$p')).toContain('$p');
  });
});

describe('snippet', () => {
  it('collapses whitespace and truncates', () => {
    expect(snippet('a\n\n b')).toBe('a b');
    expect(snippet('x'.repeat(100), 10)).toBe(`${'x'.repeat(9)}…`);
  });
});
