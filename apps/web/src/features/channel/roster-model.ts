// The roster tree (RECREATION-SPEC §6.1): one group per human, the viewer
// first and other humans in member order, each holding the agents it owns.
// An agent whose owner is not a member trails under a synthetic owner group.

import type { HarnessId } from '@khala/contracts/m1/harness';

export type RosterHuman = Readonly<{ participantId?: string; ownerId: string; displayName: string }>;

export type RosterAgent = Readonly<{
  participantId: string;
  /** Server-attested owner binding; an agent without one cannot be placed under a member. */
  ownerId?: string;
  displayName: string;
  harness?: HarnessId;
  /** C3 `ownerLabel`: names the synthetic group of an owner who is not a member. */
  ownerLabel?: string;
}>;

export type RosterGroup =
  | Readonly<{ human: RosterHuman; isViewer: boolean; agents: readonly RosterAgent[] }>
  | Readonly<{ human: RosterHuman; notInChannel: true; agents: readonly RosterAgent[] }>;

export function groupRoster({ viewer, humans, agents }: Readonly<{
  viewer: RosterHuman;
  humans: readonly RosterHuman[];
  agents: readonly RosterAgent[];
}>): readonly RosterGroup[] {
  const agentsOf = (ownerId: string) => agents.filter(agent => agent.ownerId === ownerId);
  const members = [viewer, ...humans.filter(human => human.ownerId !== viewer.ownerId)];
  const groups: RosterGroup[] = members.map((human, index) => ({ human, isViewer: index === 0, agents: agentsOf(human.ownerId) }));
  const placed = new Set(members.map(human => human.ownerId));
  for (const agent of agents) {
    const ownerId = agent.ownerId ?? '';
    if (placed.has(ownerId)) continue;
    placed.add(ownerId);
    const owned = agents.filter(candidate => (candidate.ownerId ?? '') === ownerId);
    groups.push({ human: { displayName: agent.ownerLabel ?? 'Channel member', ownerId }, notInChannel: true, agents: owned });
  }
  return groups;
}

/** `Owner of N agent(s)` (§22: the design's role · host, which M1 has no data for). */
export function ownerOfLabel(count: number): string {
  return `Owner of ${count} ${count === 1 ? 'agent' : 'agents'}`;
}

/** The header subtitle counts (§5): `human` + `s` with any other human; `agent` + `s` unless exactly 1. */
export function memberCountLabel(humans: number, agents: number): string {
  return `${humans} ${humans > 1 ? 'humans' : 'human'} · ${agents} ${agents === 1 ? 'agent' : 'agents'}`;
}
