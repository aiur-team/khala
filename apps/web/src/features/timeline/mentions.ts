// `@mention` segmentation (RECREATION-SPEC §7.1 [ADAPT]): only `@` followed by
// a *known* roster label or a group (`@channel`, `@humans`, `@agents`) becomes
// a mention. Matching is case-insensitive, prefers the longest label, and needs
// a word boundary on both sides, so an email address or `@Kaiser` never mentions `Kai`.

export type MentionCandidate = Readonly<{
  /** An agent label (the display name before ` · `) or a human's first name. */
  label: string;
  participantId: string;
  kind: 'human' | 'agent';
  hue: number;
}>;

/** `@channel` pings everyone, `@humans` only people, `@agents` only agents. Groups win over a same-named label. */
export const MENTION_GROUPS = ['channel', 'humans', 'agents'] as const;
export type MentionGroupName = typeof MENTION_GROUPS[number];

export type MentionSegment =
  | Readonly<{ text: string }>
  | Readonly<{ group: MentionGroupName }>
  | Readonly<{ mention: string; participantId: string; kind: 'human' | 'agent'; hue: number }>;

type Matcher = Readonly<{ pattern: RegExp; byLabel: ReadonlyMap<string, MentionCandidate> }>;

const matchers = new WeakMap<readonly MentionCandidate[], Matcher>();

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/** Compiled once per roster array, so a long thread never recompiles per message. */
function matcherFor(roster: readonly MentionCandidate[]): Matcher {
  if (matchers.has(roster)) return matchers.get(roster)!;
  const byLabel = new Map<string, MentionCandidate>();
  for (const candidate of roster) {
    const key = candidate.label.toLocaleLowerCase('en-US');
    if (candidate.label.trim() && !byLabel.has(key)) byLabel.set(key, candidate);
  }
  const labels = [...MENTION_GROUPS, ...[...byLabel.values()].map(candidate => escape(candidate.label))].sort((a, b) => b.length - a.length);
  const matcher = {
    pattern: new RegExp(`(?<![\\p{L}\\p{N}_@])@(${labels.join('|')})(?![\\p{L}\\p{N}_])`, 'giu'),
    byLabel,
  };
  matchers.set(roster, matcher);
  return matcher;
}

export function segmentMentions(text: string, roster: readonly MentionCandidate[]): readonly MentionSegment[] {
  if (!text.includes('@')) return text ? [{ text }] : [];
  const matcher = matcherFor(roster);
  const segments: MentionSegment[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(matcher.pattern)) {
    const name = match[1]!.toLocaleLowerCase('en-US');
    const group = MENTION_GROUPS.find(candidate => candidate === name);
    const candidate = matcher.byLabel.get(name);
    if (!group && !candidate) continue;
    if (match.index > lastIndex) segments.push({ text: text.slice(lastIndex, match.index) });
    segments.push(group ? { group } : { mention: candidate!.label, participantId: candidate!.participantId, kind: candidate!.kind, hue: candidate!.hue });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) segments.push({ text: text.slice(lastIndex) });
  return segments;
}
