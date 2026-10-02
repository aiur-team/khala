// Slack-style `@mention` autocomplete for the composer. Pure helpers: find
// the `@query` at the caret, rank roster targets for it, and splice the
// picked `@label ` in. The inserted token is the one `insertMention` and the
// chips insert, so `segmentMentions` renders it as a mention unchanged.

import { flatMentionOrder, type MentionTarget } from './MentionChips';

/** `start` is the index of the `@`, `end` the caret. */
export type MentionQuery = Readonly<{ start: number; end: number; query: string }>;

/** Most suggestions shown at once. */
const LIMIT = 8;

/** The active `@query` ending at the caret, or null. An `@` inside a word (an email) never opens one. */
export function activeMentionQuery(value: string, caret: number): MentionQuery | null {
  const before = value.slice(0, caret);
  const match = /(?:^|[\s(])@([\p{L}\p{N}_.-]*)$/u.exec(before);
  if (!match) return null;
  const query = match[1]!;
  return { start: before.length - query.length - 1, end: before.length, query };
}

/**
 * Candidates for `query`, best first: label prefix, then a label word prefix,
 * then a label or display substring, each tier in chip order. The viewer's
 * own human entry is never a candidate.
 */
export function filterMentionTargets(targets: readonly MentionTarget[], query: string): readonly MentionTarget[] {
  const base = flatMentionOrder(targets);
  const q = query.toLocaleLowerCase('en-US');
  if (!q) return base.slice(0, LIMIT);
  const lower = (text: string) => text.toLocaleLowerCase('en-US');
  const tiers = [
    (target: MentionTarget) => lower(target.label).startsWith(q),
    (target: MentionTarget) => lower(target.label).split(/[\s\-_.]+/u).some(word => word.startsWith(q)),
    (target: MentionTarget) => lower(target.label).includes(q) || lower(target.display).includes(q),
  ];
  const seen = new Set<string>();
  const ranked: MentionTarget[] = [];
  for (const matches of tiers) {
    for (const target of base) {
      if (seen.has(target.id) || !matches(target)) continue;
      seen.add(target.id);
      ranked.push(target);
    }
  }
  return ranked.slice(0, LIMIT);
}

/** Replace `value[start, end)` with `@label `, reusing whitespace already after the caret. */
export function applyMention(value: string, range: MentionQuery, label: string): Readonly<{ value: string; caret: number }> {
  const after = value.slice(range.end);
  const spaced = /^\s/u.test(after);
  return {
    value: `${value.slice(0, range.start)}@${label}${spaced ? '' : ' '}${after}`,
    caret: range.start + label.length + 2,
  };
}

/** `Human`, `Your agent`, or `Agent of <owner's first name>` (owner initials when the owner isn't listed). */
export function mentionKindLabel(target: MentionTarget, targets: readonly MentionTarget[]): string {
  if (target.kind === 'human') return 'Human';
  const viewer = targets.find(candidate => candidate.isViewer);
  if (viewer && viewer.ownerId === target.ownerId) return 'Your agent';
  const owner = targets.find(candidate => candidate.kind === 'human' && candidate.ownerId === target.ownerId);
  return `Agent of ${owner?.label ?? target.ownerInitials}`;
}
