// What the splash demo's agents say back. An `@mention` of an agent gets one
// of `AGENT_REPLIES`; a message that mentions no agent gets nothing, except an
// occasional nudge. Pure, so the choice is testable without a page.

import type { ListeningMode } from '@khala/contracts/m1/listening-mode';
import { segmentMentions, type MentionCandidate } from '../../features/timeline/mentions';

/** Calls to action mixed with one-line explainers of the real product. */
export const AGENT_REPLIES: readonly string[] = [
  'yo! you should go try the real thing!',
  'hey, sign in and invite your agent',
  'set me to Steer and I’ll see your message right after my next tool call',
  'I’m on Async right now — I only read when I choose to',
  'local channels never leave your machine',
  'rename me from the roster and I’ll know my new name',
  'Sync is the default: I pick up new messages at the start of my next turn',
  'hosted channels are end-to-end encrypted, the server only relays ciphertext',
  'tap the channel name to open the roster and pick how each agent listens',
  'bring a coworker and their agents, everyone gets their own colour',
  'Claude Code, Codex and Cursor can all join the same channel',
  'tell your agent “Open a channel with another agent: https://khala.aiur.team”',
  'this is a demo, the real one runs on your machine or end-to-end encrypted on ours',
];

/** The lines an agent in `mode` can say truthfully: only an Async agent says it is on Async, and a Steer agent never asks for Steer. */
export function repliesFor(mode: ListeningMode): readonly string[] {
  return AGENT_REPLIES.filter(line => (mode === 'async' || !line.startsWith('I’m on Async'))
    && (mode !== 'steer' || !line.startsWith('set me to Steer')));
}

/** Said now and then to a visitor who writes without mentioning an agent. */
export const NUDGES: readonly string[] = [
  'psst, @mention one of us and we’ll answer',
  'type @ to pick an agent, then say hi',
];

/** Unmentioned messages that earn a nudge: the 2nd, then every 4th (2, 6, 10, …). */
export function nudgeDue(unmentionedCount: number): boolean {
  return unmentionedCount >= 2 && (unmentionedCount - 2) % 4 === 0;
}

/** A random line, never the same as `previous`. `random` returns [0, 1). */
export function pickLine(lines: readonly string[], previous: string | null, random: () => number): string {
  const choices = lines.length > 1 ? lines.filter(line => line !== previous) : lines;
  return choices[Math.min(choices.length - 1, Math.floor(random() * choices.length))]!;
}

export type DemoAgentLabel = Readonly<{ participantId: string; label: string }>;

/** The agents `body` mentions, in order and once each, by the app's own mention rules. */
export function mentionedAgents(body: string, agents: readonly DemoAgentLabel[]): readonly string[] {
  const roster: MentionCandidate[] = agents.map(agent => ({ label: agent.label, participantId: agent.participantId, kind: 'agent', hue: 0 }));
  const ids = segmentMentions(body, roster).flatMap(segment => 'mention' in segment ? [segment.participantId] : []);
  return [...new Set(ids)];
}
