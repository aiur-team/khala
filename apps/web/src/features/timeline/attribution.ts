import type { Harness } from '@khala/contracts/m1/agent-join';
import type { Participant } from '@khala/contracts/m1/participants';
// Attribution uses the authenticated `ParticipantView` (kind,
// ownerId, displayName), the viewer's own `ownerId` and local send/echo state
// and server participant details, never message body text (KTD3). `ParticipantView.displayName` is
// already decoder-guaranteed nonempty with no control, bidi or invisible
// zero-width characters.

import type { OwnerId, ParticipantId } from '@khala/contracts/messaging/ids';
import type { ParticipantView } from '@khala/contracts/messaging/index';
import { buildIdBadgeResolver } from '../../ui/khala/identity';

export type Attribution = Readonly<{
  participantId: ParticipantId;
  displayName: string;
  kind: 'human' | 'agent';
  ownerId: OwnerId;
  /** True while this row is a locally pending echo, not yet an acknowledged event. */
  isLocalEcho: boolean;
  /** True when this participant is owned by the signed-in viewer. */
  isViewerOwned: boolean;
}>;

export function attributionFor(
  participant: ParticipantView,
  viewerOwnerId: OwnerId,
  options: Readonly<{ isLocalEcho?: boolean }> = {},
): Attribution {
  return {
    participantId: participant.participantId,
    displayName: participant.displayName,
    kind: participant.kind,
    ownerId: participant.ownerId,
    isLocalEcho: options.isLocalEcho ?? false,
    isViewerOwned: participant.ownerId === viewerOwnerId,
  };
}

/**
 * R1: the reader must be able to tell an agent apart from its owning human,
 * and tell their own actor apart from someone else's. Without a roster port
 * to resolve an owner's own display name, ownership is expressed relative to
 * the viewer instead of naming the other owner.
 */
export function ownershipLabel(attribution: Pick<Attribution, 'kind' | 'isViewerOwned'>): string {
  if (attribution.kind === 'agent') return attribution.isViewerOwned ? 'Your agent' : "Another person's agent";
  return attribution.isViewerOwned ? 'You' : 'Human';
}

/**
 * Two different owners may authenticate with the same display name. Given
 * every participant currently on screen, returns a resolver that appends a
 * short, stable owner suffix only to names that collide across owners, so a
 * reader can tell same-named actors apart without changing message bytes.
 */
export function buildDisplayNameResolver(participants: readonly ParticipantView[]): (participant: ParticipantView) => string {
  const badgeFor = buildIdBadgeResolver(participants);
  return participant => {
    const badge = badgeFor(participant);
    return badge ? `${participant.displayName} (${badge})` : participant.displayName;
  };
}

export const HARNESS_NAMES: Readonly<Record<Harness, string>> = { claude: 'Claude Code', codex: 'Codex' };

export function rowLabels(attribution: Attribution, detail: Participant | undefined): Readonly<{ author: string | null; kindLabel: string }> {
  if (detail?.kind === 'agent') return { author: detail.displayName, kindLabel: `${HARNESS_NAMES[detail.harness]} agent` };
  if (detail?.kind === 'unknown') return { author: 'Unknown', kindLabel: 'Unknown' };
  return { author: null, kindLabel: ownershipLabel(attribution) };
}
