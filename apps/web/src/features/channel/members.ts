// Resolves the channel's members into what the header, roster and detail
// pane draw: names (never routing IDs), hues, initials, harness and ownership.

import type { Harness } from '@khala/contracts/m1/agent-join';
import type { Participant } from '@khala/contracts/m1/participants';
import type { ParticipantId } from '@khala/contracts/messaging/ids';
import { initials, participantHue } from '../../ui/khala/identity';
import type { ChannelAgentView } from './controller';
import { participantRosterName } from './participant-name';
import { groupRoster, type RosterGroup } from './roster-model';

export type HumanMember = Readonly<{
  kind: 'human';
  participantId: string;
  ownerId: string;
  name: string;
  /** The first name, for the subtitle and `@ Mention {first name}`. */
  short: string;
  hue: number;
  initials: string;
  isViewer: boolean;
}>;

export type AgentMember = Readonly<{
  kind: 'agent';
  participantId: ParticipantId;
  ownerId: string | null;
  name: string;
  /** Ordinal among same-named agents (`.kh-id`), else `null`. */
  idBadge: number | null;
  hue: number;
  ownerHue: number;
  ownerName: string;
  ownerInitials: string;
  harness: Harness | null;
  isViewerOwned: boolean;
  agent: ChannelAgentView;
}>;

export type Member = HumanMember | AgentMember;

export type ChannelMembers = Readonly<{
  viewer: HumanMember;
  /** Other humans in member order. */
  humans: readonly HumanMember[];
  agents: readonly AgentMember[];
  groups: readonly RosterGroup[];
  byId: ReadonlyMap<string, Member>;
}>;

export type MemberInput = Readonly<{
  viewer: Readonly<{ participantId?: string; ownerId?: string; name?: string }>;
  humans: readonly Readonly<{ participantId: string; ownerId?: string; displayName: string }>[];
  agents: readonly ChannelAgentView[];
  currentNames?: ReadonlyMap<ParticipantId, string> | undefined;
  describeParticipant?: ((participantId: string) => Participant | undefined) | undefined;
}>;

const firstName = (name: string) => name.trim().split(/\s+/u)[0] ?? name;

export function resolveMembers({ viewer, humans, agents, currentNames, describeParticipant }: MemberInput): ChannelMembers {
  const viewerName = participantRosterName(viewer.name ?? '', 'You');
  const viewerOwnerId = viewer.ownerId ?? '';
  const viewerMember: HumanMember = {
    kind: 'human', participantId: viewer.participantId ?? 'viewer', ownerId: viewerOwnerId,
    name: viewerName || 'You', short: 'You', hue: participantHue({ kind: 'human', ownerId: viewerOwnerId, isViewer: true }),
    initials: 'YO', isViewer: true,
  };
  const humanMembers = humans.map((human): HumanMember => {
    const name = participantRosterName(human.displayName, 'Channel member');
    const ownerId = human.ownerId ?? human.participantId;
    return { kind: 'human', participantId: human.participantId, ownerId, name, short: firstName(name),
      hue: participantHue({ kind: 'human', ownerId }), initials: initials(name), isViewer: false };
  });
  const ownerById = new Map<string, HumanMember>([[viewerOwnerId, viewerMember], ...humanMembers.map(human => [human.ownerId, human] as const)]);

  const baseNames = agents.map(agent => participantRosterName(currentNames?.get(agent.participantId) ?? agent.displayName, 'Agent'));
  const nameCounts = new Map<string, number>();
  for (const name of baseNames) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  const ordinals = new Map<ParticipantId, number>();
  const nextOrdinal = new Map<string, number>();
  for (const [index, agent] of [...agents.entries()].sort(([, left], [, right]) => left.participantId.localeCompare(right.participantId))) {
    const ordinal = (nextOrdinal.get(baseNames[index]!) ?? 0) + 1;
    nextOrdinal.set(baseNames[index]!, ordinal);
    ordinals.set(agent.participantId, ordinal);
  }

  const agentMembers = agents.map((agent, index): AgentMember => {
    const detail = describeParticipant?.(agent.participantId);
    const described = detail?.kind === 'agent' ? detail : null;
    const owner = agent.ownerId ? ownerById.get(agent.ownerId) : undefined;
    const ownerName = owner?.isViewer ? viewerMember.name
      : owner?.name ?? described?.ownerLabel ?? participantRosterName(agent.ownerDisplayName, 'Channel member');
    const ownerId = agent.ownerId ?? null;
    const name = baseNames[index]!;
    return {
      kind: 'agent', participantId: agent.participantId, ownerId, name,
      idBadge: (nameCounts.get(name) ?? 0) > 1 ? ordinals.get(agent.participantId) ?? null : null,
      hue: participantHue({ kind: 'agent', participantId: agent.participantId }),
      ownerHue: owner?.hue ?? participantHue({ kind: 'human', ownerId: ownerId ?? agent.participantId }),
      // The viewer's own badge reads `YO` everywhere (§3), as in the design's roster.
      ownerName, ownerInitials: owner?.isViewer ? viewerMember.initials : initials(ownerName), harness: described?.harness ?? null,
      isViewerOwned: Boolean(viewer.ownerId && agent.ownerId === viewer.ownerId), agent,
    };
  });

  const groups = groupRoster({
    viewer: { participantId: viewerMember.participantId, ownerId: viewerOwnerId, displayName: viewerMember.name },
    humans: humanMembers.map(human => ({ participantId: human.participantId, ownerId: human.ownerId, displayName: human.name })),
    agents: agentMembers.map(agent => ({ participantId: agent.participantId, displayName: agent.name, ownerLabel: agent.ownerName,
      ...(agent.ownerId ? { ownerId: agent.ownerId } : {}), ...(agent.harness ? { harness: agent.harness } : {}) })),
  });
  const byId = new Map<string, Member>([[viewerMember.participantId, viewerMember],
    ...humanMembers.map(human => [human.participantId, human] as const),
    ...agentMembers.map(agent => [agent.participantId, agent] as const)]);
  return { viewer: viewerMember, humans: humanMembers, agents: agentMembers, groups, byId };
}

/** The agents a human owns, in member order. */
export function agentsOwnedBy(members: ChannelMembers, ownerId: string): readonly AgentMember[] {
  return members.agents.filter(agent => agent.ownerId === ownerId);
}
