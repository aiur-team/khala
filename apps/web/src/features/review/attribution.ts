// Local copy of timeline's attribution pattern (KTD3: this feature imports no
// timeline internals — `scripts/check-boundaries.mjs` forbids the sibling
// feature import; see README.md "Why renderContent is an injected prop, not
// a timeline import" for the same constraint applied to content rendering).
// Attribution is derived only from the authenticated `ParticipantView` (kind,
// ownerId, displayName) and the viewer's own `ownerId` — never from message
// body text. On a review/release screen the reviewer must be able to tell
// their own agent apart from another person's (R1).

import type { OwnerId } from '@khala/contracts/messaging/ids';
import type { ParticipantView } from '@khala/contracts/messaging/index';

/**
 * "Your agent" vs "Another person's agent" for an agent participant; "You" vs
 * "Human" for a human participant — expressed relative to the viewer since
 * there is no roster port to resolve another owner's own display name.
 */
export function ownershipLabel(participant: Pick<ParticipantView, 'kind' | 'ownerId'>, viewerOwnerId: OwnerId): string {
  const isViewerOwned = participant.ownerId === viewerOwnerId;
  if (participant.kind === 'agent') return isViewerOwned ? 'Your agent' : "Another person's agent";
  return isViewerOwned ? 'You' : 'Human';
}

/**
 * Two different owners may authenticate with the same display name. Given
 * every participant currently on screen, returns a resolver that appends a
 * short, stable owner suffix only to names that collide across owners, so a
 * reader can tell same-named actors apart without changing message bytes.
 */
export function buildDisplayNameResolver(participants: readonly ParticipantView[]): (participant: ParticipantView) => string {
  const ownersByName = new Map<string, Set<OwnerId>>();
  for (const participant of participants) {
    const owners = ownersByName.get(participant.displayName) ?? new Set<OwnerId>();
    owners.add(participant.ownerId);
    ownersByName.set(participant.displayName, owners);
  }
  return participant => {
    const owners = ownersByName.get(participant.displayName);
    if (!owners || owners.size <= 1) return participant.displayName;
    return `${participant.displayName} (#${participant.ownerId.slice(-4)})`;
  };
}
