// Resolves the channel's members into what the header, roster and detail
// pane draw: names (never routing IDs), hues, initials, harness and ownership.

import type { HarnessId } from '@khala/contracts/m1/harness';
import type { Participant } from '@khala/contracts/m1/participants';
import type { ParticipantId } from '@khala/contracts/messaging/ids';
import type { ResolvedHumanColor } from '../../ui/khala/human-colors';
import { buildIdBadgeResolver, humanInitials, initials, participantHue } from '../../ui/khala/identity';
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
  /** The colour the viewer sees this human in; `null` without `MemberInput.colorFor`. */
  color: ResolvedHumanColor | null;
  initials: string;
  isViewer: boolean;
  /** Verified sign-in email, visible to members of the same channel; `null` until control has recorded it. */
  email: string | null;
}>;

export type AgentMember = Readonly<{
  kind: 'agent';
  participantId: ParticipantId;
  ownerId: string | null;
  name: string;
  /** The `.kh-id` owner suffix (`#a1b2`) when the name collides across owners, else `null`. */
  idBadge: string | null;
  hue: number;
  ownerHue: number;
  /** The colour the viewer sees the owner in; `null` without `MemberInput.colorFor`. */
  ownerColor: ResolvedHumanColor | null;
  ownerName: string;
  ownerInitials: string;
  harness: HarnessId | null;
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
  viewer: Readonly<{
    participantId?: string; ownerId?: string; name?: string; email?: string;
    /** The viewer's chosen initials; without them the viewer reads `YO` (§3). */
    initials?: string | null;
  }>;
  humans: readonly Readonly<{ participantId: string; ownerId?: string; displayName: string }>[];
  agents: readonly ChannelAgentView[];
  currentNames?: ReadonlyMap<ParticipantId, string> | undefined;
  describeParticipant?: ((participantId: string) => Participant | undefined) | undefined;
  /** The channel's per-viewer human colours (`resolveHumanColors`); without it, hues hash as before. */
  colorFor?: ((ownerId: string) => ResolvedHumanColor) | undefined;
}>;

const firstName = (name: string) => name.trim().split(/\s+/u)[0] ?? name;

export function resolveMembers({ viewer, humans, agents, currentNames, describeParticipant, colorFor }: MemberInput): ChannelMembers {
  const emailOf = (participantId: string | undefined): string | null => {
    const detail = participantId === undefined ? undefined : describeParticipant?.(participantId);
    return detail?.kind === 'human' ? detail.email ?? null : null;
  };
  const chosenInitials = (participantId: string): string | null => {
    const detail = describeParticipant?.(participantId);
    return detail?.kind === 'human' ? detail.initials ?? null : null;
  };
  const viewerName = participantRosterName(viewer.name ?? '', 'You');
  const viewerOwnerId = viewer.ownerId ?? '';
  const viewerColor = colorFor?.(viewerOwnerId) ?? null;
  const viewerMember: HumanMember = {
    kind: 'human', participantId: viewer.participantId ?? 'viewer', ownerId: viewerOwnerId,
    name: viewerName || 'You', short: 'You', hue: viewerColor?.hue ?? participantHue({ kind: 'human', ownerId: viewerOwnerId, isViewer: true }), color: viewerColor,
    initials: viewer.initials ?? 'YO', isViewer: true, email: viewer.email ?? emailOf(viewer.participantId),
  };
  const humanMembers = humans.map((human): HumanMember => {
    const name = participantRosterName(human.displayName, 'Channel member');
    const ownerId = human.ownerId ?? human.participantId;
    const color = colorFor?.(ownerId) ?? null;
    return { kind: 'human', participantId: human.participantId, ownerId, name, short: firstName(name),
      hue: color?.hue ?? participantHue({ kind: 'human', ownerId }), color, initials: humanInitials(name, chosenInitials(human.participantId)),
      isViewer: false, email: emailOf(human.participantId) };
  });
  // The name the thread resolves for an agent, so both apply the badge rule to the same string.
  const threadName = (agent: ChannelAgentView) => {
    const detail = describeParticipant?.(agent.participantId);
    return detail?.kind === 'agent' ? detail.displayName : currentNames?.get(agent.participantId) ?? agent.displayName;
  };
  const ownerById = new Map<string, HumanMember>([[viewerOwnerId, viewerMember], ...humanMembers.map(human => [human.ownerId, human] as const)]);

  // The thread's name too: an agent's Matrix display name (renamed globally) outranks old in-channel rename events.
  const baseNames = agents.map(agent => participantRosterName(threadName(agent), 'Agent'));
  // The thread's `.kh-id` rule: only names that collide across owners get the owner suffix.
  const badgeFor = buildIdBadgeResolver([
    { ownerId: viewerOwnerId, displayName: viewer.name ?? '' },
    ...humans.map(human => ({ ownerId: human.ownerId ?? human.participantId, displayName: human.displayName })),
    ...agents.map(agent => ({ ownerId: agent.ownerId ?? agent.participantId, displayName: threadName(agent) })),
  ]);

  const agentMembers = agents.map((agent, index): AgentMember => {
    const detail = describeParticipant?.(agent.participantId);
    const described = detail?.kind === 'agent' ? detail : null;
    const owner = agent.ownerId ? ownerById.get(agent.ownerId) : undefined;
    const ownerName = owner?.isViewer ? viewerMember.name
      : owner?.name ?? described?.ownerLabel ?? participantRosterName(agent.ownerDisplayName, 'Channel member');
    const ownerId = agent.ownerId ?? null;
    const name = baseNames[index]!;
    const ownerColor = colorFor?.(ownerId ?? agent.participantId) ?? null;
    // An agent wears its owner's colour (operator request 2026-10-04): name, avatar and bubble all match the owner.
    const ownerHue = ownerColor?.hue ?? owner?.hue ?? participantHue({ kind: 'human', ownerId: ownerId ?? agent.participantId });
    return {
      kind: 'agent', participantId: agent.participantId, ownerId, name,
      idBadge: badgeFor({ ownerId: ownerId ?? agent.participantId, displayName: threadName(agent) }) ?? null,
      hue: ownerHue, ownerHue, ownerColor,
      // The viewer's own badge reads `YO` everywhere (§3), as in the design's roster, until they choose initials.
      // Another owner's member initials already carry their choice.
      ownerName, ownerInitials: owner?.isViewer ? viewerMember.initials : described?.ownerInitials ?? owner?.initials ?? initials(ownerName), harness: described?.harness ?? null,
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
