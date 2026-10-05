// Who has to pick a name for this channel. Usernames and agent names are not
// unique across Khala; within one channel they are. When the viewer, or one of
// the viewer's agents, shares a name with someone who held it first, the viewer
// picks a name for this channel only. An agent cannot answer a prompt, so it
// joins with a numbered name and its owner sees that name here once, to keep or
// change. Identity stays on participant ids; this only decides what to ask.

import { channelNameSuggestion, isSuffixedAgentName, nameCollisions } from '@khala/contracts/m1/channel-names';

export type ChannelNameMember = Readonly<{
  participantId: string;
  kind: 'human' | 'agent';
  /** The member's effective name in this channel. */
  name: string;
  ownerId: string | null;
  /** When the member took this name (its latest membership event), if known. */
  since?: number | null;
}>;

export type ChannelNamePrompt = Readonly<{
  participantId: string;
  kind: 'human' | 'agent';
  /** The name the member has here now. */
  name: string;
  /** The name someone else here already holds. */
  held: string;
  /** What the field starts with: the lowest free numbered name, or the agent's numbered name to keep. */
  suggestion: string;
  /** `collision`: the member shares `held` with someone. `numbered`: an agent joined numbered because `held` was taken. */
  reason: 'collision' | 'numbered';
  /** Names other members hold here, which the new name must avoid. */
  taken: readonly string[];
}>;

/** The prompts the viewer must answer in this channel: their own first, then their agents' in member order. */
export function channelNamePrompts({ members, viewerParticipantId, viewerOwnerId, acknowledged = () => false }: Readonly<{
  members: readonly ChannelNameMember[];
  viewerParticipantId: string;
  viewerOwnerId: string;
  /** Whether the owner already saw (and kept or changed) an agent's numbered name. */
  acknowledged?: (participantId: string, name: string) => boolean;
}>): readonly ChannelNamePrompt[] {
  const collisions = nameCollisions(members.map(member => ({ id: member.participantId, name: member.name, since: member.since ?? null })));
  const others = (participantId: string) => members.filter(member => member.participantId !== participantId).map(member => member.name);
  const prompts: ChannelNamePrompt[] = [];
  for (const member of members) {
    const mine = member.participantId === viewerParticipantId && member.kind === 'human';
    const myAgent = member.kind === 'agent' && viewerOwnerId !== '' && member.ownerId === viewerOwnerId;
    if (!mine && !myAgent) continue;
    const taken = others(member.participantId);
    const kind = member.kind === 'human' ? 'username' : 'agent';
    if (collisions.has(member.participantId)) {
      prompts.push({ participantId: member.participantId, kind: member.kind, name: member.name, held: member.name,
        suggestion: channelNameSuggestion(member.name, kind, taken), reason: 'collision', taken });
    } else if (myAgent && isSuffixedAgentName(member.name, taken) && !acknowledged(member.participantId, member.name)) {
      prompts.push({ participantId: member.participantId, kind: 'agent', name: member.name, held: member.name.replace(/-\d+$/u, ''),
        suggestion: member.name, reason: 'numbered', taken });
    }
  }
  return prompts.sort((a, b) => (a.kind === 'human' ? 0 : 1) - (b.kind === 'human' ? 0 : 1));
}

const ACK_KEY = 'khala.channel-name-ack.v1';
type AckStorage = Pick<Storage, 'getItem' | 'setItem'>;
const ackId = (ownerId: string, roomId: string, participantId: string) => JSON.stringify([ownerId, roomId, participantId]);
function storage(): AckStorage | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}
function readAcks(store: AckStorage | null): Record<string, string> {
  try {
    const value = JSON.parse(store?.getItem(ACK_KEY) ?? '{}') as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, string> : {};
  } catch { return {}; }
}

/**
 * Per-viewer memory of the numbered agent names an owner has already seen here.
 * It is a convenience: without storage the owner sees the prompt again, nothing breaks.
 */
export function nameAcknowledgements(ownerId: string, roomId: string, store: AckStorage | null = storage()) {
  return {
    has: (participantId: string, name: string) => readAcks(store)[ackId(ownerId, roomId, participantId)] === name,
    add(participantId: string, name: string): void {
      try {
        const acks = readAcks(store);
        acks[ackId(ownerId, roomId, participantId)] = name;
        // Bounded: keep the most recent entries only.
        const entries = Object.entries(acks).slice(-200);
        store?.setItem(ACK_KEY, JSON.stringify(Object.fromEntries(entries)));
      } catch { /* Storage is optional. */ }
    },
  };
}
