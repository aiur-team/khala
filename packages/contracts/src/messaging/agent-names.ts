/** Names are presentation only. Identity, owner, approval and permissions stay on participant IDs. */
import type { OwnerId, ParticipantId } from './ids';
export const MAX_AGENT_NAME_BYTES = 80;

export type AgentNameError = 'blank' | 'too_long' | 'invalid_characters' | 'reserved';
export type AgentNameResult = Readonly<{ ok: true; name: string }> | Readonly<{ ok: false; error: AgentNameError }>;

const unsafe = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/u;
export const reserved = /\b(?:admin(?:istrator)?|system|khala|moderator|owner|human|security|support|official)\b/iu;

/** Normalise once before encryption so every reader sees the exact same label. */
export function validateAgentName(input: unknown): AgentNameResult {
  if (typeof input !== 'string') return { ok: false, error: 'blank' };
  const name = input.trim().normalize('NFC');
  if (!name) return { ok: false, error: 'blank' };
  if (unsafe.test(name)) return { ok: false, error: 'invalid_characters' };
  if (new TextEncoder().encode(name).byteLength > MAX_AGENT_NAME_BYTES) return { ok: false, error: 'too_long' };
  if (reserved.test(name.normalize('NFKC'))) return { ok: false, error: 'reserved' };
  return { ok: true, name };
}

export type NameTimelineEvent =
  | Readonly<{ kind: 'message'; eventId: string; authorParticipantId: ParticipantId }>
  | Readonly<{ kind: 'agent_rename'; eventId: string; actorParticipantId: ParticipantId; targetParticipantId: ParticipantId; name: string }>
  | Readonly<{ kind: 'agent_name_snapshot'; eventId: string; actorParticipantId: ParticipantId; targetParticipantId: ParticipantId; name: string; sourceEventId: string | null }>;

export type ProjectedNameEvent =
  | Readonly<{ kind: 'message'; eventId: string; authorParticipantId: ParticipantId; authorName: string }>
  | Readonly<{ kind: 'agent_rename'; eventId: string; actorParticipantId: ParticipantId; actorName: string;
      targetParticipantId: ParticipantId; previousName: string; name: string }>;

export type NameParticipant = Readonly<{
  participantId: ParticipantId;
  ownerId: OwnerId;
  kind: 'human' | 'agent';
  initialName: string;
}>;

/** Replays the permitted channel history in transport order with authenticated owner bindings. */
export function projectNamesInOrder(participants: readonly NameParticipant[], events: readonly NameTimelineEvent[]):
  Readonly<{ events: readonly ProjectedNameEvent[]; currentNames: ReadonlyMap<ParticipantId, string>; latestRename: ReadonlyMap<ParticipantId, string | null> }> {
  const identity = new Map(participants.map(participant => [participant.participantId, participant]));
  const currentNames = new Map(participants.map(participant => [participant.participantId, participant.initialName]));
  const latestRename = new Map<ParticipantId, string | null>();
  const visibleRenames = new Set(events.filter(event => event.kind === 'agent_rename').map(event => event.eventId));
  // A snapshot referencing a rename outside this viewer's history is the baseline
  // at their history boundary. A readable rename must be replayed in its own place.
  for (const event of events) {
    if (event.kind !== 'agent_name_snapshot' || event.sourceEventId === null || visibleRenames.has(event.sourceEventId)) continue;
    const actor = identity.get(event.actorParticipantId);
    const target = identity.get(event.targetParticipantId);
    const checked = validateAgentName(event.name);
    if (actor?.kind === 'human' && target?.kind === 'agent' && actor.ownerId === target.ownerId && checked.ok
      && !latestRename.has(target.participantId)) {
      currentNames.set(target.participantId, checked.name);
      latestRename.set(target.participantId, event.sourceEventId);
    }
  }
  const seen = new Set<string>();
  const projected: ProjectedNameEvent[] = [];
  for (const event of events) {
    if (seen.has(event.eventId)) continue;
    seen.add(event.eventId);
    if (event.kind === 'message') {
      const author = identity.get(event.authorParticipantId);
      if (author) projected.push({ kind: 'message', eventId: event.eventId,
        authorParticipantId: event.authorParticipantId,
        authorName: currentNames.get(event.authorParticipantId) ?? author.initialName });
      continue;
    }
    const actor = identity.get(event.actorParticipantId);
    const target = identity.get(event.targetParticipantId);
    const checked = validateAgentName(event.name);
    if (!actor || !target || actor.kind !== 'human' || target.kind !== 'agent'
      || actor.ownerId !== target.ownerId || !checked.ok) continue;
    if (event.kind === 'agent_name_snapshot') {
      if (!latestRename.has(target.participantId)
        || latestRename.get(target.participantId) === event.sourceEventId && currentNames.get(target.participantId) === checked.name) {
        currentNames.set(target.participantId, checked.name);
        latestRename.set(target.participantId, event.sourceEventId);
      }
      continue;
    }
    latestRename.set(target.participantId, event.eventId);
    const previousName = currentNames.get(target.participantId) ?? target.initialName;
    if (previousName === checked.name) continue;
    projected.push({ kind: 'agent_rename', eventId: event.eventId,
      actorParticipantId: actor.participantId, actorName: currentNames.get(actor.participantId) ?? actor.initialName,
      targetParticipantId: target.participantId, previousName, name: checked.name });
    currentNames.set(target.participantId, checked.name);
  }
  return { events: projected, currentNames, latestRename };
}

