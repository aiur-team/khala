// Attribution is derived only from the authenticated `ParticipantView` (kind,
// ownerId, displayName) and local send/echo state — never from message body
// text (KTD3). `ParticipantView.displayName` is already decoder-guaranteed
// nonempty with no control, bidi or invisible zero-width characters.

import type { OwnerId, ParticipantId } from '@khala/contracts/messaging/ids';
import type { ParticipantView } from '@khala/contracts/messaging/index';

export type Attribution = Readonly<{
  participantId: ParticipantId;
  displayName: string;
  kind: 'human' | 'agent';
  ownerId: OwnerId;
  /** True while this row is a locally pending echo, not yet an acknowledged event. */
  isLocalEcho: boolean;
}>;

export function attributionFor(participant: ParticipantView, options: Readonly<{ isLocalEcho?: boolean }> = {}): Attribution {
  return {
    participantId: participant.participantId,
    displayName: participant.displayName,
    kind: participant.kind,
    ownerId: participant.ownerId,
    isLocalEcho: options.isLocalEcho ?? false,
  };
}

export const ATTRIBUTION_KIND_LABEL: Readonly<Record<Attribution['kind'], string>> = {
  human: 'Human',
  agent: 'Agent',
};
