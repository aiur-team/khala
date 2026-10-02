// `@mention` segmentation (RECREATION-SPEC §7.1 [ADAPT]): only `@` followed by
// a *known* roster label becomes a mention. Matching is case-insensitive,
// prefers the longest label, and needs a word boundary on both sides, so an
// email address or `@Kaiser` never mentions `Kai`.

export type MentionCandidate = Readonly<{
  /** An agent label (the display name before ` · `) or a human's first name. */
  label: string;
  participantId: string;
  kind: 'human' | 'agent';
  hue: number;
}>;

export type MentionSegment =
  | Readonly<{ text: string }>
  | Readonly<{ mention: string; participantId: string; kind: 'human' | 'agent'; hue: number }>;

type Matcher = Readonly<{ pattern: RegExp; byLabel: ReadonlyMap<string, MentionCandidate> }> | null;

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
  const labels = [...byLabel.values()].map(candidate => candidate.label).sort((a, b) => b.length - a.length);
  const matcher = labels.length === 0 ? null : {
    pattern: new RegExp(`(?<![\\p{L}\\p{N}_@])@(${labels.map(escape).join('|')})(?![\\p{L}\\p{N}_])`, 'giu'),
    byLabel,
  };
  matchers.set(roster, matcher);
  return matcher;
}

export function segmentMentions(text: string, roster: readonly MentionCandidate[]): readonly MentionSegment[] {
  const matcher = matcherFor(roster);
  if (!matcher || !text.includes('@')) return text ? [{ text }] : [];
  const segments: MentionSegment[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(matcher.pattern)) {
    const candidate = matcher.byLabel.get(match[1]!.toLocaleLowerCase('en-US'));
    if (!candidate) continue;
    if (match.index > lastIndex) segments.push({ text: text.slice(lastIndex, match.index) });
    segments.push({ mention: candidate.label, participantId: candidate.participantId, kind: candidate.kind, hue: candidate.hue });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) segments.push({ text: text.slice(lastIndex) });
  return segments;
}
